"use client";

import { fitShotReferences, resolveDialogueSpeakers, resolveShotCharacters, resolveShotScene } from "./shot-continuity";
import { completeScriptCast } from "./script-cast";

import { useCanvasStore, type AgentAsset, type AgentShot, type CanvasNodeData } from "./store";
import { assertDialogueCoverage, normalizeDialogueBody, clampVideoDuration, estimateShotDuration, groupDialogueLines, planShotDialogue, planShotContexts } from "./dialogue-plan";

import { appendNovelChapters, chapterContext, lockChapterIdentity, normalizeStory, splitNovelChapters, storyId, type StoryChapter, type StoryMode, type StoryOutline } from "./agent-story";

// ==================== 类型定义 ====================

type Outline = StoryOutline;

type OutlineAsset = { kind: "character" | "scene" | "prop"; name: string; prompt: string; voiceProfile?: string };

type Storyboard = {
  additionalCharacters?: StoryOutline["characters"];
  shots: { index: number; scene?: string; description: string; characters: string[]; dialogue: string[]; transition?: "cut" | "continue"; shotType?: AgentShot["shotType"]; purpose?: string; cutPoint?: string; lighting?: string; composition?: string; blocking?: string; emotion?: string; sound?: string; camera?: AgentShot["camera"] }[];
};

// ==================== 模块级状态 ====================

let aborted = false;
let executing = false;
let nodeSeq = 0;

const agentNodeId = (p: string) =>
  `agent-${p}-${Date.now().toString(36)}-${nodeSeq++}-${Math.random().toString(36).slice(2, 7)}`;

// ==================== 工具函数 ====================

/** 快速 patch agentState（合并式更新） */
function patch(patchObj: Partial<import("./store").AgentState>) {
  useCanvasStore.getState().setAgentState(patchObj);
}

/** 调用规划 API（outline / assets / storyboard） */
async function plan<T>(task: string, input: string, shotCount?: number, secondsPerShot?: string): Promise<T> {
  const res = await fetch("/api/agent/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, input, shotCount, secondsPerShot }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "规划失败");
  if (json.data == null) throw new Error(`${task} 规划返回为空`);
  return json.data as T;
}

/** 在画布上新增一个 Agent 生成的节点，返回节点 id */
function addAgentNode(
  kind: "text" | "image" | "video" | "audio",
  position: { x: number; y: number },
  data: Partial<CanvasNodeData>,
): string {
  const id = agentNodeId(kind);
  const state = useCanvasStore.getState().agentState;
  const chapter = state?.story?.chapters.find((c) => c.id === state.activeChapterId);
  const offsetX = chapter ? (chapter.number - 1) * 1400 : 0;
  useCanvasStore.getState().addNode({
    id,
    type: kind,
    position: { x: position.x + offsetX, y: position.y },
    data: { kind, label: "", chapterId: chapter?.id, chapterNumber: chapter?.number, storyId: state?.story?.id, ...data } as CanvasNodeData,
  });
  return id;
}

/** 连接两个节点（source → target） */
function connect(source: string, target: string) {
  useCanvasStore.getState().onConnect({
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
  });
}

/** 视频持续跟踪原任务；图片等待超时、任务失败或用户中止时返回 false。 */
async function waitForNode(nodeId: string, timeoutMs = 15 * 60_000): Promise<boolean> {
  let deadline = Date.now() + timeoutMs;
  while (!aborted) {
    if (aborted) return false;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    if (node?.data.status === "done") return true;
    if (!node || node.data.status === "failed") return false;
    if (Date.now() >= deadline) {
      if (node.data.kind !== "video") return false;
      // 页面后台节流可能错过 recent 时间窗。定点查询原任务，绝不因等待超时重建。
      try {
        const projectId = useCanvasStore.getState().projectId;
        const res = await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId ?? "")}&nodeId=${encodeURIComponent(nodeId)}`, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          const result = await res.json();
          const terminal = result.recent?.find((t: { node_id: string }) => t.node_id === nodeId);
          if (terminal?.status === "completed" && terminal.media_id) {
            useCanvasStore.getState().updateNodeData(nodeId, { status: "done", mediaId: terminal.media_id, error: undefined });
            return true;
          }
          if (terminal?.status === "failed") {
            useCanvasStore.getState().updateNodeData(nodeId, { status: "failed", error: terminal.error });
            return false;
          }
        }
      } catch { /* 查询失败保持等待；网络异常不代表上游任务失败 */ }
      deadline = Date.now() + 30_000;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** 触发节点生成并等待；失败自动重试一次，再失败返回 false */
async function generateAndAwait(nodeId: string): Promise<boolean> {
  // await 并兜住 triggerGeneration 的同步失败(节点丢失/projectId 为空等),避免 unhandled rejection 与死等超时
  try {
    await useCanvasStore.getState().triggerGeneration(nodeId);
  } catch (e) {
    console.error("[agent] triggerGeneration failed", nodeId, e);
    return false;
  }
  const ok = await waitForNode(nodeId);
  // 视频的提交重试由服务端持久化队列负责，不叠加客户端重试。
  if (!ok && !aborted && useCanvasStore.getState().nodes.find((n) => n.id === nodeId)?.data.kind !== "video") {
    // 失败自动重试一次：清掉 error，重置为 queued，再触发
    patchErr(nodeId, undefined);
    try {
      await useCanvasStore.getState().triggerGeneration(nodeId);
    } catch (e) {
      console.error("[agent] triggerGeneration retry failed", nodeId, e);
      return false;
    }
    return waitForNode(nodeId);
  }
  return ok;
}

const patchErr = (nodeId: string, error?: string) =>
  useCanvasStore.getState().updateNodeData(nodeId, { error, status: "queued" });

/** 文本模型偶尔把 script/characters/scenes 输出成结构化数组；统一成 Agent 后续阶段使用的稳定形状。 */
function normalizeOutline(raw: unknown): Outline {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const characters = Array.isArray(value.characters) ? value.characters.map((item, index) => {
    const c = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : `角色${index + 1}`,
      gender: typeof c.gender === "string" ? c.gender : "未知",
      age: typeof c.age === "string" ? c.age : undefined,
      role: typeof c.role === "string" ? c.role : undefined,
      relationship: typeof c.relationship === "string" ? c.relationship : undefined,
      personality: typeof c.personality === "string" ? c.personality : undefined,
      arc: typeof c.arc === "string" ? c.arc : undefined,
      appearance: typeof c.appearance === "string" ? c.appearance : "按角色设定保持一致",
      wardrobe: typeof c.wardrobe === "string" ? c.wardrobe : undefined,
      voiceProfile: typeof c.voiceProfile === "string" ? c.voiceProfile : "与该角色前镜保持同一音色",
    };
  }) : [];
  const scenes = Array.isArray(value.scenes) ? value.scenes.map((item, index) => {
    const s = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return { name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : `场景${index + 1}`, description: typeof s.description === "string" ? s.description : "按故事设定保持空间连续", socialContext: typeof s.socialContext === "string" ? s.socialContext : undefined };
  }) : [];
  let script = "";
  if (typeof value.script === "string") script = value.script;
  else if (Array.isArray(value.script)) script = value.script.map((line) => {
    if (typeof line === "string") return line;
    if (line && typeof line === "object") {
      const row = line as Record<string, unknown>;
      const speaker = typeof row.speaker === "string" ? row.speaker : typeof row.name === "string" ? row.name : "";
      const text = typeof row.text === "string" ? row.text : typeof row.dialogue === "string" ? row.dialogue : "";
      return speaker && text ? `${speaker}：${text}` : (typeof row.action === "string" ? `[${row.action}]` : "");
    }
    return "";
  }).filter(Boolean).join("\n");
  return {
    title: typeof value.title === "string" ? value.title : "未命名短剧",
    genre: typeof value.genre === "string" ? value.genre : "剧情",
    logline: typeof value.logline === "string" ? value.logline : undefined,
    theme: typeof value.theme === "string" ? value.theme : undefined,
    tone: typeof value.tone === "string" ? value.tone : undefined,
    synopsis: typeof value.synopsis === "string" ? value.synopsis : "",
    openingHook: typeof value.openingHook === "string" ? value.openingHook : undefined,
    worldRules: Array.isArray(value.worldRules) ? value.worldRules.filter((x): x is string => typeof x === "string") : [],
    characters,
    scenes,
    beats: Array.isArray(value.beats) ? value.beats as Outline["beats"] : [],
    script,
    endingState: typeof value.endingState === "string" ? value.endingState : undefined,
    continuationContext: typeof value.continuationContext === "string" ? value.continuationContext : undefined,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 分镜画面字段不能再次携带对白。视频模型会把同一句话同时当作画面动作和音频指令，
 * 结果就是重复念、乱续写，甚至把上一镜剧情重新演一遍。这里是进入视频节点前的最后一道防线。 */
function stripDialogueFromVisualDescription(value: unknown, dialogue: string[]): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const line of dialogue) {
    const split = line.search(/[：:]/);
    const body = (split >= 0 ? line.slice(split + 1) : line)
      .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, "")
      .replace(/[。！？!?～…\s]+$/, "")
      .trim();
    if (body.length < 3) continue;
    const escaped = escapeRegExp(body);
    text = text.replace(new RegExp(`[^。！？!?；\\n]*(?:自语|说道|说|喊道|问道|回答|回应)[^。！？!?；\\n]*${escaped}[^。！？!?；\\n]*[。！？!?；]?`, "g"), "");
    text = text.replace(new RegExp(escaped, "g"), "");
  }
  return text.replace(/\s{2,}/g, " ").replace(/。{2,}/g, "。 ").trim();
}

function cleanDialogueLine(line: string): string {
  const m = /^([^：:]+)[：:](.*)$/.exec(line.trim());
  if (!m) return line.trim();
  const body = normalizeDialogueBody(m[2]);
  return `${m[1].trim()}：${body}`;
}

/** 截取视频最后一帧并上传,返回图片 URL;任何失败返回 null(降级为不使用尾帧衔接)。
 * 用 /api/media/{id} 同源播放避开 canvas 跨域污染,无需 ffmpeg。 */
async function extractLastFrameUrl(mediaId: string): Promise<string | null> {
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = `/api/media/${mediaId}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("视频加载超时")), 30_000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error("视频加载失败")); };
    });
    // seek 到结尾前 0.15s,取最后一帧
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("seek 超时")), 15_000);
      video.onseeked = () => { clearTimeout(timer); resolve(); };
      video.currentTime = Math.max(0, (video.duration || 10) - 0.15);
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width) return null;
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return null;
    const form = new FormData();
    form.append("file", new File([blob], `agent-tail-${mediaId}.jpg`, { type: "image/jpeg" }));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const json = await res.json();
    if (!res.ok || !json.url) return null;
    return json.url as string;
  } catch (e) {
    console.warn("[agent] 截取上一镜尾帧失败,本镜降级为无尾帧衔接", e);
    return null;
  }
}

