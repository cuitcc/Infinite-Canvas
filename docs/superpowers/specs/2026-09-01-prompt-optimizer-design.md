# 图片/视频提示词优化功能设计

日期：2026-09-01
状态：已通过用户评审

## 背景与目标

图片和视频节点的提示词质量直接决定生成效果。用户输入往往过于简短或包含负面表述（如"无人的空场景"），生成模型难以遵循。本功能为图片节点和视频节点添加一键"✨ 优化"提示词能力，基于业界主流最佳实践（Midjourney/Flux 文生图结构、Veo 3/Runway 视频结构）由文本模型改写用户提示词，优化结果先预览、用户确认后才写回。

## 需求结论（已与用户确认）

- 交互：预览后可应用（对比原文，用户点"应用"才覆盖）。
- 输出语言：中文。
- 优化模型：复用节点当前 `textModel`（未设置时后端默认 `agnes-2.5-flash`）。
- 实现方式：扩展现有 `/api/text/format` 接口，不新建接口。

## 架构

复用现有文本格式化链路：前端按钮 → `/api/text/format`（新增 action）→ `resolveModel` 路由 → Agnes chat 或 generic text → 返回结果字符串。前端新增一个共享预览弹窗组件，图片/视频节点卡片与配置面板均接入。

### 组件与数据流

```
ImageNode / VideoNode / NodeConfigPanel
  └─ "✨ 优化" 按钮
      └─ PromptOptimizeModal（共享组件，本地 state）
          ├─ POST /api/text/format { text, action: "optimize-image"|"optimize-video", model: data.textModel, context }
          ├─ 预览：原始提示词 / 优化后提示词 上下两栏
          └─ 应用 → updateNodeData(nodeId, { prompt: 优化结果 }) ；取消/重新优化不写回
```

不修改 Zustand store 结构、不改数据库、不动现有文本节点功能。

## 后端改动：`app/api/text/format/route.ts`

1. `FORMAT_ACTIONS` 新增两个 action（现有 4 个保持不变）：

   - `optimize-image`：
     - label：`优化图片提示词`
     - system：你是顶级 AI 绘画提示词专家。把用户的提示词改写为高质量中文绘画提示词，按以下结构组织：主体（具体细节，重要内容前置）→ 环境场景 → 构图与镜头（景别、角度、焦段）→ 光线 → 色调氛围 → 风格/媒介 → 画质词（masterpiece, best quality, ultra-detailed, 8k uhd）。要求：全部用正面描述（表达"空场景"用"空无一人"，禁止出现"没有/无人/不要"等否定词，排除项不写入正面提示词）；保留用户原意；直接输出提示词本身，不要任何解释或前后缀；中文，120 字以内。

   - `optimize-video`：
     - label：`优化视频提示词`
     - system：你是顶级 AI 视频提示词专家。把用户的提示词改写为高质量中文视频生成提示词，按以下结构组织：镜头语言（景别 + 运镜，如"特写，镜头缓慢推进"）→ 主体 → 动作（按时间顺序描述，如"缓缓转身，裙摆扬起"）→ 场景环境 → 光线 → 风格 → 节奏/时长感。要求：单镜头单场景，不写多镜头切换；动作随时间描述；保留用户原意；直接输出提示词本身，不要任何解释或前后缀；中文，160 字以内。

2. 请求体新增可选 `context` 字段：

   ```ts
   { text, action, model, context?: { ratio?: string; tier?: string; seconds?: string; referenceCount?: number } }
   ```

   当 `context` 存在时，拼接到发给模型的用户消息末尾，例如：`\n\n（画面要求：比例 9:16，档位 4K，参考图 1 张）` 或 `\n\n（视频要求：时长 5 秒，比例 16:9）`。`context` 为空时行为与现在完全一致。

3. 路由逻辑不变：`model` 能解析且非 Agnes 厂商走 `genericTextGenerate`，否则走 `createAgnesChatCompletion`。

## 前端改动

### 新增 `components/PromptOptimizeModal.tsx`

共享弹窗组件，props：

```ts
{
  nodeId: string;
  kind: "image" | "video";
  open: boolean;
  onClose: () => void;
}
```

行为：

- 打开时读取节点 `data.prompt`，携带上下文调用 `/api/text/format`：
  - image 节点 context：`{ ratio: data.imageRatio, tier: data.imageTier, referenceCount: 上游图/upload 连线数 }`
  - video 节点 context：`{ seconds: data.seconds, ratio: data.aspectRatio, referenceCount: 上游图/upload 连线数 }`
- 弹窗内上下两栏展示原始提示词与优化结果（等宽字体、可滚动），下方按钮：`应用`（写回并关闭）、`重新优化`（再次请求）、`取消`。
- 请求中显示 loading 态；失败在弹窗内显示错误文字与 `重试` 按钮，不写回原文。
- 所有状态为组件本地 state，不进 store。

### 接入点（3 处）

1. `components/ImageNode.tsx`：提示词 textarea 右下角/旁边加 `✨ 优化` 小按钮。
2. `components/VideoNode.tsx`：提示词区域同样加按钮。
3. `components/NodeConfigPanel.tsx`：图片与视频两个配置区各加一个 `✨ 优化提示词` 按钮，点击打开同一弹窗。

按钮样式沿用现有节点小按钮风格（`text-[10px]`/`text-[11px]`、圆角、`nodrag`），使用紫/金色系与现有蓝（图片）红（视频）按钮区分。

## 错误处理

- 接口失败：沿用现有 500 + `{ error }` 结构，弹窗内展示 `error` 文字。
- 优化结果为空（模型返回空串）：弹窗提示"优化结果为空，请重试"。
- 文本为空时按钮禁用（与现有"生成"按钮一致的 disabled 逻辑）。

## 测试与验证

1. `npm run build` 零 TypeScript 错误。
2. `docker compose up -d --build` 后手工验证：
   - 图片节点输入简短提示词 → 优化 → 预览弹窗显示结构清晰的中文提示词 → 应用后 textarea 更新，生成走新提示词。
   - 视频节点同样流程；验证优化结果包含镜头/运镜描述。
   - 取消/重新优化不覆盖原文。
   - 现有文本节点的 扩写/润色/译英/分镜 按钮行为不变。
   - 选择非 Agnes 文本模型时优化仍可用（generic 路由）。

## 不做（YAGNI）

- 不做优化历史记录、不做 A/B 对比生成、不做英文输出切换。
- 不为优化结果单独建接口或建表。
- 不自动改写负向提示词（维持现有负向提示词链路）。
