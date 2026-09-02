# Task 3 报告：store 扩展 + 编排器

## 实现要点

### 1. `lib/store.ts` 扩展
在 `TimelineClipState` 接口前追加了 Agent 相关类型（按简报指定位置）：
- `AgentStage`：9 个阶段（idle / outline / style / assets / storyboard / shots / assembly / done / aborted）
- `AgentAsset`：资产（角色/场景/道具）+ 生成状态
- `AgentShot`：分镜 + 生成状态
- `AgentState`：完整编排状态

`CanvasStore` 接口增加：
- `agentState: AgentState | null` 字段
- `setAgentState(patch: Partial<AgentState>)` action（合并式更新，agentState 为 null 时忽略 patch）

`create()` 中初始化 `agentState: null`，实现与骨架一致。

### 2. `lib/agent-orchestrator.ts`（新建）
六阶段流转：
1. **outline**：`runAgent` 调用 `plan("outline", theme)`，产出大纲文本节点 + 结构化 JSON，停在 `style` 等用户选风格。
2. **style**：用户面板调用 `chooseStyle(styleName, stylePrompt)` 触发后续阶段。
3. **assets**：基于结构化大纲调 `plan("assets", …)`，逐个生成角色/场景/道具立绘（image 节点），串联到大纲节点，失败重试一次后标记 failed。
4. **storyboard**：调 `plan("storyboard", …)` 产出分镜脚本。
5. **shots**：逐镜生成视频节点，设置 `referenceOrder`（角色在前、场景最后）与 `refNames`（场景标「场景」），失败重试一次后标记 skipped 不阻塞后续。
6. **assembly**：把成功的镜按顺序追加到时间线，阶段置 `done`。

导出函数签名与简报完全一致：`runAgent(theme, shotCount, aspectRatio)` / `chooseStyle(styleName, stylePrompt)` / `abortAgent()`。

### 3. 错误处理
- 单资产/单镜失败：自动重试一次（`generateAndAwait`），仍失败则资产标 `failed`、分镜标 `skipped`，不阻塞后续。
- 阶段级异常（如 plan 调用失败）：写入 `agentState.error`，阶段回退到 `style`（chooseStyle 内）或 `idle`（runAgent 内）。
- abort：模块级 `aborted` 标志，在每个 await 边界检查，立即返回并把阶段置 `aborted`。

## 与骨架的差异及原因

| 差异点 | 骨架 | 实际实现 | 原因 |
|---|---|---|---|
| `outlineJson` 缓存 | `chooseStyle` 里重新 `plan("outline", s0.theme)` 取结构化 JSON | `runAgent` 把大纲 JSON 存进 `agentState.outlineJson`，`chooseStyle` 直接复用 | 简报明确授权：**避免重复 LLM 调用**。如果 `outlineJson` 为空抛错提示用户重新生成，比静默重取更安全。 |
| `AgentState.outlineJson` 字段 | 无 | 新增可选字段 | 支撑上述优化，类型与 `Outline` 一致，加 `?` 不破坏骨架其他假设。 |
| 分镜失败标记 | `skipped` | `skipped`（与骨架一致） | 保持一致。 |
| `patchErr` 命名位置 | 骨架在 `generateAndAwait` 之后定义 | 实现放 `generateAndAwait` 之后，用 `const` | 行为等价，仅代码组织不同。 |
| `agentNodeId` 命名 | 骨架 `nodeSeq` 全局递增 | 一致 | 骨架行为保留。 |
| `CanvasNodeData.seconds / aspectRatio` | 骨架直接用 | 实际 `lib/store.ts` 的 `CanvasNodeData` 继承自 `Record<string, unknown>` 且在 `types/agnes.ts` 中定义了这两个字段 | TS 编译通过，无需额外处理。 |

## 验证输出

- `npx tsc --noEmit`：**零错误**（无任何输出）
- `npm run build`：**成功**（所有 route 正常构建，`/api/agent/plan` 动态路由可用）
- 无 Google 字体网络问题，无需跳过

## 自查清单（逻辑冒烟）