// ==================== 对外 API ====================

/** 中止当前 Agent 流程 */
export function abortAgent() {
  aborted = true;
  const cur = useCanvasStore.getState().agentState;
  const curStage = cur?.stage;
  if (curStage && !["aborted", "idle", "done"].includes(curStage)) {
    patch({ stage: "aborted", abortedFrom: curStage });
  } else {
    patch({ stage: "aborted" });
  }
}

/** 先建立完整主线和章节目录，再展开第一章。 */
export async function runAgent(theme: string, shotCount: number, aspectRatio: string, shotSeconds = "auto", mode: StoryMode = "original", chapterCount = 6) {
  const cur = useCanvasStore.getState().agentState;
  if (executing || (cur && !["idle", "aborted", "done"].includes(cur.stage))) return;
  if (!useCanvasStore.getState().projectId) { patch({ error: "项目尚未加载完成，请稍候重试" }); return; }
  if (!theme.trim()) return;
  executing = true; aborted = false;
  patch({ stage: "outline", theme, shotCount, shotSeconds, aspectRatio, styleName: "", stylePrompt: "",
    assets: [], shots: [], error: null, outlineNodeId: null, outlineJson: null, story: null, activeChapterId: null, abortedFrom: undefined });
  try {
    const sources = mode === "novel" ? splitNovelChapters(theme) : [];
    const raw = await plan("series", JSON.stringify({ mode, chapterCount,
      input: mode === "novel" ? sources.map((source) => `【${source.title}】\n${source.text}`).join("\n\n") : theme,
      chapterTitles: sources.map((s) => s.title) }));
    if (aborted) return;
    const story = normalizeStory(raw, mode, sources);
    patch({ story });
    await prepareChapter(story.chapters[0].id);
  } catch (e) { if (!aborted) patch({ stage: "idle", error: (e as Error).message }); }
  finally { executing = false; }
}

