import type { AgentAsset, AgentShot, AgentState } from "./store";
import { resolveCharacterName, resolveDialogueSpeakers } from "./shot-continuity";

export type StoryMode = "original" | "novel";
export interface StoryOutline {
  title: string; genre: string; synopsis: string; logline?: string; theme?: string; tone?: string;
  openingHook?: string; worldRules?: string[]; continuationContext?: string;
  characters: { name: string; gender?: string; age?: string; role?: string; relationship?: string; personality?: string; arc?: string; appearance: string; wardrobe?: string; voiceProfile?: string }[];
  scenes: { name: string; description: string; socialContext?: string }[];
  beats?: { index: number; purpose: string; event: string; cause?: string; effect?: string; emotion?: string }[];
  script: string;
  endingState?: string;
}
export interface StoryChapter {
  id: string; number: number; title: string; goal: string; sourceText: string;
  status: "planned" | "writing" | "ready" | "running" | "done" | "partial" | "failed";
  outline?: StoryOutline; outlineNodeId?: string; shots: AgentShot[]; assetIds: string[];
  summary?: string; endingState?: string; error?: string | null;
}
export interface AgentStory {
  id: string; mode: StoryMode; title: string; mainline: string; ending: string;
  worldRules: string[]; chapters: StoryChapter[];
}
export interface ChapterSource { title: string; text: string }
export const MAX_CHAPTER_CHARS = 30_000;
export const MAX_IMPORT_CHARS = 500_000;
const string = (v: unknown) => typeof v === "string" ? v.trim() : "";
export const storyId = () => crypto.randomUUID();

