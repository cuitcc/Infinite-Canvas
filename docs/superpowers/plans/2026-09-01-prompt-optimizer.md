# 图片/视频提示词优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为图片和视频节点添加一键"✨ 优化"提示词功能：文本模型按业界最佳实践结构改写提示词，用户在预览弹窗中确认后才写回。

**Architecture:** 扩展现有 `/api/text/format` 接口，新增 `optimize-image` / `optimize-video` 两个 action 和可选 `context` 字段；前端新增共享弹窗组件 `PromptOptimizeModal`，接入图片节点、视频节点、NodeConfigPanel 三处。不修改 store 结构与数据库。

**Tech Stack:** Next.js 16 App Router + React Flow + Zustand；文本模型复用现有 `resolveModel` 路由（Agnes chat / generic OpenAI 兼容）。

**设计规范:** `docs/superpowers/specs/2026-09-01-prompt-optimizer-design.md`

## Global Constraints

- 优化结果为纯中文；图片提示词 ≤120 字，视频提示词 ≤160 字；直接输出提示词本身，无解释或前后缀。
- 交互为"预览后应用"：只有用户点"应用"才调用 `updateNodeData(nodeId, { prompt })`，取消/失败/重新优化均不覆盖原文。
- 优化模型：请求体 `model` 传节点 `data.textModel`（可能为 undefined，后端默认 `agnes-2.5-flash`）。
- 现有 4 个 action（expand/polish/translate-en/storyboard）行为不变。
- 不修改 `lib/store.ts` 的类型与结构、不修改数据库、不新建接口文件。
- 本项目无测试框架：验证方式为 `npm run build` 零 TS 错误 + dev server curl 冒烟 + 手工 UI 验证。

---

### Task 1: 后端新增 optimize-image / optimize-video action 与 context 支持

**Files:**
- Modify: `app/api/text/format/route.ts`

**Interfaces:**
- Consumes: 现有 `createAgnesChatCompletion({ messages, model })`（`lib/agnes-chat.ts`）、`genericTextGenerate({ modelName, system, user })`（`lib/generic-provider.ts`）、`resolveModel(modelName)`（`lib/model-registry.ts`）。
- Produces: `POST /api/text/format` 请求体扩展为 `{ text, action, model?, context? }`，其中 `context?: { ratio?: string; tier?: string; seconds?: string; referenceCount?: number }`；新 action key：`optimize-image`、`optimize-video`。Task 2 的前端依赖这两个 key 与 context 字段。

- [ ] **Step 1: 修改 route.ts — 新增两个 action 定义、context 类型与拼接函数**

将 `app/api/text/format/route.ts` 整体替换为：

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { genericTextGenerate } from "@/lib/generic-provider";
import { resolveModel } from "@/lib/model-registry";

const FORMAT_ACTIONS: Record<string, { label: string; system: string }> = {
  "expand": {
    label: "扩写为画面提示词",
    system: "你是 AI 绘画/视频提示词专家。把用户的简短想法扩写成一段具体、可视化的画面提示词,包含主体、动作、环境、光线、色调、镜头语言。直接输出提示词本身,不要任何解释或前后缀,中文,控制在 120 字内。",
  },
  "polish": {
    label: "润色",
    system: "你是文本润色助手。优化用户的文字表达,使其更流畅精准,保持原意和原有语言。直接输出润色后的文本,不要解释。",
  },
  "translate-en": {
    label: "译为英文提示词",
    system: "你是翻译专家。把用户的中文内容翻译成高质量英文画面提示词(AI 生成用途),保留关键视觉元素,可补充常用画质词。直接输出译文,不要解释。",
  },
  "storyboard": {
    label: "拆成分镜脚本",
    system: "你是分镜师。把用户的想法拆成 3-6 个连续分镜,每个分镜一行,格式:镜号|画面描述(主体+动作+景别)|时长建议。直接输出列表,不要额外解释。",
  },
  "optimize-image": {
    label: "优化图片提示词",
    system: "你是顶级 AI 绘画提示词专家。把用户的提示词改写为高质量中文绘画提示词,按以下结构组织:主体(具体细节,重要内容前置)→环境场景→构图与镜头(景别、角度、焦段)→光线→色调氛围→风格/媒介→画质词(masterpiece, best quality, ultra-detailed, 8k uhd)。要求:全部用正面描述,表达空场景用\"空无一人\",禁止出现\"没有/无人/不要\"等否定词,排除项不写入正面提示词;保留用户原意;直接输出提示词本身,不要任何解释或前后缀;中文,120 字以内。",
  },
  "optimize-video": {
    label: "优化视频提示词",
    system: "你是顶级 AI 视频提示词专家。把用户的提示词改写为高质量中文视频生成提示词,按以下结构组织:镜头语言(景别+运镜,如\"特写,镜头缓慢推进\")→主体→动作(按时间顺序描述,如\"缓缓转身,裙摆扬起\")→场景环境→光线→风格→节奏/时长感。要求:单镜头单场景,不写多镜头切换;动作随时间描述;保留用户原意;直接输出提示词本身,不要任何解释或前后缀;中文,160 字以内。",
  },
};

