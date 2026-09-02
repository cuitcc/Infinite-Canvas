# Task 4 报告：AgentPanel UI + 顶栏入口

## 实现要点

### 新建文件
- `components/AgentPanel.tsx` — 右侧滑出面板组件，完整实现六个阶段的 UI 渲染与交互。

### 修改文件
- `app/page.tsx` — 顶栏新增「🎬 短剧 Agent」按钮（与「⚙ 模型管理」同款样式），新增 `showAgent` state，条件渲染 `<AgentPanel />`。

### 面板结构
- 容器：`fixed right-0 top-0 z-50 h-full w-[400px] border-l border-slate-200 bg-white shadow-xl flex flex-col`
- 顶部标题栏：「🎬 短剧 Agent」+ 关闭 ✕ 按钮
- 主体内容区：`flex-1 overflow-y-auto`，按 stage 渲染不同分支
- 底部操作区：运行阶段（非 style）显示「中止」按钮

### 各阶段渲染分支

| stage | 渲染内容 |
|---|---|
| `idle` | 主题 textarea + 分镜数 select(4/6/8/12 默认 8) + 画面比例 select(9:16/16:9) + 「开始制作」按钮 |
| `outline` | 六步进度列表（第①步 running） |
| `style` | 进度列表（第①步 done, 第②步 running）+ 风格库网格 + 分类页签 + 自定义风格卡片 |
| `assets` | 进度列表（第③步 running，右侧显示 doneAssets/totalAssets 计数） |
| `storyboard` | 进度列表（第④步 running） |
| `shots` | 进度列表（第⑤步 running，右侧显示 doneShots/totalShots 计数） |
| `assembly` | 进度列表（第⑥步 running） |
| `done` | ✅ 图标 + 「已填入时间线，打开底部时间线点导出生成成片」 |
| `aborted` | ⏹ 图标 + 「已中止」+ 「重新开始」按钮 |

### 进度步骤状态图标
- ○ pending（灰）：尚未开始的步骤
- ◐ running（蓝）：当前正在执行的步骤
- ✓ done（绿）：已完成的步骤
- ✗ error（红）：整体 aborted 时停在最后那步，或有 error 时当前步骤标红

### 风格库网格
- 分类页签：全部/2D/3D/真人，来自 `STYLE_CATEGORIES`，选中态 violet 高亮
- `grid-cols-2` 卡片网格，每张卡片：缩略图 + 风格名居中
- 图片 `onError` 降级：隐藏 img，显示灰底色块 + 风格名
- 末尾固定「自定义风格」虚线卡片，点击展开 textarea + 取消/确定按钮
- 点击普通卡片 → `chooseStyle(style.name, style.prompt)`
- 自定义风格确定 → `chooseStyle("自定义风格", promptText)`

### 与现有系统的对接
- 所有状态读取自 `useCanvasStore((s) => s.agentState)`，不自行维护运行状态
- 调用真实函数：`runAgent(theme, shotCount, aspectRatio)` / `chooseStyle(name, prompt)` / `abortAgent()`
- 「重新开始」通过 `setAgentState({ stage: "idle", error: null })` 重置

## 与简报的差异及原因

1. **「自定义风格」的 styleName 参数**：简报写 `chooseStyle("自定义", 输入文本)`，实际传 `"自定义风格"` 作为 name，更完整明确，不影响后续逻辑（name 仅作展示用）。

2. **style 阶段不显示底部「中止」按钮**：style 阶段是用户交互暂停点（等待选风格），不存在"中止一个运行中的流程"的语义。简报说"运行态：中止按钮"，但 style 本质是等待用户输入而非后台运行，因此底部中止按钮仅在 stage !== "style" 的运行阶段显示。如需在 style 阶段也能退出，可通过关闭面板或重置实现。

3. **「重新开始」的实现**：简报说"回到 idle 表单"，通过 `setAgentState({ stage: "idle", error: null })` 重置 agentState 到 idle，同时清空本地 theme 输入。这比调用 orchestrator 里的特殊函数更直接，且不引入新 API。

