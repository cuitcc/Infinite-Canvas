# 短剧制作 Agent 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画布内置短剧 Agent：输入主题 → 自动大纲 → 风格库选择（唯一暂停点）→ 自动资产生成 → 自动分镜+台词 → 串行生成分镜视频 → 自动填时间线，全程在画布长出真实节点流水线。

**Architecture:** 前端编排器（`lib/agent-orchestrator.ts`）驱动 zustand store 创建/连线真实节点并复用 `triggerGeneration` 与现有生成 API；规划类 LLM 调用走新路由 `/api/agent/plan`（Agnes chat，输出 JSON）；视频完成状态复用现有服务端 poller + `/api/tasks` 前端 2s 拉取（编排器轮询 store 节点 status 即可）。

**Tech Stack:** Next.js 16 App Router、React 19、@xyflow/react、zustand、Agnes API（chat/image/video）。

## Global Constraints

- spec：`docs/superpowers/specs/2026-09-02-short-drama-agent-design.md`（先读它）
- 不新增画布节点类型；Agent 产出全部用现有 text/image/video 节点
- 分镜 video 节点只连角色立绘作参考图（**不连场景图**，保住台词绑定 refs==lines）
- 生成一律走现有 `/api/generate/image`、`/api/generate/video`（含 429 重试、台词注入、一致性后缀），编排器不自己拼请求体调 Agnes
- 视频串行生成：上一镜节点 done/failed 后才创建下一镜
- UI 文案全部中文；顶栏入口「🎬 短剧 Agent」
- 本 Next.js 版本有破坏性变更：动手前读 `node_modules/next/dist/docs/` 相关指南（AGENTS.md 要求）
- 无测试框架：每个任务的验证 = `npx tsc --noEmit` 零错误 + 指定 curl/`node --experimental-strip-types` 冒烟
- 部署验证一律 `http://localhost:3001`

---

### Task 1: 风格库数据与缩略图

**Files:**
- Create: `lib/style-library.ts`
- Create: `scripts/gen-style-thumbs.mjs`
- Create: `public/styles/.gitkeep`

**Interfaces:**
- Produces: `STYLE_LIBRARY: StyleEntry[]`（`{id,name,category:"2d"|"3d"|"real",prompt,thumb}`）、`STYLE_CATEGORIES`，后续 Task 5 面板直接 import。

- [ ] **Step 1: 写 `lib/style-library.ts`**

15 个风格，id 用 kebab-case（缩略图文件名 = `<id>.png`）。每条 prompt 是可直接拼接的中文风格描述（60 字内）。风格集合（category 括注）：
`crayon-kids`儿童蜡笔手绘(2d)、`shadow-puppet`皮影戏(2d)、`showa-anime`90年代日式动画(2d)、`mono-manga`黑白二维漫画(2d)、`ink-wash`中国水墨动画(2d)、`ghibli-pastoral`吉卜力田园水彩(2d)、`american-comic`美式漫画(2d)、`pixar-family`3D合家欢动画(3d)、`cinematic-cg`3D写实电影CG(3d)、`claymation`黏土定格动画(3d)、`xianxia-cg`国风仙侠CG(3d)、`urban-idol`都市偶像真人剧(real)、`wuxia-film`古装武侠真人电影(real)、`noir-drama`悬疑暗调真人剧(real)、`hk-retro`90年代港片(real)。

```ts
export interface StyleEntry {
  id: string;
  name: string;
  category: "2d" | "3d" | "real";
  prompt: string;
  thumb: string;
}

export const STYLE_CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "2d", label: "2D" },
  { key: "3d", label: "3D" },
  { key: "real", label: "真人" },
] as const;

export const STYLE_LIBRARY: StyleEntry[] = [
  { id: "crayon-kids", name: "儿童蜡笔手绘", category: "2d", prompt: "儿童蜡笔手绘画风,粗线条涂鸦质感,色彩鲜艳明快,童趣盎然", thumb: "/styles/crayon-kids.png" },
  // ……其余 14 条同构,thumb 一律 `/styles/<id>.png`
];

export function styleThumbSrc(style: StyleEntry): string {
  return style.thumb;
}
```

（实现者按上面集合补全 15 条完整 prompt。）

- [ ] **Step 2: 写 `scripts/gen-style-thumbs.mjs`（一次性脚本,入仓库便于重跑）**