/** Only explicit chapter headings split the source. Original prose is never summarized or dropped. */
export function splitNovelChapters(input: string, fallbackTitle = "导入章节"): ChapterSource[] {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("请粘贴或上传小说正文");
  if (text.length > MAX_IMPORT_CHARS) throw new Error("本次小说内容过多，请按章节分批导入（每批不超过50万字）");
  const heading = /^\s*(?:#{1,6}\s*)?(?:第[零〇一二三四五六七八九十百千万两\d]+[章节幕回卷](?:\s|[：:、.．]|$).*|chapter\s+\d+\b.*)\s*$/i;
  const result: ChapterSource[] = [];
  let title = fallbackTitle; let lines: string[] = [];
  const push = () => { const body = lines.join("\n").trim(); if (body) result.push({ title, text: body }); };
  for (const line of text.split("\n")) {
    if (heading.test(line) && line.trim().length < 120) { push(); title = line.replace(/^\s*#+\s*/, "").trim(); lines = []; }
    else lines.push(line);
  }
  push();
  if (!result.length) throw new Error("章节只有标题，没有小说正文");
  for (const c of result) if (c.text.length > MAX_CHAPTER_CHARS) throw new Error(`“${c.title}”超过3万字，请拆成带章节标题的多个部分后导入，正文不会被截断`);
  return result;
}

export async function readNovelFiles(files: File[]): Promise<string> {
  if (!files.length) return "";
  const texts: string[] = [];
  let chapterNumber = 1;
  for (const file of files) {
    if (!/\.(txt|md)$/i.test(file.name)) throw new Error("支持 TXT、Markdown 文件；其他格式请先转成文本或直接粘贴正文");
    if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name} 超过2MB，请分章节上传`);
    const bytes = await file.arrayBuffer();
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { content = new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
    const chapters = splitNovelChapters(content, file.name.replace(/\.(txt|md)$/i, ""));
    texts.push(...chapters.map((c, i) => `第${chapterNumber++}章 ${c.title}\n${c.text}`));
  }
  const text = texts.join("\n\n");
  splitNovelChapters(text); // Apply the combined import limit as well.
  return text;
}

export function appendNovelChapters(story: AgentStory, sources: ChapterSource[]): AgentStory {
  const seen = new Set(story.chapters.map((c) => c.sourceText.replace(/\s/g, "")));
  const additions: StoryChapter[] = [];
  for (const source of sources) {
    const key = source.text.replace(/\s/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ id: storyId(), number: story.chapters.length + additions.length + 1, title: source.title,
      goal: "忠实改编本章原文，承接上一章结尾，保留事件因果和人物动机", sourceText: source.text,
      status: "planned", shots: [], assetIds: [] });
  }
  if (!additions.length) throw new Error("这些章节正文已导入，未重复添加");
  return { ...story, chapters: [...story.chapters, ...additions] };
}

export function normalizeStory(raw: unknown, mode: StoryMode, sources: ChapterSource[] = []): AgentStory {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!string(value.mainline)) throw new Error("主线规划缺少故事线，请重新规划");
  let story: AgentStory = { id: storyId(), mode, title: string(value.title) || "长篇故事", mainline: string(value.mainline),
    ending: string(value.ending), worldRules: Array.isArray(value.worldRules) ? value.worldRules.filter((x): x is string => typeof x === "string") : [], chapters: [] };
  if (mode === "novel") return appendNovelChapters(story, sources);
  const rows = Array.isArray(value.chapters) ? value.chapters : [];
  story = { ...story, chapters: rows.filter((r) => r && typeof r === "object").map((r, i) => ({
    id: storyId(), number: i + 1, title: string(r.title) || `第${i + 1}幕`, goal: string(r.goal), sourceText: "",
    status: "planned", shots: [], assetIds: [],
  })) };
  if (!story.chapters.length || story.chapters.some((c) => !c.goal)) throw new Error("主线规划缺少章节目标，请重新规划");
  return story;
}

/** Canonical identity comes from earlier chapters, not a fresh guess by the model. */
export function lockChapterIdentity(outline: StoryOutline, earlier: StoryChapter[]): StoryOutline {
  const characters = new Map<string, StoryOutline["characters"][number]>();
  const scenes = new Map<string, StoryOutline["scenes"][number]>();
  for (const c of earlier) {
    for (const p of c.outline?.characters ?? []) if (!characters.has(p.name)) characters.set(p.name, p);
    for (const s of c.outline?.scenes ?? []) if (!scenes.has(s.name)) scenes.set(s.name, s);
  }
  const locked = outline.characters.map((p) => {
    const canonical = resolveCharacterName(p.name, [...characters.keys()]);
    const old = canonical ? characters.get(canonical) : undefined;
    return old ? { ...p, name: old.name, gender: old.gender, age: old.age, appearance: old.appearance,
      wardrobe: old.wardrobe, voiceProfile: old.voiceProfile } : p;
  });
  const unique = [...new Map(locked.map((p) => [p.name, p])).values()];
  const names = unique.map((p) => p.name);
  // Only speaker labels are canonicalized; spoken words and stage directions remain intact.
  const script = outline.script.split("\n").map((line) => {
    const speaker = /^\s*([^：:]+)[：:]/.exec(line)?.[1]?.trim();
    return speaker && resolveCharacterName(speaker, names) ? resolveDialogueSpeakers([line], names)[0] : line;
  }).join("\n");
  return { ...outline, script, characters: unique, scenes: outline.scenes.map((s) => scenes.get(s.name) ?? s) };
}

export function chapterContext(story: AgentStory, chapter: StoryChapter, assets: AgentAsset[]): string {
  const earlier = story.chapters.filter((c) => c.number < chapter.number && c.outline);
  const last = earlier.at(-1);
  const cast = new Map<string, StoryOutline["characters"][number]>();
  const places = new Map<string, StoryOutline["scenes"][number]>();
  for (const c of earlier) {
    for (const p of c.outline!.characters) if (!cast.has(p.name)) cast.set(p.name, p);
    for (const s of c.outline!.scenes) if (!places.has(s.name)) places.set(s.name, s);
  }
  return JSON.stringify({ mode: story.mode, title: story.title, mainline: story.mainline, ending: story.ending,
    worldRules: story.worldRules, chapter: { number: chapter.number, title: chapter.title, goal: chapter.goal, sourceText: chapter.sourceText },
    chapterRoadmap: story.chapters.map((c) => ({ number: c.number, title: c.title, goal: c.goal })),
    previousChapters: earlier.map((c) => ({ number: c.number, summary: c.summary || c.outline!.synopsis, endingState: c.endingState })),
    previousEnding: last?.outline?.script.split("\n").slice(-12).join("\n"),
    canonicalCharacters: [...cast.values()], canonicalScenes: [...places.values()],
    existingAssets: assets.map((a) => ({ kind: a.kind, name: a.name, voiceProfile: a.voiceProfile })),
    instruction: "只创作当前章节；前情仅用于承接，禁止重演。规范角色名、性别、外观、服装和音色必须沿用。新角色和新场景必须加入清单。每幕推进主线，本章结尾记录人物位置、已知事实、物件归属和未解悬念。小说只改编已提供原文，不编造未上传章节。" });
}

/** Hydration pauses browser orchestration, but leaves submitted provider tasks untouched. */
export function restoreAgentState(saved: AgentState): AgentState {
  if (["idle", "done", "aborted", "style"].includes(saved.stage)) return saved;
  return { ...saved, stage: "aborted", abortedFrom: saved.stage, error: "已恢复章节进度，点击继续本章；已提交的视频会继续查询原任务" };
}

export function syncActiveChapter(state: AgentState): AgentState {
  if (!state.story || !state.activeChapterId) return state;
  return { ...state, story: { ...state.story, chapters: state.story.chapters.map((c) => {
    if (c.id !== state.activeChapterId) return c;
    const status: StoryChapter["status"] = state.stage === "done" ? (state.shots.some((s) => s.status !== "done") ? "partial" : "done")
      : state.stage === "aborted" ? "partial" : state.stage === "outline" ? "writing"
      : state.stage === "style" ? "ready" : state.stage === "idle" ? c.status : "running";
    return { ...c, status, outline: state.outlineJson ?? c.outline, outlineNodeId: state.outlineNodeId ?? c.outlineNodeId,
      shots: state.shots, summary: state.outlineJson?.synopsis ?? c.summary,
      endingState: state.outlineJson?.endingState ?? c.endingState,
      assetIds: state.assets.filter((a) => a.kind === "prop" || (a.kind === "character" ? state.outlineJson?.characters : state.outlineJson?.scenes)?.some((p) => p.name === a.name)).map((a) => a.id),
      error: state.error };
  }) } };
}
