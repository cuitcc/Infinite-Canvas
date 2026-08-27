# 音频节点与视频音频参考实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增基于 Edge TTS 的音频节点，支持中文/英文预设音色；让视频节点可把音频作为参考传入 Agnes；时间线导出支持音视频混音。

**Architecture:** 前端新增 `audio` 节点及配置面板；后端 `/api/generate/audio` 用 `node-edge-tts` 合成 mp3 并保存到 `media` 表；`lib/store.ts` 允许 `audio→video` 连线并在触发视频生成时收集音频 URL；`/api/generate/video` 把音频数组透传给 `lib/agnes-video.ts`；`TimelinePanel` 支持给视频片段绑定音频，`/api/export` 用 ffmpeg 混音后拼接。

**Tech Stack:** Next.js 16 App Router, React Flow, Zustand, node-edge-tts, ffmpeg, SQLite.

## Global Constraints

- Node.js 22 (Docker `node:22-bookworm-slim`)。
- 所有新增节点类型必须注册到 `lib/store.ts` 的 `NodeKind`、`app/page.tsx` 的 `nodeTypes` 和工具栏。
- 所有媒体文件统一走 `lib/db.ts` 的 `media` 表，本地存 `data/media/`。
- 新增 API 路由放在 `app/api/<name>/route.ts`，统一返回 JSON。
- UI 风格与现有节点一致（Tailwind，text-[10px]/text-xs，rounded border）。
- 每次任务完成后 `npm run build` 必须无 TypeScript 错误。

---

## File Map

| 文件 | 职责 |
| --- | --- |
| `package.json` | 新增依赖 `node-edge-tts`。 |
| `lib/edge-tts-voices.ts` | Edge TTS 预设音色列表（中文+英文）。 |
| `lib/store.ts` | 新增 `audio` 节点类型、连线规则、`referenceOrder`/`videoMode` 无关改动已在之前完成；本次新增音频收集逻辑。 |
| `components/NodeShell.tsx` | 给 `audio` 节点增加配色和 source handle。 |
| `app/page.tsx` | 注册 `AudioNodeView`，工具栏加“+ 音频”按钮。 |
| `components/AudioNode.tsx` | 新音频节点 UI。 |
| `app/api/generate/audio/route.ts` | 新 TTS API。 |
| `components/NodeConfigPanel.tsx` | 音频节点配置 + 视频节点显示音频上游参考。 |
| `app/api/generate/video/route.ts` | 接收 `audioUrls` 并传给 Agnes 逻辑。 |
| `lib/agnes-video.ts` | 2.5-flash 请求体增加 `audios`。 |
| `types/agnes.ts` | `CreateVideoInput` / `AgnesCreateVideoBody` 增加 `audios`。 |
| `components/TimelinePanel.tsx` | 支持音频片段绑定。 |
| `app/api/export/route.ts` | 片段级音视频混音。 |

---

## Task 1: 安装依赖并创建音色列表

**Files:**
- Modify: `package.json`
- Create: `lib/edge-tts-voices.ts`
- Test: `npm install` + `npm run build`

**Interfaces:**
- Produces: `EDGE_TTS_VOICES: { id: string; label: string }[]`, `DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural"`。

- [ ] **Step 1: 安装 `node-edge-tts`**

```bash
npm install node-edge-tts
```

- [ ] **Step 2: 创建音色列表文件**

