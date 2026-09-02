# 短剧制作 Agent 设计

日期：2026-09-02
状态：已确认（用户已批准设计方向与全部关键决策）

## 背景与目标

Infinite-Canvas 增加短剧制作 Agent（参考 liblib.tv 的 LibTV Agent 模式）：用户在 Agent 对话框输入主题或剧本，Agent 自动完成剧本大纲、风格选择、角色/场景/道具资产生成、分镜脚本与台词分配、分镜视频生成、自动剪辑填入时间线。**Agent 的每一步都必须在画布中以真实节点呈现，形成流水线**；最终用户点现有导出功能出成片。

## 用户决策记录

| 决策点 | 结论 |
|---|---|
| 人工确认点 | 仅风格选择一处（风格库面板）；资产、分镜、台词等其余环节全自动 |
| 分镜规模 | 默认 8 镜 × 10 秒，面板可选 4/6/8/12 |
| Agent 入口 | 顶栏「🎬 短剧 Agent」按钮 + 右侧滑出对话面板 |
| 成片产出 | Agent 按剧本顺序自动填入现有时间线（含音轨），复用现有导出混音链路 |
| 风格选择 UI | 风格库面板：分类页签（全部/2D/3D/真人）+ 风格卡片网格（缩略图+名称）+ 自定义风格输入，参照用户提供的截图 |

## 整体架构

**前端编排**。Agent 编排器运行在浏览器端（新增 `lib/agent-orchestrator.ts`，集成进 zustand store），原因：

1. 画布节点、连线、时间线全在前端 store，Agent 创建节点即画布实时生长；
2. 现有节点生成（`triggerGeneration`）本就是前端发起，编排器直接复用同一套 API；
3. 服务端 Next API 路由无状态，无后台 worker，不适合做长任务编排。

权衡：运行期间页面不能关闭（8 镜视频串行需 8 分钟以上，可接受）；刷新后编排状态丢失，但已生成的节点与资产全部保留在画布/数据库中。

**规划 LLM**：Agnes chat。新增 `app/api/agent/plan/route.ts`，按任务类型（outline / assets / storyboard）使用不同 system 提示词，要求模型输出结构化 JSON，前端解析。JSON 解析失败自动重试一次。

**生成链路**：完全复用现有 `/api/generate/image`、`/api/generate/video`（含 429 限流 65s 重试、台词注入、参考图一致性后缀）。

## 流水线状态机

```
idle → outline → style(⏸唯一暂停点) → assets → storyboard → shots → assembly → done
                                                                                  ↘ aborted(任意阶段可中止)
```

| 阶段 | 行为 | 画布产出 |
|---|---|---|
| outline | plan API 生成剧本大纲 JSON：标题、类型、剧情梗概、角色表（姓名+设定）、场景表、分场对白 | 1 个 text 节点（大纲全文），label「剧本大纲」 |
| style | 面板弹出风格库，用户选定后得 stylePrompt | 无节点（面板操作） |
| assets | plan API 拆解资产：每个角色出立绘提示词、每个场景出场景图提示词、道具若干；逐个文生图（串行，失败自动重试一次） | 每个 asset 一个 image 节点，label「角色-女一」「场景-庭院」「道具-玉佩」，prompt=stylePrompt+资产描述，连大纲节点 |
| storyboard | plan API 生成 8 镜分镜 JSON：每镜画面描述（含运镜）、出场角色、场景、该镜台词 | 分镜脚本写入面板（不建 text 节点，避免画布冗余） |
| shots | 每镜创建 video 节点：自动连线该镜出场**角色的 image 节点**（按 characters 顺序）+ **场景 image 节点**（最后一张）；节点 data 设 `referenceOrder`（角色在前、场景最后）与 `refNames`（节点id→角色名，场景标「场景」）；台词注入走 `buildDialogueInjection` 的 speakerMap 精确绑定——M 句台词 ≤ N 张参考图，谁说哪句按名字绑定，不出场的角色与场景图明确标注「不说台词，保持倾听/仅作背景参考」；prompt=stylePrompt+分镜描述（含运镜）；台词写入节点 dialogue 字段；**串行**生成（上一镜完成才创建下一镜任务，天然避开 1/min 限流）；单镜失败自动重试一次，仍失败标记 error 并跳过继续 | 每镜一个 video 节点，label「第1镜」…「第8镜」 |
| assembly | 按剧本顺序把完成分镜的 mediaId 写入 timeline（trimIn=0），提示用户点导出 | timeline 填充 |