/** Current chapter only; historical outlines and shots remain immutable. */
async function prepareChapter(chapterId: string) {
  const state = useCanvasStore.getState().agentState!;
  const story = state.story!;
  const chapter = story.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error("章节不存在");
  if (story.chapters.some((c) => c.number < chapter.number && !c.outline)) throw new Error("请先按顺序完成前面章节的剧本");
  patch({ activeChapterId: chapter.id, outlineJson: chapter.outline ?? null, outlineNodeId: chapter.outlineNodeId ?? null,
    shots: chapter.shots, error: null, stage: "outline" });
  if (!chapter.outline) {
    let outline = normalizeOutline(await plan("chapter", chapterContext(story, chapter, state.assets), state.shotCount));
    if (aborted) return;
    outline = lockChapterIdentity(outline, story.chapters.filter((c) => c.number < chapter.number));
    outline.continuationContext = chapter.number > 1
      ? `第${chapter.number}章，只表现本章新增事件。上一章结尾：${story.chapters[chapter.number - 2]?.endingState || story.chapters[chapter.number - 2]?.summary || "按前情承接"}。禁止重演前情。`
      : "全片首章：建立世界、主角长期目标和主线冲突。";
    const outlineNodeId = addAgentNode("text", { x: 0, y: 0 }, { label: `第${chapter.number}章·${chapter.title}`, prompt: outlineToText(outline) });
    patch({ outlineJson: outline, outlineNodeId });
  }
  patch({ stage: "style" });
  await saveAgentCheckpoint();
  if (state.stylePrompt) await produceChapter(state.styleName, state.stylePrompt);
}

/** Save the chapter and graph together before submitting any paid media task. */
async function saveAgentCheckpoint() {
  const st = useCanvasStore.getState();
  if (!st.projectId) throw new Error("项目尚未加载");
  const res = await fetch(`/api/projects/${st.projectId}/graph`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: st.nodes.map(({ id, position, data }) => ({ id, position, data })),
      edges: st.edges.map(({ id, source, target, data }) => ({ id, source, target, data })), agentState: st.agentState }) });
  if (!res.ok) throw new Error("章节进度保存失败，请检查连接后继续本章");
}

export async function chooseStyle(styleName: string, stylePrompt: string) {
  if (executing || !useCanvasStore.getState().agentState?.outlineNodeId) return;
  executing = true; aborted = false;
  try { await produceChapter(styleName, stylePrompt); }
  catch (e) { if (!aborted) patch({ error: (e as Error).message, stage: "aborted" }); }
  finally { executing = false; }
}

async function produceChapter(styleName: string, stylePrompt: string) {
  const state = useCanvasStore.getState().agentState!;
  let outline = state.outlineJson;
  if (!outline) throw new Error("章节剧本不存在，请先生成剧本");
  const repairedOutline = completeScriptCast(outline);
  if (repairedOutline.characters.length !== outline.characters.length) {
    outline = repairedOutline;
    patch({ outlineJson: outline });
    if (state.outlineNodeId) useCanvasStore.getState().updateNodeData(state.outlineNodeId, { prompt: outlineToText(outline) });
  }
  if (state.shots.length) assertDialogueCoverage(outline.script, outline.characters.map((c) => c.name), state.shots.map((s) => s.dialogue));
  // 防止旧版本留下空 script 时继续付费生成整章静音视频。
  if (state.story?.mode !== "novel") {
    const names = new Set(outline.characters.map((c) => c.name));
    const dialogueCount = outline.script.split(/\r?\n/).filter((line) => {
      const m = /^([^\s：:]{1,20})[：:]\s*(.+)$/.exec(line.trim());
      return Boolean(m && names.has(m[1]) && m[2].trim());
    }).length;
    if (dialogueCount < 2) throw new Error("本章剧本没有可用对白，已停止生成，避免产出静音视频；请重新生成大纲");
  }
  patch({ styleName, stylePrompt, stage: "assets" });
  const planned = await plan<{ assets: OutlineAsset[] }>("assets", JSON.stringify({ ...outline,
    existingAssets: state.assets.map((a) => ({ kind: a.kind, name: a.name })), instruction: "只列本章使用的资产，人物名和场景名逐字匹配，不新增剧本外人物。已有资产会复用。" }));
  if (aborted) return;
  await ensureChapterAssets(outline, stylePrompt, planned.assets);
  if (aborted) return;
  await runStoryboardAndShots(stylePrompt);
  await saveAgentCheckpoint();
}

/** Also used for source-backed cast discovered while planning a later batch. */
async function ensureChapterAssets(outline: StoryOutline, stylePrompt: string, proposedAssets: OutlineAsset[] = []) {
  const state = useCanvasStore.getState().agentState!;
  const assets = [...state.assets];
  // Ensure all new named characters/scenes receive assets even if the model omits one.
  const proposed = Array.isArray(proposedAssets) ? proposedAssets.filter((a) => a && typeof a.name === "string" && typeof a.prompt === "string" && ["character", "scene", "prop"].includes(a.kind)) : [];
  const required: OutlineAsset[] = [
    ...outline.characters.map((p) => ({ kind: "character" as const, name: p.name, voiceProfile: p.voiceProfile,
      prompt: `白底全身角色设定：${p.name}，性别${p.gender ?? "未知"}，${p.appearance}，${p.wardrobe ?? "保持原有服装"}` })),
    ...outline.scenes.map((s) => ({ kind: "scene" as const, name: s.name, prompt: s.description })),
  ];
  const requiredKeys = new Set(required.map((a) => `${a.kind}:${a.name}`));
  const chapterAssets = [...proposed.filter((a) => a.kind === "prop" || requiredKeys.has(`${a.kind}:${a.name}`))];
  for (const a of required) if (!chapterAssets.some((p) => p.kind === a.kind && p.name === a.name)) chapterAssets.push(a);
  for (const a of chapterAssets) {
    if (!assets.some((p) => p.kind === a.kind && p.name === a.name)) assets.push({ ...a, voiceProfile: outline.characters.find((p) => a.kind === "character" && p.name === a.name)?.voiceProfile ?? a.voiceProfile,
      id: storyId(), nodeId: null, status: "pending" });
  }
  patch({ assets });
  for (let i = 0; i < assets.length; i++) {
    if (aborted) return;
    const a = assets[i];
    if (!chapterAssets.some((p) => p.kind === a.kind && p.name === a.name)) continue;
    const existing = useCanvasStore.getState().nodes.find((n) => n.id === a.nodeId);
    if (existing?.data.status === "done" && (existing.data.mediaId || existing.data.remoteUrl)) { assets[i] = { ...a, status: "done" }; continue; }
    const kindLabel = a.kind === "character" ? "角色" : a.kind === "scene" ? "场景" : "道具";
    const nodeId = existing?.id ?? addAgentNode("image", { x: 400, y: i * 320 }, {
      label: `${kindLabel}-${a.name}`, assetId: a.id,
      prompt: `${stylePrompt},${a.prompt}${a.kind === "scene" ? ",纯环境概念图，无人物、动物、剪影或雕像" : ""}`,
      negativePrompt: a.kind === "scene" ? "人物,动物,人形,剪影,雕像,文字,水印" : undefined, imageTier: "2K",
    });
    connect(state.outlineNodeId!, nodeId);
    assets[i] = { ...a, nodeId, status: "running" }; patch({ assets: [...assets] });
    await saveAgentCheckpoint();
    const ok = existing && ["queued", "generating"].includes(existing.data.status ?? "") ? await waitForNode(nodeId) : await generateAndAwait(nodeId);
    assets[i] = { ...assets[i], status: ok ? "done" : "failed" }; patch({ assets: [...assets] });
  }
  patch({ assets: [...assets] });
  if (aborted) return;
  const missing = assets.filter((a) => requiredKeys.has(`${a.kind}:${a.name}`) && a.status !== "done");
  if (missing.length) throw new Error(`本章资产尚未完成：${missing.map((a) => a.name).join("、")}。请继续本章重试资产后再生成视频`);
}