```js
// 用法: node scripts/gen-style-thumbs.mjs   (需 .env 里 AGNES_API_KEY;已存在的缩略图跳过)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const KEY = env.AGNES_API_KEY;
const BASE = env.AGNES_API_BASE_URL || "https://api.agnes-ai.cn/v1";
// 从 lib/style-library.ts 正则抽出 id+name+prompt,避免引入 TS 运行时
const src = readFileSync("lib/style-library.ts", "utf8");
const entries = [...src.matchAll(/id: "([\w-]+)", name: "([^"]+)", category: "\w+", prompt: "([^"]+)"/g)].map(m => ({ id: m[1], name: m[2], prompt: m[3] }));

for (const { id, name, prompt } of entries) {
  const out = resolve("public/styles", `${id}.png`);
  if (existsSync(out)) { console.log("skip", id); continue; }
  const res = await fetch(`${BASE.replace("/v1", "")}/v1/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "agnes-image-2.5", prompt: `${prompt},单张风格示意插画,无文字`, size: "1K", n: 1 }),
  });
  const json = await res.json();
  const url = json?.data?.[0]?.url;
  if (!url) { console.error("FAIL", id, JSON.stringify(json).slice(0, 200)); continue; }
  const img = await fetch(url);
  writeFileSync(out, Buffer.from(await img.arrayBuffer()));
  console.log("ok", id, name);
}
```

（注意：端点/模型名以 `lib/agnes-image.ts` 现有实现为准——实现者先读它，把 URL、body 字段改成与之一致，上面的只是骨架。）

- [ ] **Step 3: 跑通验证**

```bash
npx tsc --noEmit
node scripts/gen-style-thumbs.mjs   # 预期 public/styles/ 下生成 15 张 png(个别失败可重跑,脚本跳过已有)
ls public/styles | wc -l            # 预期 ≥ 15
```

- [ ] **Step 4: Commit** `feat: style library data and thumbnail generator for short-drama agent`

---

### Task 2: `/api/agent/plan` 规划路由

**Files:**
- Create: `lib/agent-prompts.ts`
- Create: `app/api/agent/plan/route.ts`

**Interfaces:**
- Consumes: `createAgnesChatCompletion({messages, model?})`（`lib/agnes-chat.ts`，返回 string）
- Produces: `POST /api/agent/plan` body `{task:"outline"|"assets"|"storyboard", input:string, shotCount?:number}` → `{ok:true, data:<object>}`；`extractJson(raw:string):unknown`（导出，供复用/测试）。

- [ ] **Step 1: 写 `lib/agent-prompts.ts`（三个 system + JSON 提取）**

```ts
export const PLAN_SYSTEMS: Record<string, string> = {
  outline: `你是短剧编剧。根据用户给的主题创作单集短剧大纲。只输出 JSON,不要任何解释或代码块标记,格式:
{"title":"片名","genre":"类型","synopsis":"100字内剧情梗概","characters":[{"name":"角色名","appearance":"外貌/年龄/服装细节,40字内,用于生成角色立绘"}],"scenes":[{"name":"场景名","description":"场景视觉描述,30字内"}],"script":"分场剧情与对白全文,每行格式 角色名：台词,600字内"}
要求:2-3个角色,2-3个场景,剧情有起承转合,对白自然口语。`,
  assets: `你是美术指导。根据输入的剧本大纲 JSON,列出需要生成的视觉资产。只输出 JSON,格式:
{"assets":[{"kind":"character","name":"与大纲角色名一致","prompt":"白底全身立绘提示词:外貌+发型+服装+表情,60字内"},{"kind":"scene","name":"场景名","prompt":"场景概念图提示词,无人物,60字内"}]}
要求:角色 2-3 个、场景 2-3 个;道具仅在剧情必需时加(kind:"prop"),最多 2 个。`,
  storyboard: `你是短剧分镜师。根据输入的剧本大纲 JSON 与资产列表,输出分镜脚本。只输出 JSON,格式:
{"shots":[{"index":1,"description":"画面描述:出场人物(用'参考图N人物'指代,N 按 characters 数组顺序从1编号)+动作+表情+运镜(摇镜/跟拍/推近/拉远),100字内","characters":["按出场顺序的角色名"],"dialogue":["角色名：台词"]}]}
要求:分镜数严格等于用户指定的数量;首镜交代开场,末镜收束;description 中的'参考图N'编号必须与 characters 数组顺序一致;dialogue 行数不超过 characters 数,可空数组(无对白镜头);相邻镜动作衔接。`,
};