## 画布布局

- 大纲 text 节点在左侧（x0, y0）；
- 资产 image 节点纵向排列在第二列（x0+400）；
- 分镜 video 节点纵向排列在第三列（x0+800，间距 300）；
- 连线：大纲→各资产（上下文）、出场角色资产→分镜、场景资产→分镜。

## UI：AgentPanel

右侧滑出面板（顶栏「🎬 短剧 Agent」按钮开关），内容：

1. **主题输入**：textarea + 开始按钮（流水线运行中隐藏）；
2. **分镜数选择**：4/6/8/12，默认 8；
3. **进度步骤列表**：每阶段一行（图标+名称+状态 pending/running/done/error+产出计数，如「分镜视频 3/8」）；
4. **风格库弹层**（style 阶段自动弹出）：分类页签全部/2D/3D/真人、风格卡片网格（预生成缩略图+风格名）、自定义风格输入框；选定后流水线继续；
5. **中止按钮**：停在当前阶段，已生成节点保留；
6. **完成态**：提示「已填入时间线，点导出生成成片」。

## 风格库

`lib/style-library.ts` 预置约 15 个风格：`{ id, name, category: "2d"|"3d"|"real", prompt, thumb }`。prompt 为注入用的完整风格描述（如「90年代日式动画风格：赛璐璐上色、复古胶片颗粒、柔和光影」）。缩略图为静态图片，开发期用 Agnes 按各风格提示词预生成一次，存 `public/styles/<id>.png` 随仓库发布。自定义风格：用户输入文本即 prompt，缩略图用灰色占位卡（同截图的「自定义风格」）。

## 数据模型

- store 新增 `agentState`（内存，不持久化）：`{ stage, theme, shotCount, outline, style, assets: [{id,kind,name,prompt,nodeId,status}], shots: [{index,description,dialogue,characters,scene,nodeId,status}], logs: [], error }`；
- 画布节点复用现有 text/image/video 类型与 `CanvasNodeData`，不新增节点类型；
- 生成记录走现有 gen_tasks，无新表。

## 错误处理

- plan JSON 解析失败：重试一次，仍失败 → 该阶段标记 error，面板提供「重试本阶段」；
- 资产生成失败：自动重试一次，仍失败标记该资产 error，**继续后续资产**；
- 分镜视频失败：429 由现有 65s 重试兜底，其余错误自动重试一次，仍失败标记该镜 error、跳过继续其余镜；assembly 只装入成功的镜；
- 任意时刻可中止（aborted），节点与资产保留。

## 明确不做（Out of Scope）

- 多集管理（LibTV 截图中的「10集」选择器，v1 单集）；
- 服务端视频拼接成片（容器无 ffmpeg，导出走现有前端导出链路）；
- 编排状态持久化/断点续跑；
- 3D 虚拟场景、逐帧拉片等 LibTV 独有功能。

## 测试与验收

1. `npx tsc --noEmit` + `npm run build` 零错误；
2. Docker 重建部署；
3. 实测小主题（分镜数选 4）完整跑通：画布节点随阶段生长、风格库弹出并生效（资产生成带风格）、角色参考图正确连到分镜、台词注入、串行生成避开限流、时间线按序填入；
4. 中止/失败路径：中途中止后画布节点保留；单镜故意失败不影响后续镜。