export async function startChapter(chapterId: string) {
  const state = useCanvasStore.getState().agentState;
  if (executing || !state?.story || !["idle", "done", "aborted", "style"].includes(state.stage)) return;
  executing = true; aborted = false;
  try { await prepareChapter(chapterId); }
  catch (e) { if (!aborted) patch({ error: (e as Error).message, stage: "aborted" }); }
  finally { executing = false; }
}

/** Import first, generate on explicit chapter action; no existing task or asset is overwritten. */
export async function importNovelChapters(text: string) {
  const state = useCanvasStore.getState().agentState;
  if (executing || !state?.story || state.story.mode !== "novel") return;
  try { patch({ story: appendNovelChapters(state.story, splitNovelChapters(text)), error: null }); await saveAgentCheckpoint(); }
  catch (e) { patch({ error: (e as Error).message }); throw e; }
}

export async function continueAgent(continuation: string, shotCount: number) {
  const current = useCanvasStore.getState().agentState;
  if (executing || !current?.outlineJson || !["idle", "done", "aborted"].includes(current.stage)) return;
  let story = current.story;
  // Adopt legacy short dramas as chapter one without changing their canvas or media.
  if (!story) story = { id: storyId(), mode: "original", title: current.outlineJson.title, mainline: current.outlineJson.synopsis,
    ending: "按新增剧情延续", worldRules: current.outlineJson.worldRules ?? [], chapters: [{ id: storyId(), number: 1,
      title: current.outlineJson.title, goal: current.outlineJson.synopsis, sourceText: "", status: "done", outline: current.outlineJson,
      outlineNodeId: current.outlineNodeId ?? undefined, summary: current.outlineJson.synopsis, shots: current.shots, assetIds: current.assets.map((a) => a.id) }] };
  if (!continuation.trim()) return;
  const chapter: StoryChapter = { id: storyId(), number: story.chapters.length + 1, title: `第${story.chapters.length + 1}幕`, goal: continuation.trim(), sourceText: "",
    status: "planned", shots: [], assetIds: [] };
  patch({ story: { ...story, chapters: [...story.chapters, chapter] }, shotCount });
  await startChapter(chapter.id);
}


// ==================== 内部：分镜 + 合成 ====================