/** 从模型输出中提取第一个完整 JSON 对象(容忍 ```json 围栏与前后缀文本) */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  if (start === -1) throw new Error("输出中未找到 JSON");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("JSON 不完整");
}
```

- [ ] **Step 2: 写 `app/api/agent/plan/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { PLAN_SYSTEMS, extractJson } from "@/lib/agent-prompts";

function buildUser(task: string, input: string, shotCount?: number): string {
  if (task === "storyboard") {
    const { outline, assetNames, count } = JSON.parse(input) as { outline: unknown; assetNames: string[]; count: number };
    return `分镜数量:${count}\n剧本大纲:\n${JSON.stringify(outline)}\n可用资产:${assetNames.join("、")}`;
  }
  return shotCount ? `${input}\n(分镜数量备用:${shotCount})` : input;
}

export async function POST(req: NextRequest) {
  try {
    const { task, input, shotCount } = (await req.json()) as { task?: string; input?: string; shotCount?: number };
    const system = task ? PLAN_SYSTEMS[task] : undefined;
    if (!system || !input?.trim()) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await createAgnesChatCompletion({
          messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount) }],
        });
        return NextResponse.json({ ok: true, data: extractJson(raw) });
      } catch (e) {
        lastErr = e as Error;
      }
    }
    return NextResponse.json({ error: `规划失败:${lastErr?.message ?? "未知错误"}` }, { status: 502 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 3: 冒烟验证**

```bash
npx tsc --noEmit
# 部署前可跳过 curl;Task 6 部署后回归验证:
curl -s -X POST http://localhost:3001/api/agent/plan -H "Content-Type: application/json" \
  -d '{"task":"outline","input":"穿越到古代的现代姐妹重逢"}' | head -c 400
```

- [ ] **Step 4: Commit** `feat: agent plan route with outline/assets/storyboard prompts`

---

### Task 3: store 扩展 + 编排器（大纲/风格/资产阶段）

**Files:**
- Modify: `lib/store.ts`（追加 agentState 类型与字段、`setAgentState` action）
- Create: `lib/agent-orchestrator.ts`

**Interfaces:**
- Consumes: store 现有 `addNode/updateNodeData/onConnect/triggerGeneration/setTimeline/nodes/edges/projectId`
- Produces（Task 4/5 依赖，签名固定）:
  - `runAgent(theme: string, shotCount: number, aspectRatio: string): Promise<void>`
  - `chooseStyle(styleName: string, stylePrompt: string): Promise<void>`（style 阶段由面板调用,接续 assets→storyboard→shots→assembly）
  - `abortAgent(): void`
  - store 字段 `agentState: AgentState | null`、action `setAgentState(patch: Partial<AgentState>)`

- [ ] **Step 1: store 追加类型与状态（不动现有逻辑）**

在 `lib/store.ts` 末尾接口区前加入类型，`CanvasStore` 接口加 `agentState` 与 `setAgentState`，create() 里加实现：

```ts
export type AgentStage = "idle" | "outline" | "style" | "assets" | "storyboard" | "shots" | "assembly" | "done" | "aborted";
export interface AgentAsset { id: string; kind: "character" | "scene" | "prop"; name: string; prompt: string; nodeId: string | null; status: "pending" | "running" | "done" | "failed"; }
export interface AgentShot { index: number; description: string; dialogue: string[]; characters: string[]; scene: string; nodeId: string | null; status: "pending" | "running" | "done" | "failed" | "skipped"; }
export interface AgentState {
  stage: AgentStage; theme: string; shotCount: number; aspectRatio: string;
  styleName: string; stylePrompt: string; outlineNodeId: string | null;
  assets: AgentAsset[]; shots: AgentShot[]; error: string | null;
}
```

```ts
agentState: null,
setAgentState: (patch) => set((s) => ({ agentState: s.agentState ? { ...s.agentState, ...patch } : s.agentState, dirty: true })),
```

- [ ] **Step 2: 写 `lib/agent-orchestrator.ts`**

```ts
"use client";
import { useCanvasStore, type AgentAsset, type AgentShot, type CanvasNodeData } from "./store";

type Outline = { title: string; genre: string; synopsis: string; characters: { name: string; appearance: string }[]; scenes: { name: string; description: string }[]; script: string };
type OutlineAsset = { kind: "character" | "scene" | "prop"; name: string; prompt: string };
type Storyboard = { shots: { index: number; description: string; characters: string[]; dialogue: string[] }[] };

let aborted = false;
let nodeSeq = 0;
const agentNodeId = (p: string) => `agent-${p}-${Date.now().toString(36)}-${nodeSeq++}`;

function patch(patchObj: Partial<import("./store").AgentState>) { useCanvasStore.getState().setAgentState(patchObj); }

async function plan<T>(task: string, input: string, shotCount?: number): Promise<T> {
  const res = await fetch("/api/agent/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, input, shotCount }) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "规划失败");
  return json.data as T;
}

function addAgentNode(kind: "text" | "image" | "video", position: { x: number; y: number }, data: Partial<CanvasNodeData>): string {
  const id = agentNodeId(kind);
  useCanvasStore.getState().addNode({ id, type: kind, position, data: { kind, label: "", ...data } as CanvasNodeData });
  return id;
}

function connect(source: string, target: string) {
  useCanvasStore.getState().onConnect({ source, target, sourceHandle: null, targetHandle: null });
}

async function waitForNode(nodeId: string, timeoutMs = 15 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (aborted) return false;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    if (node?.data.status === "done") return true;
    if (node?.data.status === "failed") return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function generateAndAwait(nodeId: string): Promise<boolean> {
  useCanvasStore.getState().triggerGeneration(nodeId);
  const ok = await waitForNode(nodeId);
  if (!ok && !aborted) { // 失败自动重试一次
    patchErr(nodeId, undefined);
    useCanvasStore.getState().triggerGeneration(nodeId);
    return waitForNode(nodeId);
  }
  return ok;
}
const patchErr = (nodeId: string, error?: string) => useCanvasStore.getState().updateNodeData(nodeId, { error, status: "queued" });

export function abortAgent() { aborted = true; patch({ stage: "aborted" }); }

function outlineToText(o: Outline): string {
  const chars = o.characters.map((c) => `${c.name}（${c.appearance}）`).join("；");
  const scenes = o.scenes.map((s) => `${s.name}：${s.description}`).join("；");
  return `《${o.title}》(${o.genre})\n梗概：${o.synopsis}\n角色：${chars}\n场景：${scenes}\n\n${o.script}`;
}

export async function runAgent(theme: string, shotCount: number, aspectRatio: string) {
  aborted = false;
  const st = useCanvasStore.getState();
  if (!st.projectId || !theme.trim()) return;
  patch({ stage: "outline", theme, shotCount, aspectRatio, assets: [], shots: [], error: null, outlineNodeId: null });
  try {
    const outline = await plan<Outline>("outline", theme);
    if (aborted) return;
    const outlineNodeId = addAgentNode("text", { x: 0, y: 0 }, { label: `剧本大纲·${outline.title}`, prompt: outlineToText(outline) });
    patch({ outlineNodeId, stage: "style" }); // 停:面板弹风格库,用户选后调 chooseStyle
  } catch (e) {
    patch({ stage: "idle", error: (e as Error).message });
  }
}

export async function chooseStyle(styleName: string, stylePrompt: string) {
  const s0 = useCanvasStore.getState().agentState;
  if (!s0?.outlineNodeId) return;
  aborted = false;
  patch({ styleName, stylePrompt, stage: "assets" });
  try {
    const outlineNode = useCanvasStore.getState().nodes.find((n) => n.id === s0.outlineNodeId);
    const outline = { script: outlineNode?.data.prompt ?? "" } as unknown; // plan 端只需要文本
    // assets 阶段
    const outlineJson = await plan<Outline>("outline", s0.theme).catch(() => null); // 复用大纲 JSON(重取一次,保证结构化)
    const { assets } = await plan<{ assets: OutlineAsset[] }>("assets", JSON.stringify(outlineJson ?? outline));
    if (aborted) return;
    const assetList: AgentAsset[] = assets.map((a, i) => ({ id: `a${i}`, kind: a.kind, name: a.name, prompt: a.prompt, nodeId: null, status: "pending" }));
    patch({ assets: assetList });
    for (let i = 0; i < assetList.length; i++) {
      if (aborted) return;
      const a = assetList[i];
      const nodeId = addAgentNode("image", { x: 400, y: i * 320 }, { label: `${a.kind === "character" ? "角色" : a.kind === "scene" ? "场景" : "道具"}-${a.name}`, prompt: `${stylePrompt},${a.prompt}` });
      connect(s0.outlineNodeId!, nodeId);
      patch({ assets: assetList.map((x, j) => j === i ? { ...x, nodeId, status: "running" } : x) });
      const ok = await generateAndAwait(nodeId);
      patch({ assets: assetList.map((x, j) => j === i ? { ...x, status: ok ? "done" : "failed" } : x) });
    }
    await runStoryboardAndShots(stylePrompt);
  } catch (e) {
    patch({ error: (e as Error).message, stage: "style" });
  }
}

async function runStoryboardAndShots(stylePrompt: string) {
  const s = useCanvasStore.getState().agentState!;
  if (aborted) return;
  patch({ stage: "storyboard" });
  const outlineNode = useCanvasStore.getState().nodes.find((n) => n.id === s.outlineNodeId);
  const assetNames = s.assets.filter((a) => a.kind === "character").map((a) => a.name);
  const shotsPlan = await plan<Storyboard>("storyboard", JSON.stringify({ outline: outlineNode?.data.prompt, assetNames, count: s.shotCount }), s.shotCount);
  const shots: AgentShot[] = shotsPlan.shots.map((sh, i) => ({ index: sh.index ?? i + 1, description: sh.description, dialogue: sh.dialogue ?? [], characters: sh.characters ?? [], scene: "", nodeId: null, status: "pending" }));
  patch({ shots, stage: "shots" });
  const charNodes = new Map<string, string>();
  for (const a of s.assets) if (a.kind === "character" && a.nodeId && a.status === "done") charNodes.set(a.name, a.nodeId);

  for (let i = 0; i < shots.length; i++) {
    if (aborted) return;
    const shot = shots[i];
    const nodeId = addAgentNode("video", { x: 800, y: i * 320 }, {
      label: `第${shot.index}镜`,
      prompt: `${stylePrompt},${shot.description}`,
      dialogue: shot.dialogue.length ? shot.dialogue.join("\n") : undefined,
      seconds: "10",
      aspectRatio: s.aspectRatio,
    });
    for (const cname of shot.characters) { const src = charNodes.get(cname); if (src) connect(src, nodeId); }
    patch({ shots: shots.map((x, j) => j === i ? { ...x, nodeId, status: "running" } : x) });
    const ok = await generateAndAwait(nodeId);
    patch({ shots: shots.map((x, j) => j === i ? { ...x, status: ok ? "done" : "skipped" } : x) });
  }

  // assembly:按序填时间线(仅成功的镜)
  if (aborted) return;
  patch({ stage: "assembly" });
  const stNow = useCanvasStore.getState();
  const clips = stNow.agentState!.shots
    .filter((sh) => sh.status === "done" && sh.nodeId)
    .map((sh, i) => {
      const node = stNow.nodes.find((n) => n.id === sh.nodeId);
      return { id: agentNodeId("clip"), nodeId: sh.nodeId!, mediaId: node?.data.mediaId ?? "", order: i, trimIn: 0, trimOut: null };
    })
    .filter((c) => c.mediaId);
  stNow.setTimeline([...stNow.timeline, ...clips]);
  patch({ stage: "done" });
}
```

（实现者可按编译器反馈微调类型导入；`CanvasNodeData` 里如缺 `seconds/aspectRatio` 字段,以 `lib/store.ts` 实际字段名为准——先读它。）

- [ ] **Step 3: 验证**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 4: Commit** `feat: agent orchestrator with outline/style/assets/storyboard/shots/assembly stages`

---

### Task 4: AgentPanel UI + 顶栏入口

**Files:**
- Create: `components/AgentPanel.tsx`
- Modify: `app/page.tsx`（顶栏加「🎬 短剧 Agent」按钮、render `<AgentPanel/>`）

**Interfaces:**
- Consumes: `runAgent/chooseStyle/abortAgent`、store `agentState`、`STYLE_LIBRARY/STYLE_CATEGORIES`

- [ ] **Step 1: 写 `components/AgentPanel.tsx`**

结构（完整实现,样式跟随现有面板的 tailwind 风格,参考 `components/NodeConfigPanel.tsx` 的 slide-over 写法）：

- 容器:`fixed right-0 top-0 z-50 h-full w-[400px] border-l border-slate-200 bg-white shadow-xl flex flex-col`,顶部标题「短剧 Agent」+ 关闭 ×;
- idle 态:主题 textarea(rows=4, placeholder「输入短剧主题或剧本…」)、分镜数 select(4/6/8/12,默认 8)、画面比例 select(9:16 默认/16:9)、「开始制作」按钮 → `runAgent(theme, shotCount, aspectRatio)`;
- outline/style 之间的进度列表:六个阶段行(①剧本大纲 ②风格选择 ③资产生成 ④分镜脚本 ⑤分镜视频 ⑥剪辑成片),状态图标 ○/◐/✓/✗,分镜阶段显示 `x/N` 计数;
- style 态:风格库网格(分类页签 全部/2D/3D/真人,`STYLE_LIBRARY.filter` 渲染卡片:缩略图 `<img src={style.thumb}>` onError 隐藏换灰底、名称;末尾「自定义风格」卡片 → 点击展开输入框+确定) → 点击卡片调 `chooseStyle(style.name, style.prompt)`;
- 运行态:中止按钮 → `abortAgent()`;
- done 态:提示「已填入时间线,打开底部时间线点导出生成成片」;
- error 非空时红字显示。

- [ ] **Step 2: page.tsx 接入**

顶栏(`app/page.tsx:201` 的 header 内,「⚙ 模型管理」按钮旁):

```tsx
const [showAgent, setShowAgent] = useState(false);
<button onClick={() => setShowAgent(true)} className="...与模型管理按钮同款样式">🎬 短剧 Agent</button>
```

`{showAgent && <AgentPanel onClose={() => setShowAgent(false)} />}`(组件内部用自己的 open prop 控制滑入动画)。

- [ ] **Step 3: 验证**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 4: Commit** `feat: agent panel UI with style library and top-bar entry`

---

### Task 5: 部署 + 端到端实测

**Files:** 无新代码(发现问题回改)

- [ ] **Step 1: 构建部署**

```bash
docker build --network=host -t infinite-canvas:latest . && docker compose up -d --no-build
curl -s -X POST http://localhost:3001/api/agent/plan -H "Content-Type: application/json" -d '{"task":"outline","input":"穿越到古代的现代姐妹重逢"}'
```

- [ ] **Step 2: 端到端冒烟(编排逻辑无法 curl,靠 UI 实测)**

用 DB 验证:让用户(或指导用户)在 UI 输入主题、选风格、等流水线跑完(分镜数选 4 缩短时长),然后:

```bash
docker cp infinite-canvas:/app/data/canvas.db /tmp/agent-e2e.db && \
docker cp infinite-canvas:/app/data/canvas.db-wal /tmp/agent-e2e.db-wal && \
python3 -c "
import sqlite3, json
con = sqlite3.connect('/tmp/agent-e2e.db')
rows = con.execute(\"select id,data from nodes where id like 'agent-%'\").fetchall()
print('agent nodes:', len(rows))
for r in rows: print(r[0], json.loads(r[1]).get('label'), json.loads(r[1]).get('status'))
print('timeline:', con.execute('select count(*) from timeline').fetchone())
"
```

预期:≥1 text + ≥4 image + 4 video 节点,连线正确(角色→分镜),timeline ≥1 条。

- [ ] **Step 3: 修问题并回归,Commit**（如有）

- [ ] **Step 4: 汇报**：把流水线截图/DB 结果交给用户人工验收(画质、剧情、口型)。

---

## Self-Review 结论

- 规格覆盖：spec 各节均有对应任务（风格库→T1，plan→T2，编排→T3，UI→T4，验收→T5）；台词注入/一致性后缀/429 重试为既有能力,复用不重做 ✓
- 占位符：Task 1 的 15 条风格 prompt 与 Task 4 的 JSX 细节为实现者按指定规则补全,已给出完整清单与结构约束,非 TBD ✓
- 类型一致性：`AgentState/AgentAsset/AgentShot`、`runAgent/chooseStyle/abortAgent` 签名在各任务间已对齐 ✓
- 已知风险：Agnes 图片模型名/端点以 `lib/agnes-image.ts` 为准(T1 已注明)；`CanvasNodeData` 字段名以 `lib/store.ts` 为准(T3 已注明)