interface FormatContext {
  ratio?: string;
  tier?: string;
  seconds?: string;
  referenceCount?: number;
}

/** 把节点上下文拼成追加给模型的提示后缀;空 context 返回空串 */
function formatContextSuffix(context?: FormatContext): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.ratio) parts.push(`比例 ${context.ratio}`);
  if (context.tier) parts.push(`档位 ${context.tier}`);
  if (context.seconds) parts.push(`时长 ${context.seconds} 秒`);
  if (typeof context.referenceCount === "number" && context.referenceCount > 0) parts.push(`参考图 ${context.referenceCount} 张`);
  return parts.length > 0 ? `\n\n（生成要求：${parts.join("，")}）` : "";
}

export async function POST(req: NextRequest) {
  try {
    const { text, action, model, context } = await req.json() as { text?: string; action?: string; model?: string; context?: FormatContext };
    if (!text || !text.trim()) {
      return NextResponse.json({ error: "文本不能为空" }, { status: 400 });
    }
    const preset = FORMAT_ACTIONS[action ?? "expand"];
    if (!preset) {
      return NextResponse.json({ error: "未知的格式化动作" }, { status: 400 });
    }
    const userMessage = `${text.trim()}${formatContextSuffix(context)}`;

    // 按模型路由:Agnes 专用 / 其他厂商通用 OpenAI 兼容
    const resolved = model ? resolveModel(model) : undefined;
    const result = resolved && resolved.provider.name !== "Agnes"
      ? await genericTextGenerate({ modelName: model!, system: preset.system, user: userMessage })
      : await createAgnesChatCompletion({
          messages: [
            { role: "system", content: preset.system },
            { role: "user", content: userMessage },
          ],
          model: resolved?.model.modelId,
        });

    return NextResponse.json({ ok: true, result, action: preset.label });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    actions: Object.entries(FORMAT_ACTIONS).map(([key, v]) => ({ key, label: v.label })),
  });
}
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译成功，零 TypeScript 错误。

- [ ] **Step 3: dev server 冒烟验证（不消耗模型调用）**

Run: `npm run dev` 后另开终端：

```bash
curl -s http://localhost:3000/api/text/format | head -c 600
curl -s -X POST http://localhost:3000/api/text/format -H "Content-Type: application/json" -d '{"action":"optimize-image","text":""}'
```

Expected: GET 返回的 actions 数组包含 `optimize-image`、`optimize-video`；POST 空文本返回 `{"error":"文本不能为空"}`。验证后停掉 dev server。

- [ ] **Step 4: Commit**

```bash
git add app/api/text/format/route.ts
git commit -m "feat: add optimize-image/optimize-video prompt actions with node context"
```

---

### Task 2: 新增共享组件 PromptOptimizeModal

**Files:**
- Create: `components/PromptOptimizeModal.tsx`

**Interfaces:**
- Consumes: Task 1 的接口（`POST /api/text/format`，action `optimize-image`/`optimize-video`，context 字段）；`useCanvasStore` 的 `nodes/edges/updateNodeData`；`CanvasNodeData` 的 `prompt/textModel/imageRatio/imageTier/aspectRatio/seconds` 字段。
- Produces: 组件 `PromptOptimizeModal`，签名 `({ nodeId, kind, open, onClose }: { nodeId: string; kind: "image" | "video"; open: boolean; onClose: () => void })`。Task 3 在三个组件中以该签名引用。