async function runStoryboardAndShots(stylePrompt: string) {
  let s = useCanvasStore.getState().agentState!;
  if (aborted) return;
  patch({ stage: "storyboard" });

  const outlineNode = useCanvasStore.getState().nodes.find(
    (n) => n.id === s.outlineNodeId,
  );
  let assetNames = s.outlineJson?.characters.map((c) => c.name) ?? [];
  const sceneNames = s.outlineJson?.scenes.map((scene) => scene.name) ?? [];

  // 台词分配在代码里算死(按顺序、逐句占镜),分镜师照抄,LLM 无权自行取舍。
  // 若对白多于可承载的镜头，自动增加分镜，避免把三四句对白硬塞进一个视频镜头，
  // 这是视频模型乱说、重复念和剧情回放的主要诱因之一。
  let shotCount = s.shotCount;
  let dialoguePlan = s.outlineJson
    ? planShotDialogue(s.outlineJson.script, s.outlineJson.characters.map((c) => c.name), shotCount)
    : null;
  let dialogueContexts = s.outlineJson
    ? planShotContexts(s.outlineJson.script, s.outlineJson.characters.map((c) => c.name), shotCount)
    : null;
  const dialogueGroups = s.outlineJson ? groupDialogueLines(s.outlineJson.script, s.outlineJson.characters.map((c) => c.name)) : [];
  const dialogueCount = dialogueGroups.length;
  const minimumStorySlots = shotCount > 1 ? 2 : 1; // 至少保留开场与一个无对白过渡/反应镜
  const desiredShotCount = Math.max(shotCount, dialogueCount + minimumStorySlots);
  if (desiredShotCount > shotCount && s.outlineJson) {
    shotCount = desiredShotCount;
    dialoguePlan = planShotDialogue(s.outlineJson.script, s.outlineJson.characters.map((c) => c.name), shotCount);
    dialogueContexts = planShotContexts(s.outlineJson.script, s.outlineJson.characters.map((c) => c.name), shotCount);
    patch({ shotCount });
  }

  const shotsPlan: Storyboard = { shots: [] };
  if (!s.shots.length) {
    for (let offset = 0; offset < shotCount; offset += 8) {
      const count = Math.min(8, shotCount - offset);
      const batch = await plan<Storyboard>("storyboard", JSON.stringify({
        outline: s.outlineJson ?? outlineNode?.data.prompt, assetNames, sceneNames, count,
        dialoguePlan: dialoguePlan?.slice(offset, offset + count),
        dialogueContexts: dialogueContexts?.slice(offset, offset + count),
        chapterNumber: s.story?.chapters.find((c) => c.id === s.activeChapterId)?.number ?? 1,
        shotOffset: offset, totalShots: shotCount,
        previousShots: shotsPlan.shots.slice(-2),
      }), count);
      if (aborted) return;
      if (batch.additionalCharacters?.length && s.outlineJson) {
        const added = batch.additionalCharacters.filter((c) => !assetNames.includes(c.name));
        if (added.length) {
          const outline = { ...s.outlineJson, characters: [...s.outlineJson.characters, ...added] };
          patch({ outlineJson: outline, stage: "assets" });
          if (s.outlineNodeId) useCanvasStore.getState().updateNodeData(s.outlineNodeId, { prompt: outlineToText(outline) });
          await saveAgentCheckpoint();
          await ensureChapterAssets(outline, stylePrompt);
          if (aborted) return;
          s = useCanvasStore.getState().agentState!;
          assetNames = outline.characters.map((c) => c.name);
          patch({ stage: "storyboard" });
        }
      }
      shotsPlan.shots.push(...batch.shots.map((shot, i) => ({ ...shot, index: offset + i + 1 })));
    }
  }

  let previousScene: string | undefined;
  const shots: AgentShot[] = s.shots.length ? s.shots.map((shot) => ({ ...shot })) : shotsPlan.shots.map((sh, i) => {
    // 模型偶尔返回非字符串 dialogue；先过滤，避免后续按角色名 split 时触发运行时崩溃。
    const modelDialogue = Array.isArray(sh.dialogue)
      ? sh.dialogue.filter((line): line is string => typeof line === "string").map(cleanDialogueLine)
      : [];
    const dialogue = resolveDialogueSpeakers(dialoguePlan ? (dialoguePlan[i] ?? []) : modelDialogue, assetNames);
    const shotType = dialogue.length
      ? ((sh.shotType === "reaction" || sh.shotType === "dialogue") ? sh.shotType : "dialogue")
      : (sh.shotType ?? (i === 0 ? "intro" : "transition"));
    const lockedContext = dialogueContexts?.[i] ?? [];
    const lockedScene = resolveShotScene(lockedContext, sh.scene, sceneNames, previousScene);
    previousScene = lockedScene;
    const visualContext = lockedContext
      .map((item) => item.replace(/；精确台词=.*$/, "").replace(/精确台词=.*$/, "").trim())
      .filter(Boolean);
    const contextContract = visualContext.length
      ? `
本镜视觉事实锁定（对白由后面的独立台词块唯一提供）：${visualContext.join(" | ")}。只能在这些事实之后推进一个新动作；不得把本镜对白放到别的场景、别的角色或别的时间；画面描述禁止复述台词正文。`
      : "";
    const description = `${contextContract}${sh.camera ? `摄影执行：${sh.camera.size ?? "中景"}，${sh.camera.movement ?? "固定"}，${sh.camera.angle ?? "四分之三侧面"}。` : ""}${stripDialogueFromVisualDescription(sh.description, dialogue)}`;
    const duration = String(clampVideoDuration(estimateShotDuration(dialogue, description, shotType)));
    return {
      dialogue,
      dialogueContext: lockedContext,
      index: sh.index ?? i + 1,
      duration,
      description,
      shotType,
      purpose: sh.purpose ?? (i === 0 ? "建立世界、时间和核心悬念" : "推进角色目标并改变关系"),
      cutPoint: sh.cutPoint ?? (i === 0 ? "悬念信息落幅后切入人物反应" : "动作或视线完成后切换"),
      lighting: sh.lighting ?? "延续场景主光方向和色温，情绪变化通过明暗对比呈现",
      composition: sh.composition ?? "前景遮挡制造空间层次，中景承载动作，背景提供叙事线索",
      blocking: sh.blocking ?? "沿180度轴线安排左右站位，明确视线方向和动作终点",
      emotion: sh.emotion ?? "通过眼神、呼吸、嘴角、肩颈和手部的微动作呈现情绪变化",
      sound: sh.sound ?? "低音量环境声与一个关键拟音，给对白让位",
      camera: sh.camera ?? { size: dialogue.length ? "近景" : "全景", movement: dialogue.length ? "固定" : "缓慢推近", angle: "四分之三侧面", lens: dialogue.length ? "50mm" : "35mm", focus: "锁定叙事主体", height: "视线高度" },
      // 只在分镜明确要求且场景一致时承接；建立/过渡镜头硬切。
      transition: i === 0 || ["intro", "establishing", "transition", "cutaway"].includes(shotType) || sh.transition !== "continue" ? "cut" : "continue",
      characters: resolveShotCharacters(
        Array.isArray(sh.characters) ? sh.characters.filter((name): name is string => typeof name === "string") : [],
        dialogue, assetNames),
      scene: lockedScene,
      nodeId: null,
      status: "pending",
    };
  });
  if (s.outlineJson) assertDialogueCoverage(s.outlineJson.script, assetNames, shots.map((sh) => sh.dialogue));
  patch({ shots, stage: "shots" });

  // 角色名 → 节点 id 映射（仅已成功生成的角色立绘）
  const charNodes = new Map<string, string>();
  for (const a of s.assets) {
    if (a.kind === "character" && a.nodeId && a.status === "done") {
      charNodes.set(a.name, a.nodeId);
    }
  }
  // 仅索引本章地点；缺失的场景必须补齐，不能用历史场景顶替。
  const sceneNodes = new Map<string, string>();

  for (const a of s.assets) {
    if (a.kind === "scene" && sceneNames.includes(a.name) && a.nodeId && a.status === "done") {
      sceneNodes.set(a.name, a.nodeId);
    }
  }
  const characterAppearance = new Map((s.outlineJson?.characters ?? []).map((c) => [c.name, c.appearance]));
  const characterProfiles = new Map((s.outlineJson?.characters ?? []).map((c) => [c.name, c]));

  let resolvedPrevious: string | undefined;
  for (const shot of shots) {
    // 已提交节点只恢复原任务，不修改与现有视频关联的分镜事实。
    if (shot.nodeId) { resolvedPrevious = shot.scene; continue; }
    shot.dialogue = resolveDialogueSpeakers(shot.dialogue, assetNames);
    shot.scene = resolveShotScene(shot.dialogueContext ?? [], shot.scene, sceneNames, resolvedPrevious);
    if (resolvedPrevious && resolvedPrevious !== shot.scene) shot.transition = "cut";
    resolvedPrevious = shot.scene;
    shot.characters = resolveShotCharacters(shot.characters, shot.dialogue, assetNames);
    if (!sceneNodes.has(shot.scene)) throw new Error(`第${shot.index}镜场景资产未完成：${shot.scene}`);
    for (const name of shot.characters) {
      if (!charNodes.has(name)) throw new Error(`第${shot.index}镜人物资产未完成：${name}`);
    }
    if (shot.characters.length + 1 > 5) throw new Error(`第${shot.index}镜人物与场景超过5张参考图上限，请拆分镜头，不能丢弃人物资产`);
  }
  patch({ shots: [...shots] });

  // 上一镜尾帧衔接:{ nodeId, url } | null;截帧失败或上一镜跳过时为 null
  let prevTail: { nodeId: string; url: string } | null = null;
  const skippedShots: number[] = [];

  for (let i = 0; i < shots.length; i++) {
    if (aborted) return;
    const shot = shots[i];
    if (shot.nodeId) {
      const existing = useCanvasStore.getState().nodes.find((n) => n.id === shot.nodeId);
      if (!existing) throw new Error(`第${shot.index}镜节点已删除，请恢复节点后继续`);
      const ok = existing.data.status === "done" || (["queued", "generating"].includes(existing.data.status ?? "") && await waitForNode(existing.id));
      // Never resend an ambiguous video submission when restoring the chapter.
      shots[i] = { ...shot, status: ok ? "done" : "skipped" };
      if (!ok) skippedShots.push(shot.index);
      patch({ shots: [...shots] });
      prevTail = null;
      continue;
    }

    // 参考图顺序:角色立绘按大纲角色全局顺序(与分镜描述"<Picture N>"编号规则一致,避免 description 与 identityNote 编号打架)
    // → 出镜道具 → 场景图 → 上一镜尾帧(最后一张);
    // refNames 供台词按角色名精确绑定,非角色条目标注为画面参考。Agnes reference 模式上限 5 张,
    // 超限依次剔除道具和尾帧；人物与本镜场景必须完整保留。
    // 注:reference 模式禁传 first_frame,尾帧靠提示词声明"作为首帧起播",为软约束(开头贴近,不保证逐帧一致)。
    let refs: { id: string; name: string }[] = [];
    for (const name of assetNames) {
      const id = charNodes.get(name);
      if (id && shot.characters.includes(name)) refs.push({ id, name });
    }
    // 道具:名称出现在本镜画面描述中才作为参考图,帮助道具形制一致
    for (const a of s.assets) {
      if (a.kind === "prop" && a.nodeId && a.status === "done" && shot.description.includes(a.name)) {
        refs.push({ id: a.nodeId, name: `道具·${a.name}` });
      }
    }
    // 只绑定本镜明确匹配的场景。
    const sceneNode = sceneNodes.get(shot.scene);
    if (sceneNode) refs.push({ id: sceneNode, name: "场景" });
    // 只有 continue 才把尾帧作为首帧约束；cut 使用普通剪辑，避免尾帧把新机位锁死。
    // 对白镜不叠加上一镜尾帧：尾帧常已包含同一批人物，再加角色立绘会诱发复制人物和多张脸；
    // 无对白动作镜才使用尾帧做连续性约束。
    if (prevTail && shot.transition === "continue" && shot.dialogue.length === 0 && shots[i - 1]?.scene === shot.scene) refs.push({ id: prevTail.nodeId, name: "上一镜尾帧" });
    // Preserve every visible character and the exact scene. Optional props/tail frames yield first.
    refs = fitShotReferences(refs);
    const refIds = refs.map((r) => r.id);
    const refNames: Record<string, string> = Object.fromEntries(refs.map((r) => [r.id, r.name]));

    // 尾帧首帧声明放提示词最前(开头 token 权重最高,埋在 200 字后实测会被弱化);identityNote 里的尾帧从句二次强化
    const tailIdx = refs.findIndex((r) => r.name === "上一镜尾帧");
    const tailLead = tailIdx >= 0 && shot.transition === "continue"
      ? `本镜视频必须从<Picture ${tailIdx + 1}>(上一镜结尾画面)起播,开头画面与它完全一致,`
      : "";

    // 所有台词都必须绑定角色参考；不能静默丢弃未绑定的台词。
    const speakerSet = new Set(refs.map((r) => r.name));
    const boundDialogue = shot.dialogue.map((l) => {
      const m = /^([^：:]+)[：:]/.exec(l.trim());
      if (!m || !speakerSet.has(m[1].trim())) throw new Error(`第${shot.index}镜对白未绑定角色资产：${l}`);
      return l;
    });

    // 官方 <Picture N> 占位符逐张声明参考图用途:只锁外形,动作朝向机位以提示词为准(立绘正面站姿会被连姿势复制)
    const identityNote = refs
      .map((r, i) => {
        const p = `<Picture ${i + 1}>`;
        if (r.name === "场景") return `${p}为场景与氛围参考`;
        if (r.name === "上一镜尾帧") return `${p}是上一镜结尾画面,本镜必须直接从这一画面开始(把它当作首帧):开头画面与它完全一致,人物位置、朝向、服装与场景状态从它延续,再完成本镜描述的新动作与新机位运镜`;
        if (r.name.startsWith("道具·")) return `${p}为道具${r.name.slice(3)}的形制参考`;
        const appearance = characterAppearance.get(r.name);
        const profile = characterProfiles.get(r.name);
        return `${p}为${r.name}的角色身份参考：性别严格为${profile?.gender ?? "仅按大纲，不猜测"}，年龄${profile?.age ?? "按大纲"}；只取长相、发型、体型、服装和配饰外形，不复制参考图站姿。外观锁定：${appearance ?? "按大纲"}；服装锁定：${profile?.wardrobe ?? "保持上一镜"}；固定音色身份：${profile?.voiceProfile ?? "与该角色前镜一致"}，不得换性别、换声线或让其他角色代念`;
      })
      .join(";");
    // 声音设计(官方六要素之一):有台词锁定干净人声——撤销"现场动作音效"授权(实测模型会拿它
    // 填台词空窗,即兴加语音+环境音盖过人声);无台词用正面声音描述压住旁白幻觉(否定式实测无效)
    const soundNote = boundDialogue.length
      ? "音轨以人声为主:人声清晰干净、咬字清楚,除台词块中的台词外禁止任何语音(呢喃、喘息、哼唱、旁白都禁止),环境音音量压到最低,无音乐铺底,念完台词的剩余时间保持安静"
      : "音轨只有画面内的现场声:脚步声、衣物摩擦声、器物声响与自然环境音,没有解说旁白,没有任何说话声";
    // 说话人机位指令(代码注入,不依赖分镜师):直生语音模型只会给"画面最显著的一张嘴"配音,
    // 必须显式钉死谁开口——说话人嘴部可见,其余人物闭口/背影;分配表里说话人不在本镜参考图时按画外音处理
    const speakerNote = (() => {
      if (!boundDialogue.length) return "";
      const speakers = [...new Set(
        boundDialogue.map((l) => /^([^：:]+)[：:]/.exec(l.trim())?.[1]?.trim() ?? "").filter(Boolean),
      )];
      const parts = speakers.map((sp) => {
        const idx = refs.findIndex((r) => r.name === sp);
        const profile = characterProfiles.get(sp);
        return idx >= 0
          ? `说话时<Picture ${idx + 1}>的${sp}保持侧面或四分之三侧面,嘴部清晰可见并有与台词逐字同步的开合动作,性别严格为${profile?.gender ?? "按大纲"},音色严格延续${profile?.voiceProfile ?? "该角色上一镜"},禁止正面直视镜头或让其他人代念`
          : `${sp}以画外音说话,画面中不出现其口型`;
      });
      const others = refs
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => !r.name.startsWith("道具·") && r.name !== "场景" && r.name !== "上一镜尾帧" && !speakers.includes(r.name))
        .map(({ r, i }) => `<Picture ${i + 1}>的${r.name}闭口倾听或背对镜头`);
      return `人物说话规则:${parts.join(";")}${others.length ? `;${others.join(",")}` : ""}`;
    })();

    const profileNote = [...new Set(shot.characters)].map((name) => {
      const p = characterProfiles.get(name);
      return p ? `${name}：性别${p.gender ?? "按大纲"}，年龄${p.age ?? "按大纲"}，关系${p.relationship ?? "按大纲"}，性格${p.personality ?? "按大纲"}，服装${p.wardrobe ?? "保持连续"}，固定音色${p.voiceProfile ?? "保持与前镜一致"}` : "";
    }).filter(Boolean).join("；");

      const nodeId = addAgentNode("video", { x: 800, y: i * 320 }, {
      label: `${s.story ? `第${s.story.chapters.find((c) => c.id === s.activeChapterId)?.number}章·` : ""}第${shot.index}镜`,
      prompt: compileShotPrompt(stylePrompt, shot, tailLead, identityNote, soundNote, speakerNote, profileNote,
        "本镜由视频模型直接生成台词音频：只念台词块中按顺序列出的句子，逐字念完立即静音；禁止参考或朗读任何提示词、动作说明、角色名。多句台词必须逐句停顿并由对应角色分别开口。"),
      dialogue: boundDialogue.length ? boundDialogue.join("\n") : undefined,
      dialogueContext: (shot.dialogueContext ?? []).join("\n"),
      seconds: shot.duration,
      aspectRatio: s.aspectRatio,
      model: "agnes-video-2.5-flash",
      referenceOrder: refIds,
      refNames,
      voiceProfiles: Object.fromEntries(shot.characters.map((name) => [name, characterProfiles.get(name)?.voiceProfile ?? "与该角色前镜保持一致"])),
    });
    for (const src of refIds) connect(src, nodeId);

    // 同 assets 循环:原地更新,避免下一轮 patch 抹掉 nodeId(否则 assembly 装不进时间线)
    shots[i] = { ...shots[i], nodeId, status: "running" };
    patch({ shots: [...shots] });

    await saveAgentCheckpoint();
    const ok = await generateAndAwait(nodeId);
    // 单镜失败跳过不阻塞，标记为 skipped
    shots[i] = { ...shots[i], status: ok ? "done" : "skipped" };
    if (!ok) skippedShots.push(shot.index);
    patch({ shots: [...shots] });

    // 生成成功则截取尾帧供下一镜衔接;失败则清空,下一镜降级为无尾帧
    if (!ok || i + 1 >= shots.length || aborted) {
      prevTail = null;
      continue;
    }
    const doneNode = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const mediaId = doneNode?.data.mediaId;
    const tailUrl = mediaId ? await extractLastFrameUrl(mediaId) : null;
    if (tailUrl) {
      const tailNodeId = addAgentNode("image", { x: 620, y: i * 320 + 160 }, {
        label: `第${shot.index}镜尾帧`,
        prompt: `第${shot.index}镜结尾画面(自动截取,供下一镜开头衔接)`,
        remoteUrl: tailUrl,
        status: "done",
      });
      prevTail = { nodeId: tailNodeId, url: tailUrl };
    } else {
      prevTail = null;
    }
  }

  // ---- assembly：按序填时间线（仅成功的镜） ----
  if (aborted) return;
  patch({ stage: "assembly" });

  const stNow = useCanvasStore.getState();
  const clips = stNow
    .agentState!.shots.filter((sh) => sh.status === "done" && sh.nodeId)
    .map((sh, i) => {
      const node = stNow.nodes.find((n) => n.id === sh.nodeId);
      // 默认保留视频模型原生音轨；仅在用户明确连接音频节点时使用替代音轨。
      const audioEdge = stNow.edges.find((e) => e.target === sh.nodeId && e.data?.role === "audio");
      const audioNode = audioEdge ? stNow.nodes.find((n) => n.id === audioEdge.source) : undefined;
      return {
        id: agentNodeId("clip"),
        nodeId: sh.nodeId!,
        mediaId: node?.data.mediaId ?? "",
        order: i,
        trimIn: 0,
        trimOut: null,
        audioMediaId: audioNode?.data.mediaId,
      };
    })
    .filter((c) => c.mediaId);

  stNow.setTimeline([...stNow.timeline, ...clips.filter((c) => !stNow.timeline.some((old) => old.nodeId === c.nodeId))].map((c, order) => ({ ...c, order })));
  patch({ stage: "done", error: skippedShots.length ? `第${skippedShots.join("、")}镜生成失败，已从成片中跳过；可单独重试这些镜头` : null });
}

