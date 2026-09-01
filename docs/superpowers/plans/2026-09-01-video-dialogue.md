# 视频节点台词口型功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为视频节点增加"台词"能力——手写或一键提取人物台词，生成时注入提示词，由 Agnes 直生人声并与口型同步。

**Architecture:** 复用现有链路做最小改动：`CanvasNodeData` 加 `dialogue` 字段；`/api/text/format` 加 `extract-dialogue` action；`lib/store.ts` 视频生成分支把台词追加进提示词；新增一个共享 hook `useDialogueExtract` 供视频节点卡片与配置面板调用。

**Tech Stack:** Next.js 16 App Router、React Flow、Zustand、TypeScript。

## Global Constraints

- 注入话术固定为：`` 人物开口说出台词（人声清晰，口型与台词精确同步）："${dialogue}" ``（Phase 0 已实测 Agnes 生成的视频含音轨）。
- 台词为空时，生成的请求体必须与现状完全一致（无任何追加）。
- 提取 action key 必须是 `extract-dialogue`，label 必须是 `提取台词`。
- 提取结果直接写入 `data.dialogue`，不使用预览弹窗。
- 不改数据库、不加节点类型、不做 TTS 回退链路。
- 本仓库无测试框架：每任务的验证 = `npm run build` 零错误 + curl 接口验证（或 UI 手工项）。
- 项目说明（AGENTS.md）：Next.js 版本与训练数据可能不同，写代码前先读 `node_modules/next/dist/docs/` 相关指南。

## Phase 0 实测结论（已完成，作为上下文）

2026-09-01 用 curl 直接调 Agnes `/videos`（text 模式），提示词 `一位年轻女性面向镜头微笑，开口说出台词："你好，欢迎来到这里"，人声清晰，口型与台词精确同步`，任务 `task_jy7dTjnhgW2fnaMKX1nMK1uWORubZFiQ` 生成成功，MP4 box 扫描确认**含独立音轨（hdlr handler = `soun`）**。结论：Agnes Video 2.5 Flash 支持按提示词台词直生人声。口型开合与台词内容留待用户浏览器内最终确认。

---

### Task 1: 数据字段与生成链路注入

**Files:**
- Modify: `types/agnes.ts:134`（`CanvasNodeData` 内，`aspectRatio` 附近）
- Modify: `lib/store.ts:208`（一致性描述块之后、`if (!prompt.trim())` 之前）

**Interfaces:**
- Produces: `CanvasNodeData.dialogue?: string`（Task 3/4 的 UI 读写此字段）；`lib/store.ts` 生成时注入台词（无新导出）。

- [ ] **Step 1: 加类型字段**

`types/agnes.ts` 的 `CanvasNodeData` 中，`aspectRatio?: string;` 之后加：

```ts
  /** 视频节点：人物台词，生成时注入提示词由模型直生语音并与口型同步 */
  dialogue?: string;
```

- [ ] **Step 2: 生成链路注入**

`lib/store.ts` 中，图片 `lockIdentity` 块（`if (imageUrls.length > 0 && data.kind === "image" ...)` 结束的 `}` 之后）插入：

```ts
    // 台词注入:Agnes 可按提示词台词直生人声(Phase 0 实测含音轨),口型与台词同步
    const dialogue = data.dialogue?.trim();
    if (dialogue && data.kind === "video") {
      prompt = `${prompt}\n人物开口说出台词（人声清晰，口型与台词精确同步）："${dialogue}"`;
    }
```

注意插入位置在 `if (!prompt.trim())` 检查**之前**——这样只填台词不填画面描述时，台词本身就是提示词，可以生成。

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 零 TypeScript 错误，编译成功。

- [ ] **Step 4: Commit**

```bash
git add types/agnes.ts lib/store.ts
git commit -m "feat: add dialogue field and inject dialogue into video prompt"
```

---

### Task 2: 后端 extract-dialogue action

**Files:**
- Modify: `app/api/text/format/route.ts:30`（`FORMAT_ACTIONS` 的 `optimize-video` 条目之后）

**Interfaces:**
- Consumes: 现有 `FORMAT_ACTIONS` 结构（`{ label, system }`）与路由逻辑（不变）。
- Produces: action `extract-dialogue`，POST `/api/text/format` body `{ text, action: "extract-dialogue", model? }` → `{ ok: true, result: string }`（Task 3 的 hook 调用此接口）。

- [ ] **Step 1: 加 action**

`FORMAT_ACTIONS` 的 `optimize-video` 条目后加：