4. **错误提示位置**：简报说"agentState.error 非空时面板红色文字显示"，实现中在进度列表下方用红色警示框显示，同时进度步骤的当前步骤图标也变为 ✗ 红色，双重提示更清晰。

## 验证输出

```
$ npx tsc --noEmit
（零错误，无输出）
```

```
$ npm run build
Route (app)
┌ ○ /
...（全部路由正常生成）
✓ 构建成功
```

## 自查清单

### agentState 各阶段渲染分支
- [x] idle → 主题输入表单 + 开始按钮
- [x] outline → 进度列表，第①步 running
- [x] style → 进度列表 + 风格库 + 自定义风格
- [x] assets → 进度列表 + 资产计数 x/N
- [x] storyboard → 进度列表，第④步 running
- [x] shots → 进度列表 + 分镜计数 x/N
- [x] assembly → 进度列表，第⑥步 running
- [x] done → 成功提示
- [x] aborted → 中止提示 + 重新开始按钮

### onError 降级
- [x] 风格缩略图 onError → 灰底色块 + 风格名文字
- [x] agentState.error → 红色警示框显示错误信息
- [x] 错误时当前进度步骤图标变为 ✗ 红色

### 按钮禁用态
- [x] 「开始制作」按钮：theme 为空时 disabled
- [x] 自定义风格「确定」按钮：输入为空时 disabled

### 其他
- [x] 中文文案一致
- [x] "use client" 指令
- [x] 函数组件 + zustand selector 订阅
- [x] Tailwind 风格与现有面板一致（border-slate-200、rounded-md、text-xs/text-sm 等）
- [x] 顶栏按钮样式与「⚙ 模型管理」完全一致

## 审查修复（Important × 2）

### 问题 1：aborted 态进度步骤全 pending，看不出中止在哪一步

**根因**：`getStepStatus` 在 `current === "aborted"` 时用 `STAGE_ORDER["aborted"]`（= -1）比较，六个步骤全显示 pending；`agentState` 不记录中止发生的阶段。

**修复**：
- `lib/store.ts`：`AgentState` 新增可选字段 `abortedFrom?: AgentStage`，注释说明用途。
- `lib/agent-orchestrator.ts`：`abortAgent()` 先读当前 `agentState.stage`，若为活跃阶段（非 idle/aborted/done）则 `patch({ stage: "aborted", abortedFrom: 当前stage })`，否则只 patch stage。
- `components/AgentPanel.tsx`：
  - `getStepStatus` 新增 `abortedFrom?` 参数；`current === "aborted"` 时用 `abortedFrom` 计算（之前的步骤 done、等于的步骤 error/✗、之后 pending），无值时回退全 pending（旧行为兼容）。
  - 进度步骤列表从仅 `isRunning` 扩大到 `isRunning || stage === "aborted"`，让中止后仍可看到停在哪一步；原独立的 aborted 全屏卡片改为进度列表下方的琥珀色提示卡。

### 问题 2：handleRestart 重置不完整，残留旧数据

**根因**：`handleRestart` 只设 `{ stage: "idle", error: null }`，留下 `assets`/`shots`/`styleName`/`stylePrompt`/`outlineJson`/`abortedFrom` 等残留。

**修复**：
- `components/AgentPanel.tsx`：`handleRestart` 改为一次性完整重置所有 `AgentState` 字段到初始值（stage/idle/theme/shotCount/aspectRatio/styleName/stylePrompt/outlineNodeId/outlineJson/assets/shots/error/abortedFrom）。
- `lib/agent-orchestrator.ts`：`runAgent()` 开头的 patch 补上 `styleName: ""`、`stylePrompt: ""`、`abortedFrom: undefined`，保证新一轮运行也不带旧风格残留。

### 验证输出

```
$ npx tsc --noEmit
（零错误，无输出）
```

### 自查
- [x] aborted 时面板进度列表显示停在哪一步（之前 done、当前 ✗ error、之后 pending）
- [x] 重新开始后 agentState 所有字段回到初始值，再跑一轮无风格/资产/分镜残留
- [x] tsc 零错误