// ==================== 辅助 ====================

function outlineToText(o: Outline): string {
  const chars = o.characters.map((c) => `${c.name}（性别:${c.gender ?? "按大纲"}，年龄:${c.age ?? "按大纲"}，关系:${c.relationship ?? ""}，性格:${c.personality ?? ""}，外观:${c.appearance}，服装:${c.wardrobe ?? ""}，固定音色:${c.voiceProfile ?? ""}）`).join("；");
  const scenes = o.scenes.map((s) => `${s.name}：${s.description}（社会关系：${s.socialContext ?? ""}）`).join("；");
  const beats = (o.beats ?? []).map((b) => `${b.index}.${b.purpose}：${b.event}（因为${b.cause ?? ""}→所以${b.effect ?? ""}，情绪${b.emotion ?? ""}）`).join("\n");
  return `《${o.title}》(${o.genre})\n一句话冲突：${o.logline ?? ""}\n主题：${o.theme ?? ""}\n基调：${o.tone ?? ""}\n开场钩子：${o.openingHook ?? ""}\n梗概：${o.synopsis}\n世界规则：${(o.worldRules ?? []).join("；")}\n角色：${chars}\n场景：${scenes}\n节拍：\n${beats}\n${o.continuationContext ? `\n续段边界：${o.continuationContext}` : ""}\n\n${o.script}`;
}