- [ ] **Step 1: 创建 `components/PromptOptimizeModal.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useCanvasStore } from "@/lib/store";

type OptimizeKind = "image" | "video";

const ACTION_KEY: Record<OptimizeKind, string> = {
  image: "optimize-image",
  video: "optimize-video",
};

export function PromptOptimizeModal({ nodeId, kind, open, onClose }: {
  nodeId: string;
  kind: OptimizeKind;
  open: boolean;
  onClose: () => void;
}) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const edges = useCanvasStore((s) => s.edges);
  const nodes = useCanvasStore((s) => s.nodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const data = node?.data;
  const prompt = (data?.prompt as string | undefined) ?? "";
  const textModel = data?.textModel as string | undefined;
  const referenceCount = edges
    .filter((e) => e.target === nodeId)
    .filter((e) => {
      const src = nodes.find((n) => n.id === e.source);
      return src?.data.kind === "image" || src?.data.kind === "upload";
    }).length;

  const optimize = useCallback(async () => {
    if (!prompt.trim()) {
      setError("提示词为空，请先输入内容");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const context = kind === "image"
        ? { ratio: data?.imageRatio as string | undefined, tier: data?.imageTier as string | undefined, referenceCount }
        : { ratio: data?.aspectRatio as string | undefined, seconds: data?.seconds as string | undefined, referenceCount };
      const res = await fetch("/api/text/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt, action: ACTION_KEY[kind], model: textModel, context }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "优化失败");
      if (!json.result || !String(json.result).trim()) throw new Error("优化结果为空，请重试");
      setResult(String(json.result));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
    // data 字段仅在打开瞬间读取,依赖 prompt/referenceCount 即可
  }, [prompt, kind, textModel, referenceCount, data?.imageRatio, data?.imageTier, data?.aspectRatio, data?.seconds]);

  useEffect(() => {
    if (open) {
      setResult("");
      setError(undefined);
      void optimize();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const apply = () => {
    if (!result.trim()) return;
    updateNodeData(nodeId, { prompt: result });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">{kind === "image" ? "优化图片提示词" : "优化视频提示词"}</span>
          <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">✕</button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          <div>
            <p className="mb-1 text-[10px] font-medium text-slate-400">原始提示词</p>
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">{prompt || "（空）"}</p>
          </div>
          <div>
            <p className="mb-1 text-[10px] font-medium text-slate-400">优化后提示词</p>
            {busy ? (
              <div className="flex h-20 items-center justify-center gap-2 rounded border border-slate-200 bg-slate-50 text-xs text-slate-400">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                优化中…
              </div>
            ) : error ? (
              <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-500">
                {error}
                <button onClick={() => void optimize()} className="ml-2 rounded bg-rose-100 px-2 py-0.5 text-[10px] text-rose-600 hover:bg-rose-200">重试</button>
              </div>
            ) : (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-violet-200 bg-violet-50 p-2 text-xs text-slate-700">{result}</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">取消</button>
          <button
            onClick={() => void optimize()}
            disabled={busy}
            className="rounded border border-violet-200 bg-white px-3 py-1 text-xs text-violet-600 hover:bg-violet-50 disabled:opacity-50"
          >
            重新优化
          </button>
          <button
            onClick={apply}
            disabled={busy || !!error || !result.trim()}
            className="rounded bg-violet-500 px-3 py-1 text-xs font-medium text-white hover:bg-violet-600 disabled:bg-slate-300"
          >
            应用
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译成功，零 TypeScript 错误。

- [ ] **Step 3: Commit**

```bash
git add components/PromptOptimizeModal.tsx
git commit -m "feat: add PromptOptimizeModal with preview/apply/retry UX"
```

---

### Task 3: 接入图片节点、视频节点、NodeConfigPanel

**Files:**
- Modify: `components/ImageNode.tsx`
- Modify: `components/VideoNode.tsx`
- Modify: `components/NodeConfigPanel.tsx`

**Interfaces:**
- Consumes: Task 2 的 `PromptOptimizeModal({ nodeId, kind, open, onClose })`。
- Produces: 无（末端接入）。

- [ ] **Step 1: 修改 `components/ImageNode.tsx`**

文件顶部 import 增加：

```tsx
import { useState } from "react";
import { PromptOptimizeModal } from "./PromptOptimizeModal";
```

（`useState` 若与现有 import 合并，注意不重复引入。）

组件函数体开头（`const busy = ...` 之后）增加：

```tsx
const [optimizeOpen, setOptimizeOpen] = useState(false);
```

textarea（`</textarea>` 标签之后、`{data.error && ...}` 之前）插入按钮行：

```tsx
<div className="flex justify-end">
  <button
    onClick={() => setOptimizeOpen(true)}
    disabled={!(data.prompt ?? "").trim()}
    className="nodrag rounded bg-violet-100 px-2 py-0.5 text-[10px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
  >
    ✨ 优化
  </button>
</div>
```

`</div>`（`space-y-2` 容器结束标签）之前、`NodeShell` 内部末尾插入弹窗：

```tsx
<PromptOptimizeModal nodeId={id} kind="image" open={optimizeOpen} onClose={() => setOptimizeOpen(false)} />
```

- [ ] **Step 2: 修改 `components/VideoNode.tsx`**

与 Step 1 完全相同的四处改动，仅两处差异：按钮行插入位置同样是 textarea 之后 `{data.error && ...}` 之前；弹窗 `kind="video"`：

```tsx
import { useState } from "react";
import { PromptOptimizeModal } from "./PromptOptimizeModal";
```

```tsx
const [optimizeOpen, setOptimizeOpen] = useState(false);
```

```tsx
<div className="flex justify-end">
  <button
    onClick={() => setOptimizeOpen(true)}
    disabled={!(data.prompt ?? "").trim()}
    className="nodrag rounded bg-violet-100 px-2 py-0.5 text-[10px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
  >
    ✨ 优化
  </button>