```ts
// lib/edge-tts-voices.ts
export const EDGE_TTS_VOICES = [
  // 中文普通话
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓（女，普通话）" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊（女，普通话）" },
  { id: "zh-CN-YunjianNeural", label: "云健（男，普通话）" },
  { id: "zh-CN-YunxiNeural", label: "云希（男，普通话）" },
  { id: "zh-CN-YunxiaNeural", label: "云夏（男，普通话）" },
  { id: "zh-CN-YunyangNeural", label: "云扬（男，新闻）" },
  // 方言
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北（辽宁话，女）" },
  { id: "zh-CN-shaanxi-XiaoniNeural", label: "小妮（陕西话，女）" },
  // 粤语
  { id: "zh-HK-HiuGaaiNeural", label: "晓佳（粤语，女）" },
  { id: "zh-HK-HiuMaanNeural", label: "晓曼（粤语，女）" },
  { id: "zh-HK-WanLungNeural", label: "云龙（粤语，男）" },
  // 台湾腔
  { id: "zh-TW-HsiaoChenNeural", label: "晓臻（台湾腔，女）" },
  { id: "zh-TW-HsiaoYuNeural", label: "晓雨（台湾腔，女）" },
  { id: "zh-TW-YunJheNeural", label: "云哲（台湾腔，男）" },
  // 英文
  { id: "en-US-AriaNeural", label: "Aria（美式，女）" },
  { id: "en-US-AnaNeural", label: "Ana（美式，女童）" },
  { id: "en-US-ChristopherNeural", label: "Christopher（美式，男）" },
  { id: "en-US-EricNeural", label: "Eric（美式，男）" },
  { id: "en-US-GuyNeural", label: "Guy（美式，男，新闻）" },
  { id: "en-US-JennyNeural", label: "Jenny（美式，女）" },
  { id: "en-US-MichelleNeural", label: "Michelle（美式，女）" },
  { id: "en-US-RogerNeural", label: "Roger（美式，男）" },
  { id: "en-US-SteffanNeural", label: "Steffan（美式，男）" },
  { id: "en-GB-LibbyNeural", label: "Libby（英式，女）" },
  { id: "en-GB-RyanNeural", label: "Ryan（英式，男）" },
  { id: "en-AU-NatashaNeural", label: "Natasha（澳式，女）" },
  { id: "en-AU-WilliamNeural", label: "William（澳式，男）" },
  { id: "en-CA-ClaraNeural", label: "Clara（加式，女）" },
  { id: "en-IN-NeerjaNeural", label: "Neerja（印式，女）" },
];

export const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
```

- [ ] **Step 3: 运行安装并构建**

```bash
npm install
npm run build
```

Expected: build success, no new TS errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json lib/edge-tts-voices.ts
git commit -m "deps: add node-edge-tts and preset voice list

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 扩展数据模型与 Store 逻辑

**Files:**
- Modify: `lib/store.ts`

**Interfaces:**
- Consumes: `EDGE_TTS_VOICES` (Task 1).
- Produces: `NodeKind` 增加 `"audio"`；`CanvasNodeData` 增加 `voice?: string`；`onConnect` 允许 `audio→video`；`triggerGeneration` 收集音频 URL。

- [ ] **Step 1: 更新 `NodeKind` 与 `CanvasNodeData`**

```ts
// lib/store.ts
export type NodeKind = "text" | "image" | "video" | "upload" | "audio";

export interface CanvasNodeData extends Record<string, unknown> {
  kind: NodeKind;
  // ... existing fields
  voice?: string; // 音频节点选中音色
  referenceOrder?: string[];
  updatedAt?: number;
}
```

- [ ] **Step 2: 更新连线规则**

在 `onConnect` 中把 `isAllowed` 改为：

```ts
const isAllowed =
  (src === "text" && (tgt === "image" || tgt === "video")) ||
  (src === "image" && (tgt === "video" || tgt === "image")) ||
  (src === "upload" && (tgt === "image" || tgt === "video")) ||
  (src === "audio" && tgt === "video");
```

并把 `role` 判断改为：

```ts
let role: Edge["data"]["role"] = "reference";
if ((src === "image" || src === "upload") && tgt === "video") role = "first-frame";
if (src === "audio" && tgt === "video") role = "audio";
```

- [ ] **Step 3: 在 `triggerGeneration` 中收集音频 URL**

在视频生成分支前，遍历上游边时新增：