/** 将分镜字段编译成稳定的模型指令，减少模型把镜头说明、对白和剪辑要求混成一段。 */
function compileShotPrompt(stylePrompt: string, shot: AgentShot, tailLead: string, identityNote: string, soundNote: string, speakerNote: string, profileNote: string, audioNote = ""): string {
  const cameraMatch = shot.description.match(/^摄影执行：[^。]+。/);
  const cameraLine = cameraMatch?.[0] ?? "摄影执行：中景，固定，四分之三侧面。";
  const visualDescription = cameraMatch ? shot.description.slice(cameraMatch[0].length) : shot.description;
  const cameraDetail = shot.camera ? `摄影参数：${shot.camera.lens ?? "35mm"}，${shot.camera.height ?? "视线高度"}，焦点${shot.camera.focus ?? "锁定主体"}，景别${shot.camera.size ?? "中景"}，${shot.camera.angle ?? "四分之三侧面"}，${shot.camera.movement ?? "固定"}。` : "摄影参数：35mm，视线高度，中景，四分之三侧面，固定机位。";
  const cameraContract = `人物数量合同：本镜只允许出现 ${shot.characters.length} 个已命名人物，每个角色只出现一个身体和一张脸；禁止复制、克隆、镜像、重影、额外路人或把同一角色画成两个人。${shot.dialogue.length ? "对白镜开头先保持画面动作和闭口状态，不能提前说话；只有独立台词块授权的角色才能开口。" : ""}
镜头执行合同：只使用本镜指定的一种主运镜；起幅→连续动作→落幅一镜完成，不新增镜头、不突然变焦、不镜中切；人物动作在本镜时长内完成，最后0.5秒停稳。对白期间保持说话人嘴部可见，运动慢且稳定；不得切到无人或纯场景画面承载对白。`;
  const editContract = shot.index === 1
    ? "剪辑承接：这是开场镜头，前0.5秒建立空间和人物关系，禁止突然闪入或无动机变焦。"
    : shot.transition === "continue"
      ? "剪辑承接：本镜首帧严格延续上一镜落幅的场景、人物站位、服装、光线和视线；先完成未结束动作，再执行本镜运镜；禁止跳轴、瞬移、闪白。"
      : "剪辑承接：这是正常cut，沿180度轴线完成正反打或视线切换；保持服装、道具和运动方向连续，禁止跳轴、瞬移、闪白和无动机变场。";
  const motionContract = `摄影幅度：${shot.camera?.movement ?? "固定"}必须有可见但克制的起止幅度，运动匀速；固定镜头保持机位，缓慢推近/拉远全镜头最多改变18%，横移最多跨越15%画幅，摇镜/跟拍必须从明确起点到明确终点。对白开始后只允许极慢运动，台词说完再完成剩余位移。`;
  const scaleContract = "身份连续性锁定：只使用参考图和角色档案中声明的性别、年龄、脸部特征、发型、体型、服装材质颜色、配饰和固定音色；不得凭外形重新识别人物，不得换性别、换年龄、换音色、换装或让角色互换身份。";
  const speechContract = "声音硬约束：严格按台词块逐字念出，不能改写、补充、重复或提前/延后；每行冒号前是唯一说话人，按行顺序轮流说完，禁止一个角色代念另一个角色；禁止朗读提示词、动作说明、角色名、字幕署名、旁白、拟声词或新增语气词。说话时对应角色必须正面或四分之三侧脸、嘴部清晰可见并开合，其他角色闭口；台词结束后立即保持完全安静。";
  const narrativeContract = shot.shotType === "intro"
    ? "电影级开场合同：不急着让角色解释背景；先用空间尺度、时间天气、光线、关键异常和声音桥建立世界与悬念，最后把视觉焦点落到主角或问题上。"
    : shot.shotType === "transition" || shot.shotType === "cutaway"
      ? "过渡镜头合同：本镜必须用具体物件、手部动作、脚步、视线或声音桥连接前后剧情；镜头有明确起点和终点，画面信息必须改变观众对目标/危险/关系的理解，不能只拍空景。"
      : "叙事镜头合同：动作必须改变角色关系或推进目标；把情绪变化落实为眼神、呼吸、嘴角、手部和身体重心的可见变化。";
  return [stylePrompt, `本镜场景锁定：${shot.scene}；场景参考图仅属于该地点。出镜人物：${shot.characters.join("、") || "无人物"}。`, `本镜最终时长：${shot.duration}秒；不要延长或压缩台词来适配其他时长。`, cameraLine, cameraDetail, narrativeContract, `镜头用途：${shot.purpose ?? "推进剧情"}。`, `剪辑切点：${shot.cutPoint ?? "动作或视线完成后切换"}。`, `布光：${shot.lighting ?? "按场景设定保持连续"}。`, `构图：${shot.composition ?? "前中后景清晰，视觉重心明确"}。`, `走位：${shot.blocking ?? "保持轴线和左右站位连续"}。`, `表演情绪：${shot.emotion ?? "情绪通过可见表情和动作变化呈现"}。`, `声音设计：${shot.sound ?? "环境声为低底噪，给对白让位"}。`, cameraContract, motionContract, editContract, tailLead, visualDescription, scaleContract, profileNote, identityNote, soundNote, speakerNote, audioNote, speechContract].filter(Boolean).join("\n");
}