```ts
  "extract-dialogue": {
    label: "提取台词",
    system: "你是影视台词提取专家。从用户的视频提示词或故事文本中提取人物说的话,整理成可直接口播的中文对白。要求:只保留人物说出的内容,去掉叙述、动作、场景描写;格式为\"角色:台词内容\",多个角色分行;台词自然口语化,可直接朗读;直接输出台词本身,不要任何解释、引号或前后缀;中文,80 字以内。",
  },
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 零 TypeScript 错误。

- [ ] **Step 3: 接口验证**

```bash
docker compose up -d --build
sleep 8
curl -s http://localhost:3001/api/text/format | python3 -m json.tool
curl -s -X POST http://localhost:3001/api/text/format -H "Content-Type: application/json" \
  -d '{"text":"夜色下的古镇街头,一位撑伞的少女回头对镜头微笑说:原来你也在这里。灯笼的光映在她脸上。","action":"extract-dialogue"}'
```

Expected: GET 列出 7 个 action（含 `extract-dialogue`/`提取台词`）；POST 返回 `"ok": true` 且 `result` 为口播对白（如 `少女：原来你也在这里`）。

- [ ] **Step 4: Commit**

```bash
git add app/api/text/format/route.ts
git commit -m "feat: add extract-dialogue action to text format API"
```

---

### Task 3: useDialogueExtract hook 与视频节点卡片 UI

**Files:**
- Create: `components/use-dialogue-extract.ts`
- Modify: `components/VideoNode.tsx`

**Interfaces:**
- Consumes: Task 1 的 `CanvasNodeData.dialogue`；Task 2 的 `extract-dialogue` action；store 的 `updateNodeData(nodeId, data)`。
- Produces: `useDialogueExtract(nodeId: string): { extract: () => Promise<void>; extracting: boolean; error: string | undefined; clearError: () => void }`（Task 4 复用同一 hook）。

- [ ] **Step 1: 写 hook**

创建 `components/use-dialogue-extract.ts`：

```ts
"use client";

import { useCallback, useState } from "react";
import { useCanvasStore } from "@/lib/store";