```ts
const audioUrls: string[] = [];
for (const e of s.edges) {
  if (e.target !== nodeId) continue;
  const src = s.nodes.find((n) => n.id === e.source);
  if (!src) continue;
  if (src.data.prompt) prompt = prompt || src.data.prompt;
  if (src.data.kind === "audio" && src.data.remoteUrl) {
    audioUrls.push(src.data.remoteUrl);
  }
  if ((src.data.kind === "image" || src.data.kind === "upload") && src.data.remoteUrl) {
    imageRefs.push({ id: src.id, url: src.data.remoteUrl });
  }
}
```

视频请求体增加 `audioUrls`：

```ts
body: JSON.stringify({
  projectId: s.projectId,
  nodeId,
  prompt,
  image: firstFrameUrl,
  referenceUrls: imageUrls,
  audioUrls,
  seconds: data.seconds,
  aspectRatio: data.aspectRatio,
  negativePrompt: data.negativePrompt,
  seed: data.seed,
  model: data.model,
})
```

- [ ] **Step 4: Build + Commit**

```bash
npm run build
git add lib/store.ts
git commit -m "feat: add audio node kind, allow audio->video edges, collect audio URLs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 创建 TTS API

**Files:**
- Create: `app/api/generate/audio/route.ts`

**Interfaces:**
- Consumes: `node-edge-tts` `EdgeTTS`, `saveRemoteMedia` (for URL saving) or local save helper。
- Produces: `POST /api/generate/audio` returns `{ ok: true, mediaId, url }`。

- [ ] **Step 1: 实现路由**

```ts
// app/api/generate/audio/route.ts
import { NextRequest, NextResponse } from "next/server";
import { EdgeTTS } from "node-edge-tts";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { updateNodeData, newId, nowTs } from "@/lib/db";
import { MEDIA_DIR } from "@/lib/db";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { projectId, nodeId, text, voice = "zh-CN-XiaoxiaoNeural" } = body as {
      projectId: string;
      nodeId: string;
      text: string;
      voice?: string;
    };

    if (!text || !text.trim()) {
      return NextResponse.json({ error: "文本不能为空" }, { status: 400 });
    }

    updateNodeData(nodeId, { status: "generating", error: undefined });

    const tts = new EdgeTTS({ voice, outputFormat: "audio-24khz-48kbitrate-mono-mp3" });
    const fileName = `audio-${randomUUID()}.mp3`;
    mkdirSync(MEDIA_DIR, { recursive: true });
    const filePath = path.join(MEDIA_DIR, fileName);

    await tts.ttsPromise(text.trim(), filePath);

    const stat = await import("node:fs/promises").then((m) => m.stat(filePath));
    const relativePath = path.relative(process.cwd(), filePath);
    const id = newId();

    getDb()
      .prepare("INSERT INTO media (id, type, remote_url, local_path, mime_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, "audio", null, relativePath, "audio/mpeg", stat.size, nowTs());

    updateNodeData(nodeId, {
      status: "done",
      mediaId: id,
      remoteUrl: `/api/media/${id}`,
      updatedAt: nowTs(),
    });

    // 注意：gen_tasks.kind 目前只有 image/video，音频任务不写入 gen_tasks，只更新节点状态即可。

    return NextResponse.json({ ok: true, mediaId: id, url: `/api/media/${id}` });
  } catch (error) {
    const message = (error as Error).message;
    try {
      const body = await req.json();
      if (body?.nodeId) updateNodeData(body.nodeId, { status: "failed", error: message });
    } catch { /* ignore */ }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**注意：** `gen_tasks.kind` 目前只有 `"image" | "video"`。如果音频任务不适合写入 `gen_tasks`，可删除该 `upsertGenTask` 调用，只保存 `media` 表并更新节点状态。

- [ ] **Step 2: 本地测试 API**

```bash
curl -s -X POST http://localhost:3001/api/generate/audio \
  -H "Content-Type: application/json" \
  -d '{"projectId":"test","nodeId":"audio-test","text":"你好世界","voice":"zh-CN-XiaoxiaoNeural"}'
```

Expected: JSON with `mediaId` and `url`。

- [ ] **Step 3: Build + Commit**

```bash
npm run build
git add app/api/generate/audio/route.ts
git commit -m "feat: add /api/generate/audio endpoint using node-edge-tts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 创建音频节点 UI 并注册

**Files:**
- Create: `components/AudioNode.tsx`
- Modify: `app/page.tsx`
- Modify: `components/NodeShell.tsx`

**Interfaces:**
- Consumes: `EDGE_TTS_VOICES`, `DEFAULT_EDGE_VOICE`。
- Produces: `AudioNodeView` component used in `nodeTypes`。

- [ ] **Step 1: 创建 `AudioNode.tsx`**

```tsx
"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useCanvasStore } from "@/lib/store";
import { EDGE_TTS_VOICES, DEFAULT_EDGE_VOICE } from "@/lib/edge-tts-voices";

export function AudioNodeView({ id, data, selected }: NodeProps) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [customVoice, setCustomVoice] = useState("");
  const [busy, setBusy] = useState(false);

  const voice = (data.voice as string) || DEFAULT_EDGE_VOICE;
  const isCustom = !EDGE_TTS_VOICES.some((v) => v.id === voice);
  const text = (data.prompt as string) || "";
  const mediaId = data.mediaId as string | undefined;
  const status = data.status as string | undefined;

  const generate = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/generate/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: useCanvasStore.getState().projectId, nodeId: id, text, voice }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "生成失败");
      updateNodeData(id, { mediaId: json.mediaId, remoteUrl: json.url });
    } catch (error) {
      updateNodeData(id, { status: "failed", error: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <NodeShell kind="audio" nodeId={id} title="音频" selected={selected} status={status === "generating" ? "生成中…" : undefined}>
      <div className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
          placeholder="输入要合成语音的文本"
          rows={3}
          className="w-full resize-none rounded border border-slate-200 bg-slate-50 p-2 text-xs"
        />
        <select
          value={isCustom ? "__custom__" : voice}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "__custom__") {
              updateNodeData(id, { voice: customVoice || DEFAULT_EDGE_VOICE });
            } else {
              updateNodeData(id, { voice: value });
            }
          }}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs"
        >
          {EDGE_TTS_VOICES.map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
          <option value="__custom__">自定义音色</option>
        </select>
        {isCustom && (
          <input
            value={customVoice || voice}
            onChange={(e) => {
              setCustomVoice(e.target.value);
              updateNodeData(id, { voice: e.target.value });
            }}
            placeholder="输入 Edge voice name"
            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs"
          />
        )}
        <button
          onClick={generate}
          disabled={busy || !text.trim()}
          className={`rounded px-2.5 py-1 text-[11px] font-medium text-white ${busy || !text.trim() ? "bg-slate-300" : "bg-emerald-500 hover:bg-emerald-600"}`}
        >
          {busy ? "合成中…" : mediaId ? "重新生成" : "生成语音"}
        </button>
        {mediaId && (
          <audio src={`/api/media/${mediaId}`} controls className="w-full" />
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !bg-slate-400" />
    </NodeShell>
  );
}
```

- [ ] **Step 2: 注册节点类型与工具栏**

`app/page.tsx`：

```ts
import { AudioNodeView } from "@/components/AudioNode";

const nodeTypes = {
  text: TextNodeView,
  image: ImageNodeView,
  video: VideoNodeView,
  upload: UploadNodeView,
  audio: AudioNodeView,
};
```

工具栏增加按钮：

```tsx
<button onClick={() => handleAddNode("audio")} className="rounded-md bg-emerald-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-600">
  + 音频
</button>
```

- [ ] **Step 3: 更新 `NodeShell.tsx` 调色板**

```ts
const palette: Record<NodeKind, { border: string; header: string; dot: string }> = {
  // ... existing
  audio: { border: "border-emerald-400", header: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
};
```

由于 `AudioNodeView` 自己画了 handle，`NodeShell` 里对 audio 的 handle 逻辑可以不动；但为了不重复，也可在 `NodeShell` 中 audio 不画 handle。这里选择由 `AudioNodeView` 自己画，避免 `NodeShell` 同时画两个 handle。

- [ ] **Step 4: Build + Commit**

```bash
npm run build
git add components/AudioNode.tsx app/page.tsx components/NodeShell.tsx
git commit -m "feat: add audio node UI and register node type

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 视频节点透传音频参考

**Files:**
- Modify: `app/api/generate/video/route.ts`
- Modify: `lib/agnes-video.ts`
- Modify: `types/agnes.ts`

**Interfaces:**
- Consumes: `audioUrls: string[]` from store。
- Produces: `AgnesCreateVideoBody.audios`。

- [ ] **Step 1: 更新类型**

```ts
// types/agnes.ts
export interface CreateVideoInput {
  mode: GenerationMode;
  prompt: string;
  image?: string;
  images?: string[];
  audios?: string[]; // 新增
  seconds?: string;
  aspect_ratio?: string;
  // ...
}

export interface AgnesCreateVideoBody {
  // ...
  images?: string[];
  audios?: string[]; // 新增
  // ...
}
```

- [ ] **Step 2: 更新视频生成路由**

`app/api/generate/video/route.ts`：

```ts
const { projectId, nodeId, prompt, image, referenceUrls = [], audioUrls = [], seconds, aspectRatio, negativePrompt, seed, model } = body as {
  // ...
  audioUrls?: string[];
  // ...
};
```

Agnes 分支的 `input` 增加 `audios`：

```ts
const input = {
  mode: mode as "text" | "image" | "keyframes",
  prompt: prompt.trim(),
  image: images.length === 1 ? images[0] : image,
  images: images.length >= 2 ? images : undefined,
  audios: audioUrls.filter(Boolean),
  seconds,
  aspect_ratio: aspectRatio,
  negative_prompt: negativePrompt,
  seed,
};
```

- [ ] **Step 3: 更新 `lib/agnes-video.ts`**

在 2.5-flash 分支下，reference 判断后增加：

```ts
if (input.audios && input.audios.length > 0) {
  body.audios = input.audios.slice(0, 1); // Agnes 目前一般传 1 条音频
}
```

旧版 v2.0 不支持 `audios`，不处理。

- [ ] **Step 4: Build + Commit**

```bash
npm run build
git add types/agnes.ts app/api/generate/video/route.ts lib/agnes-video.ts
git commit -m "feat: pass audio references through to Agnes video request

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 配置面板展示音频参考

**Files:**
- Modify: `components/NodeConfigPanel.tsx`

**Interfaces:**
- Consumes: upstream edges/nodes。
- Produces: 视频节点显示音频上游，音频节点显示生成控制。

- [ ] **Step 1: 在视频节点上游参考区显示音频**

在 `VideoUpstreamList` 中，把 `audio` 节点单独列出：

```ts
const audioUpstream = upstream.filter(({ node }) => node!.data.kind === "audio");
```

渲染音频芯片：

```tsx
{audioUpstream.length > 0 && (
  <div className="mb-2 flex flex-wrap gap-2">
    {audioUpstream.map(({ edge }) => (
      <div key={edge.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
        <span className="flex h-8 w-8 items-center justify-center rounded bg-emerald-100 text-[10px] text-emerald-600">音</span>
        <span className="text-[10px] text-slate-500">音频参考</span>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 2: 为音频节点增加配置区**

在 `NodeConfigPanel` 中新增 `{data.kind === "audio" && (...)}` 区块，提供与 `AudioNode.tsx` 中相同的文本输入、音色选择、生成按钮。如果 `AudioNode.tsx` 已经自包含完整控制，配置面板可只显示状态和播放；但为了统一，保留简单状态展示即可。推荐做法：节点自身负责主要交互，配置面板只展示上游参考和重新生成按钮。

- [ ] **Step 3: Build + Commit**

```bash
npm run build
git add components/NodeConfigPanel.tsx
git commit -m "feat: show audio references in video node config panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 时间线绑定音频与导出混音

**Files:**
- Modify: `lib/store.ts` (`TimelineClipState`)
- Modify: `components/TimelinePanel.tsx`
- Modify: `app/api/export/route.ts`

**Interfaces:**
- Consumes: done audio nodes, done video clips。
- Produces: exported mp4 with mixed audio。

- [ ] **Step 1: 扩展时间线片段类型**

```ts
// lib/store.ts
export interface TimelineClipState {
  id: string;
  nodeId: string;
  mediaId: string;
  order: number;
  trimIn: number;
  trimOut: number | null;
  audioMediaId?: string;
  audioVolume?: number;
}
```

- [ ] **Step 2: 更新 `TimelinePanel.tsx`**

- 已完成音频节点列表作为可加入时间线的按钮。
- 每个视频片段行增加音频选择下拉框，选项为所有已完成音频节点：`nodes.filter(n => n.data.kind === "audio" && n.data.status === "done" && n.data.mediaId)`。
- 选择后更新 `clip.audioMediaId`。
- 保存时包含新字段（已自动包含在 JSON 序列化中）。

- [ ] **Step 3: 更新导出接口接收完整 clip 对象**

`app/api/export/route.ts` 当前接收的 `clips` 只有 `trimIn/trimOut`。改为接收完整 clip 以读取 `audioMediaId`：

```ts
async function runExport(
  job: ExportJob,
  clips: Array<{ trimIn: number; trimOut: number | null; audioMediaId?: string; audioVolume?: number }>,
  media: Array<{ id: string; localPath?: string; mimeType?: string }>,
) { ... }
```

混音逻辑（在每个 segment 转码时）：

```ts
const args = ["-y", "-i", src];
const audioMediaId = clips[i].audioMediaId;
const audioRecord = audioMediaId ? getMediaById(audioMediaId) : undefined;
if (audioRecord?.localPath) {
  args.push("-i", path.join(process.cwd(), audioRecord.localPath));
  args.push("-shortest", "-map", "0:v:0", "-map", "1:a:0");
} else {
  // 保持原逻辑
}
args.push(
  "-vf", "scale=1152:768:force_original_aspect_ratio=decrease,pad=1152:768:(ow-iw)/2:(oh-ih)/2",
  "-r", "24",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
  "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
  "-video_track_timescale", "600",
  seg,
);
```

注意：`-shortest` 保证音频/视频较短者决定时长。如果音频比视频短，视频会在音频结束后静音；如果音频长，会截断到视频长度。

- [ ] **Step 4: Build + Commit**

```bash
npm run build
git add lib/store.ts components/TimelinePanel.tsx app/api/export/route.ts
git commit -m "feat: bind audio to timeline clips and mix audio on export

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 全量回归与部署

**Files:**
- All modified

- [ ] **Step 1: 本地测试**

1. 创建音频节点，输入文本，选择音色，点击生成语音 → 节点内可播放。
2. 把音频节点连到视频节点，生成视频 → 查看 `/api/generate/video` 日志中 `audios` 字段非空。
3. 把生成好的视频加入时间线，给片段绑定音频，导出成片 → 确认导出视频带声音。

- [ ] **Step 2: 构建并部署**

```bash
npm run build
docker compose up -d --build
```

- [ ] **Step 3: 验证服务**

```bash
docker ps --filter name=infinite-canvas
```

Expected: `infinite-canvas` status `Up`。

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: build and deploy audio node + video audio reference

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review Checklist

- [ ] Spec coverage：每个需求（音频节点、视频参考、时间线混音）都有对应任务。
- [ ] Placeholder scan：无 TBD/TODO，每步都有代码或命令。
- [ ] 类型一致性：`CanvasNodeData.voice`、`TimelineClipState.audioMediaId`、`CreateVideoInput.audios`、`AgnesCreateVideoBody.audios` 命名一致。
- [ ] 无过度设计：暂不支持音频片段独立加入时间线，只支持绑定到视频片段，符合 YAGNI。