</div>
```

```tsx
<PromptOptimizeModal nodeId={id} kind="video" open={optimizeOpen} onClose={() => setOptimizeOpen(false)} />
```

- [ ] **Step 3: 修改 `components/NodeConfigPanel.tsx`**

import 增加：

```tsx
import { PromptOptimizeModal } from "./PromptOptimizeModal";
```

组件内（`const audioSrc = ...` 之后）增加状态与上游参考图计数：

```tsx
const [optimizeOpen, setOptimizeOpen] = useState(false);
const referenceCount = upstream.filter(({ node: n }) => n!.data.kind === "image" || n!.data.kind === "upload").length;
```

（`upstream` 变量已存在于该文件，直接复用。）

视频配置区（`data.kind === "video"` 的负向提示词网格 `<div className="mt-3 grid grid-cols-2 ...">` 结束标签后）插入：

```tsx
{data.kind === "video" && (
  <div className="mt-3">
    <button
      onClick={() => setOptimizeOpen(true)}
      disabled={!(data.prompt ?? "").trim()}
      className="rounded bg-violet-100 px-2.5 py-1 text-[11px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
    >
      ✨ 优化提示词
    </button>
  </div>
)}
```

图片配置区（负向提示词 `<div className="mt-3 grid grid-cols-1 ...">` 网格结束标签后）插入同样的按钮块（样式一致，不再区分文案）：

```tsx
{data.kind === "image" && (
  <div className="mt-3">
    <button
      onClick={() => setOptimizeOpen(true)}
      disabled={!(data.prompt ?? "").trim()}
      className="rounded bg-violet-100 px-2.5 py-1 text-[11px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
    >
      ✨ 优化提示词
    </button>
  </div>
)}
```

组件根 `<div className="border-t border-slate-200 bg-white">` 的结束标签前插入弹窗（kind 由节点类型决定）：

```tsx
{(data.kind === "image" || data.kind === "video") && (
  <PromptOptimizeModal
    nodeId={id}
    kind={data.kind}
    open={optimizeOpen}
    onClose={() => setOptimizeOpen(false)}
  />
)}
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 编译成功，零 TypeScript 错误。

- [ ] **Step 5: Commit**

```bash
git add components/ImageNode.tsx components/VideoNode.tsx components/NodeConfigPanel.tsx
git commit -m "feat: wire prompt optimizer into image/video nodes and config panel"
```

---

### Task 4: 部署与端到端手工验证

**Files:**
- 无代码改动（验证任务）

**Interfaces:**
- Consumes: Task 1–3 的全部改动。
- Produces: 已部署并验证通过的运行环境。

- [ ] **Step 1: Docker 重建部署**

```bash
docker compose up -d --build
docker logs --tail 20 infinite-canvas
```

Expected: 构建成功，容器日志出现 `Ready`。

- [ ] **Step 2: 手工验证清单（在浏览器中逐项确认）**

1. 图片节点输入简短提示词（如"古代青楼跳舞舞台"）→ 点"✨ 优化"→ 弹窗显示优化中 → 结果为中文且包含主体/环境/光线/画质结构 → 点"应用"后 textarea 更新为优化结果。
2. 弹窗中点"取消"，textarea 仍为原文；点"重新优化"会再次请求且不覆盖原文。
3. 视频节点同样流程，优化结果包含镜头/运镜描述（如"特写，镜头缓慢推进"）。
4. NodeConfigPanel 图片/视频配置区的"✨ 优化提示词"按钮可用，弹窗行为一致。
5. 提示词为空时优化按钮处于禁用态。
6. 文本节点现有 扩写/润色/译英/分镜 按钮行为不变。
7. 有参考图连线时，弹窗请求的 context 含 `referenceCount`（可通过 `docker logs` 中后端无报错、优化结果贴合比例确认）。

- [ ] **Step 3: 如有问题修复后重复 Step 1；验证通过后向用户报告完成**

---

## Self-Review 记录

- 规范覆盖：后端 action+context（Task 1）、预览弹窗（Task 2）、三处接入点（Task 3）、部署验证（Task 4）——规范所有需求均有对应任务。
- 占位符扫描：无 TBD/TODO；所有代码步骤含完整代码。
- 类型一致性：`PromptOptimizeModal` 的 props 签名在 Task 2 定义、Task 3 使用一致；action key `optimize-image`/`optimize-video` 前后端一致；context 字段名 `ratio/tier/seconds/referenceCount` 前后端一致。