### 每个阶段对 store 的调用序列

**outline 阶段（runAgent）**
1. `setAgentState({ stage: "outline", theme, shotCount, aspectRatio, assets: [], shots: [], error: null, outlineNodeId: null, outlineJson: null })` → 初始化状态
2. `plan("outline", theme)` → LLM 调用（不经过 store）
3. `addNode({ id, type: "text", position, data })` → 加大纲文本节点
4. `setAgentState({ outlineNodeId, outlineJson, stage: "style" })` → 停在 style 阶段

**assets 阶段（chooseStyle 内）**
1. `setAgentState({ styleName, stylePrompt, stage: "assets" })`
2. `plan("assets", JSON.stringify(outlineJson))` → LLM 调用
3. `setAgentState({ assets: assetList })` → 初始化资产列表
4. 对每个资产：
   - `addNode({ id, type: "image", ... })` → 加 image 节点
   - `onConnect({ source: outlineNodeId, target: nodeId, ... })` → 连大纲→资产
   - `setAgentState({ assets: […status: "running"…] })`
   - `triggerGeneration(nodeId)` → 触发生成
   - 轮询 `nodes.find(...)` 等待 `status === "done" / "failed"`
   - `updateNodeData(nodeId, { error, status: "queued" })` → 重试前清理（若需）
   - `setAgentState({ assets: […status: "done"|"failed"…] })`

**storyboard 阶段**
1. `setAgentState({ stage: "storyboard" })`
2. `plan("storyboard", …)` → LLM 调用
3. `setAgentState({ shots, stage: "shots" })` → 初始化分镜列表

**shots 阶段**
1. 对每个分镜：
   - `addNode({ id, type: "video", data: { referenceOrder, refNames, dialogue, seconds, aspectRatio, … } })` → 加 video 节点（**referenceOrder/refNames 设置点**）
   - 对每个参考图：`onConnect({ source: refId, target: nodeId })` → 连参考图→视频
   - `setAgentState({ shots: […status: "running"…] })`
   - `triggerGeneration(nodeId)` → 触发生成
   - 轮询等待
   - `setAgentState({ shots: […status: "done"|"skipped"…] })`

**assembly 阶段**
1. `setAgentState({ stage: "assembly" })`
2. `setTimeline([...timeline, ...clips])` → 追加时间线片段
3. `setAgentState({ stage: "done" })`

### abort 检查点位置
共 9 处 abort 检查（每个异步边界之后）：
1. `runAgent`：`plan("outline")` 之后
2. `chooseStyle`：`plan("assets")` 之后
3. 资产循环体：每个 `generateAndAwait` 之前
4. `runStoryboardAndShots` 入口
5. 分镜循环体：每个 `generateAndAwait` 之前
6. `waitForNode` 内部轮询：每次 sleep 之后
7. `generateAndAwait` 失败重试判断：`!ok && !aborted`
8. `generateAndAwait` 重试后 `waitForNode` 内部（同上 #6）
9. assembly 阶段入口

`abortAgent()` 同时设置模块级 `aborted = true` 和 `agentState.stage = "aborted"`，UI 与内部状态同步。

### referenceOrder / refNames 设置点
**唯一设置点**：`runStoryboardAndShots` 内每个分镜的 `addAgentNode("video", ...)` 调用处。
- 顺序规则：出场角色立绘按 `shot.characters` 顺序在前，场景图在最后。
- refNames 规则：角色节点 id → 角色名；场景节点 id → `"场景"`（与 `lib/dialogue.ts` 的 `speakerMap` 中场景识别逻辑匹配：`name.includes("场景")` 时标注「仅作场景背景参考」）。
- 生成时 `triggerGeneration` 读取 `data.referenceOrder` 对 `imageRefs` 排序，再用 `data.refNames` 构造 `speakerMap`，整条链路贯通。

## 涉及文件

- 修改：`/home/cuitcc/project/Infinite-Canvas/lib/store.ts`
- 新建：`/home/cuitcc/project/Infinite-Canvas/lib/agent-orchestrator.ts`