/** 提取台词到视频节点:本节点提示词为空时回退上游文本节点(与生成链路取值一致) */
export function useDialogueExtract(nodeId: string) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const extract = useCallback(async () => {
    const s = useCanvasStore.getState();
    const node = s.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    let text = node.data.prompt ?? "";
    if (!text.trim()) {
      const upstreamText = s.edges
        .filter((e) => e.target === nodeId)
        .map((e) => s.nodes.find((n) => n.id === e.source))
        .find((n) => n && (n.data.kind === "text" || n.data.kind === "prompt") && (n.data.prompt ?? "").trim())
        ?.data.prompt;
      text = upstreamText ?? "";
    }
    if (!text.trim()) {
      setError("没有可用提示词,请先填写提示词或连接文本节点");
      return;
    }
    setExtracting(true);
    setError(undefined);
    try {
      const res = await fetch("/api/text/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, action: "extract-dialogue", model: node.data.textModel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "提取失败");
      const result = String(json.result ?? "").trim();
      if (!result) throw new Error("未从提示词中提取到台词");
      updateNodeData(nodeId, { dialogue: result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [nodeId, updateNodeData]);

  return { extract, extracting, error, clearError: useCallback(() => setError(undefined), []) };
}
```

- [ ] **Step 2: 卡片接入**

`components/VideoNode.tsx`：

1. import 区加 `import { useDialogueExtract } from "./use-dialogue-extract";`
2. 组件内 `const [optimizeOpen, setOptimizeOpen] = useState(false);` 之后加：

```tsx
  const { extract, extracting, error: dialogueError, clearError } = useDialogueExtract(id);
```

3. 优化按钮的 `<div className="flex justify-end">…</div>` 块之后、`{data.error && …}` 之前插入：

```tsx
        <div className="flex items-center gap-1.5">
          <input
            value={data.dialogue ?? ""}
            onChange={(e) => updateNodeData(id, { dialogue: e.target.value })}
            placeholder="人物台词(可选)"
            className="nodrag min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 outline-none focus:border-rose-400"
          />
          <button
            onClick={() => { clearError(); extract(); }}
            disabled={extracting}
            className="nodrag shrink-0 rounded bg-violet-100 px-2 py-0.5 text-[10px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
          >
            {extracting ? "提取中…" : "✨ 提取台词"}
          </button>
        </div>
        {dialogueError && <p className="text-[10px] text-rose-500">{dialogueError}</p>}
```

说明：按钮不因提示词为空而禁用——hook 会回退上游文本节点，无源可提取时在按钮旁显示错误文字（对规格"提示词为空时禁用"的有意调整，与上游回退逻辑保持一致）。

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 零 TypeScript 错误。

- [ ] **Step 4: Commit**

```bash
git add components/use-dialogue-extract.ts components/VideoNode.tsx
git commit -m "feat: dialogue input and extract button on video node card"
```

---

### Task 4: 配置面板台词区

**Files:**
- Modify: `components/NodeConfigPanel.tsx`

**Interfaces:**
- Consumes: Task 3 的 `useDialogueExtract`；Task 1 的 `data.dialogue`。

- [ ] **Step 1: 接入 hook 与 UI**

`components/NodeConfigPanel.tsx`：

1. import 区加 `import { useDialogueExtract } from "./use-dialogue-extract";`
2. 组件内 `const [optimizeOpen, setOptimizeOpen] = useState(false);` 之后加：

```tsx
  const { extract, extracting, error: dialogueError, clearError } = useDialogueExtract(id);
```

3. `✨ 优化提示词` 按钮所在 `{data.kind === "video" && (<div className="mt-3">…</div>)}` 块之后插入：

```tsx
        {data.kind === "video" && (
          <div className="mt-3">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              人物台词(可选,生成时注入提示词,由模型直生语音并与口型同步)
              <textarea
                value={data.dialogue ?? ""}
                onChange={(e) => updateNodeData(id, { dialogue: e.target.value })}
                rows={2}
                placeholder="如:少女：原来你也在这里"
                className="w-full resize-none rounded border border-slate-200 bg-white px-2 py-1.5 outline-none focus:border-rose-400"
              />
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={() => { clearError(); extract(); }}
                disabled={extracting}
                className="rounded bg-violet-100 px-2.5 py-1 text-[11px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
              >
                {extracting ? "提取中…" : "✨ 提取台词"}
              </button>
              {dialogueError && <span className="text-[10px] text-rose-500">{dialogueError}</span>}
            </div>
          </div>
        )}
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 零 TypeScript 错误。

- [ ] **Step 3: Commit**

```bash
git add components/NodeConfigPanel.tsx
git commit -m "feat: dialogue textarea and extract button in video config panel"
```

---

### Task 5: 部署与端到端验证

**Files:** 无代码改动（部署 + 验证）。

**Interfaces:**
- Consumes: Task 1-4 全部改动。

- [ ] **Step 1: 构建并部署**

```bash
npm run build && docker compose up -d --build
```

Expected: 镜像构建成功，容器重启，`curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/` 返回 200。

- [ ] **Step 2: 接口冒烟验证**

```bash
curl -s http://localhost:3001/api/text/format | python3 -c "import sys,json; print([a['key'] for a in json.load(sys.stdin)['actions']])"
```

Expected: 列表含 `extract-dialogue`（共 7 个 action）。

- [ ] **Step 3: 用户浏览器验证清单**

交付给用户在浏览器（http://localhost:3001）确认：

1. 视频节点卡片出现台词输入框与"✨ 提取台词"按钮；配置面板出现台词多行框与同款按钮。
2. 提示词含对白（如"一位少女回头说：原来你也在这里"）→ 点提取 → 台词框被填入口播对白。
3. 提示词为空但连了文本节点 → 提取从上游文本提取。
4. 手写台词 → 生成视频 → 播放有人声，且人物口型开合与台词节奏一致（Phase 0 已确认有音轨，口型需人眼确认）。
5. 台词清空后生成 → 行为与之前完全一致。
6. 取消场景：无提示词、无上游文本时点提取 → 显示"没有可用提示词…"错误，不写台词框。

- [ ] **Step 4: Commit（如有零星修正）**

```bash
git add -A && git commit -m "chore: deploy video dialogue feature" --allow-empty
```

---

## Self-Review 记录

1. **Spec 覆盖**：Phase 0（已完成，结论写入 Global Constraints）✓；dialogue 字段（Task 1）✓；extract-dialogue action（Task 2）✓；注入逻辑（Task 1）✓；卡片 UI（Task 3）✓；面板 UI（Task 4）✓；提取回退上游（Task 3 hook）✓；错误处理（hook error + 按钮旁显示）✓；部署验证（Task 5）✓。
2. **占位符扫描**：所有代码块完整可抄录，无 TBD/TODO。
3. **类型一致性**：`dialogue?: string`、`useDialogueExtract` 返回签名、`extract-dialogue` key 在各任务间一致。
4. **有意偏差**：提取按钮不禁用于空提示词（hook 回退上游文本，无源时报错）——比规格"提示词为空时禁用"更符合上游回退语义。
