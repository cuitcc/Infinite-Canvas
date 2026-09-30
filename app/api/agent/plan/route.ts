import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { PLAN_SYSTEMS, extractJson } from "@/lib/agent-prompts";
import { parseScriptScene, resolveCharacterName, resolveDialogueSpeakers, resolveShotCharacters, resolveShotScene } from "@/lib/shot-continuity";
import { missingDialogueCharacters } from "@/lib/dialogue-plan";
import { completeScriptCast, expandCastGroups } from "@/lib/script-cast";
import type { StoryOutline } from "@/lib/agent-story";

interface StoryboardInput {
  outline?: unknown;
  count: number;
  dialoguePlan?: string[][] | null;
  dialogueContexts?: string[][];
  shotOffset?: number;
  assetNames?: string[];
  sceneNames?: string[];
  previousShots?: { scene?: string }[];
}

/** Identity/scene errors need a new plan, not a cosmetic warning attached to paid generation. */
function lockStoryboardContinuity(shots: StoryboardRecord[], input: StoryboardInput): void {
  let previous = input.previousShots?.at(-1)?.scene;
  for (const [i, shot] of shots.entries()) {
    const n = (input.shotOffset ?? 0) + i + 1;
    if (n > 1 && shot.shotType === "intro") throw new Error(`第${n}镜不能重新开场，请承接上一镜推进本章剧情`);
    if (input.sceneNames?.length) {
      const proposed = typeof shot.scene === "string" ? shot.scene : undefined;
      const scene = resolveShotScene(input.dialogueContexts?.[i] ?? [], proposed, input.sceneNames, previous);
      if (proposed && !/^(沿用上一场景|同上|承接上一场景)$/.test(proposed.trim()) && proposed.replace(/\s/g, "") !== scene.replace(/\s/g, "")) {
        throw new Error(`第${n}镜必须发生在“${scene}”，当前却写成“${proposed}”，请同步重写场景、画面和走位`);
      }
      shot.scene = scene;
      if (previous && previous !== scene) shot.transition = "cut";
      previous = scene;
    }
    if (input.assetNames) {
      const dialogue = resolveDialogueSpeakers(shot.dialogue as string[], input.assetNames);
      shot.characters = resolveShotCharacters(expandCastGroups(shot.characters as string[], input.assetNames), dialogue, input.assetNames);
      shot.dialogue = dialogue;
      if ((shot.characters as string[]).length > 4) throw new Error(`第${n}镜最多4名出镜人物，需留一张场景参考，请重新安排人物出镜`);
    }
  }
}

/** Retry only the broken shot; successful shots and assigned dialogue remain stable. */
async function repairStoryboard(shots: StoryboardRecord[], input: StoryboardInput): Promise<string[]> {
  const repairs: string[] = [];
  let previousShots = input.previousShots ?? [];
  for (let i = 0; i < shots.length; i++) {
    const local: StoryboardInput = { ...input, count: 1, shotOffset: (input.shotOffset ?? 0) + i,
      dialoguePlan: [shots[i].dialogue as string[]], dialogueContexts: [input.dialogueContexts?.[i] ?? []], previousShots };
    let shot = shots[i];
    let repaired = false;
    for (let attempt = 0; ; attempt++) {
      try { lockStoryboardContinuity([shot], local); break; }
      catch (error) {
        repaired = true;
        const issue = (error as Error).message;
        if (attempt >= 2) {
          shot = sourceBackedShot(shot, local);
          lockStoryboardContinuity([shot], local);
          repairs.push(`第${(local.shotOffset ?? 0) + 1}镜已根据剧本自动修复：${issue}`);
          break;
        }
        try {
          const raw = await createAgnesChatCompletion({ messages: [
            { role: "system", content: PLAN_SYSTEMS.storyboard },
            { role: "user", content: buildUser("storyboard", JSON.stringify(local), 1, undefined, [
              issue, `只修复此镜，不改台词；同步重写description/blocking/emotion等所有字段。原镜头：${JSON.stringify(shot)}`,
            ]) },
          ], temperature: 0.1, maxTokens: 4000 });
          shot = normalizeStoryboardData(extractJson(raw), 1, local.dialoguePlan, local.shotOffset).shots[0];
        } catch { /* A repair response may also fail; the bounded source fallback still runs. */ }
      }
    }
    if (repaired && !repairs.some((r) => r.startsWith(`第${(local.shotOffset ?? 0) + 1}镜`))) repairs.push(`第${(local.shotOffset ?? 0) + 1}镜身份/场景已自动修复`);
    shots[i] = shot;
    previousShots = [...previousShots, shot].slice(-2);
  }
  return repairs;
}

function sourceBackedShot(broken: StoryboardRecord, input: StoryboardInput): StoryboardRecord {
  const names = input.assetNames ?? [];
  const dialogue = resolveDialogueSpeakers(input.dialoguePlan?.[0] ?? [], names);
  const outline = input.outline as Partial<StoryOutline> | undefined;
  const script = typeof outline === "object" && typeof outline?.script === "string" ? outline.script : typeof outline === "string" ? outline : "";
  const sourceScene = script.split("\n").map(parseScriptScene).find((s) => s && input.sceneNames?.includes(s));
  const scene = resolveShotScene(input.dialogueContexts?.[0] ?? [], undefined, input.sceneNames ?? [], input.previousShots?.at(-1)?.scene ?? sourceScene);
  const context = (input.dialogueContexts?.[0] ?? []).map((c) => c.replace(/；精确台词=.*$/, "")).join("；");
  const speakers = resolveShotCharacters([], dialogue, names);
  const known = expandCastGroups(Array.isArray(broken.characters) ? broken.characters as string[] : [], names)
    .filter((name) => resolveCharacterName(name, names));
  const cast = [...new Set([...speakers, ...names.filter((name) => context.includes(name)), ...known])].slice(0, 4);
  if (speakers.length > 4) throw new Error("本镜说话人数超过模型参考容量，需要拆分对白");
  const description = `承接上镜：本镜发生在${scene}，出镜人物为${cast.join("、") || "无人物"}。${context || "从本章剧本中该地点的环境细节建立空间，保持前镜已完成动作的结果，不重演前情。"}镜头以稳定的四分之三侧面中近景记录当前这一拍，仅表现已列出的出镜人物，其他人物保持画外。起幅先交代人物与环境的位置关系，主光方向与场景参考一致；人物根据本拍目标调整视线和手部动作，保持前后动作的因果连接。对白期间焦点锁定当前说话人的脸部，倾听者以克制的眼神反应回应，嘴部保持闭合。机位沿既有轴线缓慢推近，幅度不超过画幅的百分之十；落幅停在当前人物动作或视线变化的终点，以该动作结果承接下一镜。`;
  return normalizeStoryboardData({ shots: [{ scene, characters: cast, dialogue, description,
    shotType: (input.shotOffset ?? 0) === 0 ? "intro" : dialogue.length ? "dialogue" : "transition",
    transition: "cut", purpose: `承接${scene}当前剧情，完成本拍动作与回应`, cutPoint: "本拍动作完成后在视线落点停稳",
    blocking: `画内只安排${cast.join("、") || "场景环境"}，遵循已有轴线和参考资产位置，其他人物留在画外`,
    emotion: "依据本镜上下文，通过视线停顿、眉眼和手部动作表现反应", sound: "低音量现场环境声，授权对白只来自独立台词块",
    camera: { size: dialogue.length ? "中近景" : "全景", angle: "四分之三侧面", movement: "固定", lens: "50mm", focus: "当前叙事主体" },
  }] }, 1, [dialogue], input.shotOffset).shots[0];
}

function buildUser(task: string, input: string, shotCount?: number, secondsPerShot?: string, retryIssues?: string[]): string {
  if (task === "storyboard") {
    const { outline, assetNames, sceneNames, count, dialoguePlan, dialogueContexts, chapterNumber = 1, shotOffset = 0, totalShots = count, previousShots } = JSON.parse(input) as {
      outline: unknown; assetNames: string[]; sceneNames?: string[]; count: number; dialoguePlan?: string[][] | null;
      dialogueContexts?: string[][]; chapterNumber?: number; shotOffset?: number; totalShots?: number; previousShots?: unknown[];
    };
    const scenes = sceneNames?.length ? `\n可用场景:${sceneNames.join("、")}` : "";
    // 台词分配表由代码按两句/长句分组,分镜师逐字照抄;每镜时长由服务端根据对白或空镜描述计算
    const planText = Array.isArray(dialoguePlan)
      ? `\n各镜台词分配表(dialogue 必须逐字照抄,禁止增删改):\n${dialoguePlan.map((lines, i) => `第${shotOffset + i + 1}镜:${lines.length ? lines.join("；") : "(无台词)"}`).join("\n")}`
      : "";
    // 校验不合规时带违规清单重试:提示词约束对 LLM 不可靠(台词分配的教训),改用"检查-反馈-重试"合同
    const retry = retryIssues?.length ? `\n\n你上一次的输出存在以下违规,本次必须全部修正:\n${retryIssues.map((s, i) => `${i + 1}.${s}`).join("\n")}` : "";
    return `当前章节:${chapterNumber}；本批是第${shotOffset + 1}至${shotOffset + count}镜，全章${totalShots}镜。仅全章第1镜可作为开场；后续批次不得重演开场。\n本批逐镜剧情事实:${JSON.stringify(dialogueContexts ?? [])}\n紧接的上一批镜头:${JSON.stringify(previousShots ?? [])}\n分镜数量:${count}\n每镜时长:自动计算（对白镜按口播时长，空镜按动作复杂度；只能使用视频模型支持的4-12秒档位）${planText}\n剧本大纲:\n${JSON.stringify(outline)}\n可用角色:${assetNames.join("、")}${scenes}\ncharacters 必须包含所有可见人物（包括沉默的倾听者和反应者），不能只列说话人；每镜最多4名人物并保留1张场景参考。scene 逐字匹配本章可用场景；逐镜剧情事实中的明确地点优先，不能借用历史地点。分镜之间必须逐拍推进：每镜只完成一个新的可见动作，不能复述上一镜、不能把同一事件换角度重复拍摄。对白正文只能出现在 dialogue 数组，description 和所有摄影字段禁止出现任何台词、引号或“说/自语/喊道”等说话描述。${retry}`;
  }
  // shotCount:outline 分支注入片长容量;storyboard 分支的 count 从 input 内部解析
  if ((task === "outline" || task === "chapter") && shotCount) {
    const retry = retryIssues?.length ? `\n上一版违规清单，逐项修复后重新输出：${retryIssues.join("；")}` : "";
    return `${input}\n(分镜数${shotCount}只是参考下限，不要为凑固定时长改写台词。先完成因果链和角色关系，再输出可拍摄对白；每两句短对白组成一个对白镜，一句长对白单独成镜；预留第1镜电影级开场、至少两个无对白过渡/反应镜头，空镜时长由画面动作复杂度决定。)${retry}`;
  }
  return shotCount ? `${input}\n(分镜数量备用:${shotCount})` : input;
}

function outlineScriptLines(script: unknown): string[] {
  if (typeof script === "string") return script.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(script)) return [];
  return script.flatMap((item) => {
    if (typeof item === "string") return item.split("\n").map((s) => s.trim()).filter(Boolean);
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const speaker = typeof row.speaker === "string" ? row.speaker : typeof row.name === "string" ? row.name : "";
      const text = typeof row.text === "string" ? row.text : typeof row.dialogue === "string" ? row.dialogue : "";
      return speaker && text ? [`${speaker}：${text}`] : [];
    }
    return [];
  });
}

type OutlineRecord = {
  title?: string;
  synopsis?: string;
  openingHook?: string;
  characters?: { name?: string; gender?: string; relationship?: string; voiceProfile?: string; [key: string]: unknown }[];
  scenes?: { name?: string; description?: string; [key: string]: unknown }[];
  beats?: { cause?: string; effect?: string; event?: string; [key: string]: unknown }[];
  script?: unknown;
  [key: string]: unknown;
};

/**
 * 大纲是给后续资产/分镜阶段使用的中间结构，不能因为模型漏了一个可选字段就
 * 把整个任务判死。这里做确定性的最小修复：只补结构默认值，不替模型编造
 * 新剧情；原始内容仍然保留，质量问题由 warnings 反馈给调用方。
 */
function normalizeOutlineData(data: unknown, sourceInput: string, chapter = false): OutlineRecord {
  const value = (data && typeof data === "object" ? data : {}) as OutlineRecord;
  const rawCharacters = Array.isArray(value.characters) ? value.characters : [];
  const characters = rawCharacters
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => ({
      ...item,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `角色${index + 1}`,
      gender: typeof item.gender === "string" && item.gender.trim() ? item.gender.trim() : "未知",
      relationship: typeof item.relationship === "string" && item.relationship.trim() ? item.relationship.trim() : "与主角存在待明确的剧情关系",
      voiceProfile: typeof item.voiceProfile === "string" && item.voiceProfile.trim() ? item.voiceProfile.trim() : "保持本角色在全片中的音色、年龄感和语速一致",
      appearance: typeof item.appearance === "string" && item.appearance.trim() ? item.appearance : "按剧情设定保持外观连续",
    }));
  // A speaking supporting role omitted from metadata is still part of the script.
  characters.push(...missingDialogueCharacters(value.script, characters));
  // 资产和对白分配至少需要一个可识别的主角/对手。只有模型完全漏掉角色
  // 时才使用占位身份，性别保留为“未知”，绝不从名字推断。
  if (!chapter && characters.length === 0) {
    characters.push(
      { name: "主角", gender: "未知", relationship: "故事主视角人物", voiceProfile: "保持本角色在全片中的音色、年龄感和语速一致", appearance: "按剧情设定保持外观连续" },
      { name: "对手", gender: "未知", relationship: "与主角形成主要冲突", voiceProfile: "保持本角色在全片中的音色、年龄感和语速一致", appearance: "按剧情设定保持外观连续" },
    );
  } else if (!chapter && characters.length === 1) {
    characters.push({ name: "对手", gender: "未知", relationship: `与${characters[0].name}形成主要冲突`, voiceProfile: "保持本角色在全片中的音色、年龄感和语速一致", appearance: "按剧情设定保持外观连续" });
  }
  const rawScenes = Array.isArray(value.scenes) ? value.scenes : [];
  const scenes = rawScenes
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => ({
      ...item,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `场景${index + 1}`,
      description: typeof item.description === "string" && item.description.trim() ? item.description : "按剧情发生地点保持空间、时间和光线连续",
    }));
  if (scenes.length === 0) scenes.push({ name: "主要场景", description: "按剧情发生地点保持空间、时间和光线连续" });
  const beats = (Array.isArray(value.beats) ? value.beats : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => ({
      ...item,
      index: typeof item.index === "number" ? item.index : index + 1,
      event: typeof item.event === "string" ? item.event : "",
      cause: typeof item.cause === "string" ? item.cause : "承接上一拍已发生的事实",
      effect: typeof item.effect === "string" ? item.effect : "推动下一拍的目标或关系变化",
    }));
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "未命名短剧";
  const synopsis = typeof value.synopsis === "string" && value.synopsis.trim()
    ? value.synopsis.trim()
    : (typeof value.logline === "string" && value.logline.trim() ? value.logline.trim() : `围绕“${sourceInput.trim().slice(0, 80)}”展开的连续剧情`);
  return {
    ...value,
    title,
    synopsis,
    characters,
    scenes,
    beats,
    script: value.script ?? [],
  };
}

function validateDialogueContinuity(data: unknown): string[] {
  const o = data as OutlineRecord;
  const names = new Set((o?.characters ?? []).map((c) => c.name).filter((n): n is string => Boolean(n)));
  const issues: string[] = [];
  for (const line of outlineScriptLines(o?.script)) {
    const m = /^([^\s：:]{1,20})[：:]\s*(.+)$/.exec(line.trim());
    if (!m || !names.has(m[1])) continue;
    const text = m[2].replace(/[（(][^）)]*[)）]/g, "").trim();
    if (/(?:\.{3}|…|……)\s*$/.test(text)) issues.push(`${m[1]}对白不能以省略号结尾，必须说完一个完整意思：${text}`);
    if (/(?:难道|但是|可是|因为|所以|如果|只是|而且|然后|却|但|还是)\s*[。！？!?]?$/.test(text)) issues.push(`${m[1]}对白停在连接词或半句话，必须补全上下文：${text}`);
  }
  return [...new Set(issues)];
}

function usableDialogueCount(data: unknown): number {
  const o = data as OutlineRecord;
  const names = new Set((o?.characters ?? []).map((c) => c.name).filter((n): n is string => Boolean(n)));
  return outlineScriptLines(o?.script).filter((line) => {
    const m = /^([^\s：:]{1,20})[：:]\s*(.+)$/.exec(line.trim());
    return Boolean(m && names.has(m[1]) && m[2].trim());
  }).length;
}

function requiresDialogue(task: string, input: string): boolean {
  if (task === "outline") return true;
  if (task !== "chapter") return false;
  // 小说原文可能是纯动作/心理描写，不能为了过校验凭空补对白；原创章节必须有可拍对白。
  try { return (JSON.parse(input) as { mode?: string }).mode !== "novel"; }
  catch { return true; }
}

function validateOutline(data: unknown): string[] {
  const o = data as OutlineRecord;
  const issues: string[] = [];
  if (!o || typeof o !== "object") return ["大纲必须是 JSON 对象"];
  if (!o.title || !o.synopsis) issues.push("必须有片名和完整梗概");
  if (!Array.isArray(o.characters) || o.characters.length < 2) issues.push("至少需要两个角色");
  const names = new Set((o.characters ?? []).map((c) => c.name).filter((n): n is string => Boolean(n)));
  for (const c of o.characters ?? []) {
    if (!c.gender || !/男|女|非二元|未知/.test(c.gender)) issues.push(`角色${c.name ?? "未命名"}必须明确 gender，禁止运行时猜性别`);
    if (!c.relationship) issues.push(`角色${c.name ?? "未命名"}缺少社会关系`);
    if (!c.voiceProfile) issues.push(`角色${c.name ?? "未命名"}缺少固定 voiceProfile`);
  }
  if (!Array.isArray(o.scenes) || o.scenes.length < 1) issues.push("至少需要一个可拍场景");
  if (!Array.isArray(o.beats) || o.beats.length < 4) issues.push("必须有至少四个因果推进 beat");
  for (const b of o.beats ?? []) {
    if (!b.event || !b.cause || !b.effect) issues.push("每个 beat 必须写清 event、cause、effect");
  }
  const scriptLines = outlineScriptLines(o.script);
  const dialogueLines = scriptLines.filter((l) => /^[^\s：:]{1,20}[：:]/.test(l));
  if (dialogueLines.length < 2) issues.push("剧本至少需要两句角色对白");
  for (const line of dialogueLines) {
    const speaker = line.split(/[：:]/, 1)[0];
    if (!names.has(speaker)) issues.push(`对白说话人${speaker}不在 characters 中`);
    const text = line.slice(line.indexOf("：") >= 0 ? line.indexOf("：") + 1 : line.indexOf(":") + 1).trim();
    if (/[。！？!?]?$/.test(text) && text.replace(/[。！？!?]/g, "").length < 3) issues.push(`${speaker}对白过短或是碎片：${text}`);
    if (/[（(].*[）)]/.test(text)) issues.push(`${speaker}对白混入舞台动作，动作必须放到独立方括号行`);
  }
  return [...new Set(issues)];
}

const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"] as const;
/** 运镜词 → 规范类别:子串匹配容易误伤("推开门"),只认显式运镜表述 */
const CAMERA_VERBS: [RegExp, string][] = [
  [/推镜|推近|推进|缓推/, "推"], [/拉镜|拉远|缓拉/, "拉"], [/摇镜|摇拍/, "摇"], [/横移|移镜|平移/, "移"],
  [/跟拍|跟随/, "跟"], [/升降|上升|下降/, "升降"], [/环绕|绕拍|弧形/, "环绕"], [/手持/, "手持"], [/甩镜/, "甩镜"], [/变焦/, "变焦"],
];

const STORYBOARD_PLACEHOLDERS = [
  "本镜承担的叙事功能",
  "本镜结束及切换动机",
  "可用场景名",
  "按时间顺序写起幅",
  "前景中景背景",
];

/** 分镜 description 只能描述一个连续动作；出现这些词通常意味着模型把多个镜头
 * 拼进了一镜，视频模型会自行重复前一段剧情或重新补对白。 */
const MULTI_SHOT_WORDS = /切至|切到|镜头切|画面切|转场至|随后切|然后切|下一镜|分屏|蒙太奇/;

function spokenBody(line: string): string {
  const i = line.search(/[：:]/);
  if (i < 0) return line.trim();
  return line.slice(i + 1)
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, "")
    .replace(/[。！？!?～…\s]+$/, "")
    .trim();
}

function descriptionContainsDialogue(description: string, dialoguePlan: string[][] | null | undefined): string | null {
  if (!description || !Array.isArray(dialoguePlan)) return null;
  for (const line of dialoguePlan.flat()) {
    const body = spokenBody(line);
    if (body.length >= 3 && description.includes(body)) return body;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 让分镜字段只承担画面叙事。模型偶尔会把“角色说：……”复制进 description，
 * 这里在校验前剥掉可识别的对白，避免同一句话同时进入画面提示和音频提示。 */
function stripDialogueMentions(value: unknown, dialoguePlan: string[][] | null | undefined): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const line of dialoguePlan?.flat() ?? []) {
    const body = spokenBody(line);
    if (body.length < 3) continue;
    const escaped = escapeRegExp(body);
    // 同一句所在的完整动作句一起移除，避免留下“低声自语”继续诱导模型开口。
    text = text.replace(new RegExp(`[^。！？!?；\\n]*(?:自语|说道|说|喊道|问道|回答|回应)[^。！？!?；\\n]*${escaped}[^。！？!?；\\n]*[。！？!?；]?`, "g"), "");
    text = text.replace(new RegExp(escaped, "g"), "");
  }
  return text.replace(/\s{2,}/g, " ").replace(/。{2,}/g, "。 ").trim();
}

const STORYBOARD_TYPES = new Set(["intro", "establishing", "dialogue", "reaction", "transition", "cutaway", "action", "climax", "outro"]);

type StoryboardRecord = {
  index?: number;
  scene?: string;
  description?: string;
  dialogue?: unknown;
  characters?: unknown;
  shotType?: string;
  purpose?: string;
  cutPoint?: string;
  transition?: string;
  lighting?: string;
  composition?: string;
  blocking?: string;
  emotion?: string;
  sound?: string;
  camera?: Record<string, unknown>;
  [key: string]: unknown;
};

/** 把模型输出的分镜补成后续视频节点可以稳定消费的结构。缺字段只补执行默认值，
 * 台词仍完全以代码生成的 dialoguePlan 为唯一来源。 */
function normalizeStoryboardData(data: unknown, count: number, dialoguePlan: string[][] | null | undefined, shotOffset = 0): { shots: StoryboardRecord[]; [key: string]: unknown } {
  const source = (data && typeof data === "object" ? data : {}) as { shots?: unknown[]; [key: string]: unknown };
  const rawShots = Array.isArray(source.shots) ? source.shots : [];
  const shots = Array.from({ length: Math.max(0, count) }, (_, index) => {
    const raw = (rawShots[index] && typeof rawShots[index] === "object" ? rawShots[index] : {}) as StoryboardRecord;
    const plannedDialogue = Array.isArray(dialoguePlan)
      ? (dialoguePlan[index] ?? [])
      : (Array.isArray(raw.dialogue) ? raw.dialogue.filter((line): line is string => typeof line === "string") : []);
    const type = typeof raw.shotType === "string" && STORYBOARD_TYPES.has(raw.shotType)
      ? raw.shotType
      : shotOffset + index === 0 ? "intro" : plannedDialogue.length ? "dialogue" : "transition";
    const visual = stripDialogueMentions(raw.description, dialoguePlan);
    const description = visual || (shotOffset + index === 0
      ? "远景平视建立故事发生地点与时间，前景的光影和环境细节先进入画面；镜头缓慢推近到叙事主体，主体在画面中呈现可见的异常或目标，情绪通过停顿、视线和身体重心变化体现，焦点从环境转向主体，最后在主体的关键动作完成处停稳并留下切点。"
      : "承接上镜的落幅状态，保持场景、人物站位、服装和光线连续；主体完成一个新的可见动作，镜头保持稳定并记录表情、手部和视线变化，焦点落在推动剧情的物件或人物上，动作终点形成明确切点。")
    return {
      ...raw,
      index: shotOffset + index + 1,
      shotType: type,
      // 对白分配表是唯一事实来源，模型不能自行增删、改写或跨镜搬运对白。
      dialogue: plannedDialogue,
      description: shotOffset + index > 0 && !description.startsWith("承接上镜") ? `承接上镜：${description}` : description,
      purpose: typeof raw.purpose === "string" && raw.purpose.trim() && !STORYBOARD_PLACEHOLDERS.includes(raw.purpose) ? raw.purpose : (shotOffset + index === 0 ? "建立地点、时间和核心悬念" : "推进当前目标并改变人物关系"),
      cutPoint: typeof raw.cutPoint === "string" && raw.cutPoint.trim() && !STORYBOARD_PLACEHOLDERS.includes(raw.cutPoint) ? raw.cutPoint : (shotOffset + index === 0 ? "悬念信息落幅后切入下一拍" : "动作终点或视线匹配完成后切换"),
      transition: raw.transition === "continue" ? "continue" : "cut",
      lighting: typeof raw.lighting === "string" && raw.lighting.trim() ? raw.lighting : "延续场景主光方向和色温，用明暗对比呈现情绪变化",
      composition: typeof raw.composition === "string" && raw.composition.trim() ? raw.composition : "前景遮挡制造层次，中景承载动作，背景提供叙事线索",
      blocking: typeof raw.blocking === "string" && raw.blocking.trim() ? raw.blocking : "沿180度轴线安排左右站位，明确人物朝向、视线和动作终点",
      emotion: typeof raw.emotion === "string" && raw.emotion.trim() ? raw.emotion : "通过眼神、呼吸、嘴角、肩颈和手部微动作呈现情绪变化",
      sound: typeof raw.sound === "string" && raw.sound.trim() ? raw.sound : "低音量环境声与一个关键拟音，给对白让位",
      characters: Array.from(new Set([
        ...(Array.isArray(raw.characters) ? raw.characters.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : []),
        ...plannedDialogue.map((line) => line.split(/[：:]/, 1)[0].trim()),
      ])),
      camera: {
        size: typeof raw.camera?.size === "string" ? raw.camera.size : plannedDialogue.length ? "近景" : "全景",
        movement: typeof raw.camera?.movement === "string" ? raw.camera.movement : plannedDialogue.length ? "固定" : "缓慢推近",
        angle: typeof raw.camera?.angle === "string" ? raw.camera.angle : "四分之三侧面",
        lens: typeof raw.camera?.lens === "string" ? raw.camera.lens : plannedDialogue.length ? "50mm" : "35mm",
        focus: typeof raw.camera?.focus === "string" ? raw.camera.focus : "锁定叙事主体",
        height: typeof raw.camera?.height === "string" ? raw.camera.height : "视线高度",
      },
    };
  });
  return {
    ...source,
    shots,
  };
}

/** 分镜产出校验:相邻景别/主运镜重复、衔接句缺失、台词与分配表不符。返回违规清单,空数组=合规 */
function validateStoryboard(data: unknown, count: number, dialoguePlan?: string[][] | null, shotOffset = 0): string[] {
  const shots = (data as { shots?: { description?: string; dialogue?: string[]; characters?: string[]; shotType?: string; purpose?: string; cutPoint?: string; blocking?: string; emotion?: string; sound?: string; camera?: { angle?: string; movement?: string; size?: string; lens?: string; focus?: string } }[] })?.shots;
  if (!Array.isArray(shots) || shots.length !== count) {
    return [`分镜数量必须严格等于${count}`];
  }
  const issues: string[] = [];
  let prevSize = "";
  let prevVerb = "";
  const fingerprints = new Map<string, number>();
  shots.forEach((s, i) => {
    const n = shotOffset + i + 1;
    const desc = s.description ?? "";
    if (n > 1 && !desc.slice(0, 60).includes("承接上镜")) issues.push(`第${n}镜 description 开头缺"承接上镜"衔接句`);
    const size = SHOT_SIZES.find((w) => desc.includes(w)) ?? "";
    const verb = CAMERA_VERBS.find(([re]) => re.test(desc))?.[1] ?? "";
    if (n > 1 && s.shotType === "intro") issues.push(`第${n}镜不能重新开场，必须承接此前剧情`);
    if (!s.shotType || !STORYBOARD_TYPES.has(s.shotType)) issues.push(`第${n}镜必须声明有效 shotType`);
    if (!s.purpose || !s.cutPoint || !s.blocking || !s.emotion || !s.sound) issues.push(`第${n}镜必须补齐 purpose/cutPoint/blocking/emotion/sound`);
    if (!s.camera?.lens || !s.camera.focus) issues.push(`第${n}镜必须补齐镜头焦段和焦点设计`);
    if (desc.length < 140) issues.push(`第${n}镜 description 细节不足，至少描述起幅、动作、情绪、运镜和落幅`);
    if (STORYBOARD_PLACEHOLDERS.some((p) => desc.includes(p) || String(s.purpose ?? "").includes(p) || String(s.cutPoint ?? "").includes(p))) {
      issues.push(`第${n}镜仍是模板占位内容，必须改成当前剧情的具体动作`);
    }
    if (MULTI_SHOT_WORDS.test(desc)) issues.push(`第${n}镜 description 包含多个镜头或转场动作，必须改为一个连续动作`);
    const repeatedDialogue = descriptionContainsDialogue(desc, dialoguePlan);
    if (repeatedDialogue) issues.push(`第${n}镜 description 重复了对白“${repeatedDialogue}”，对白只能出现在 dialogue 字段`);
    const fingerprint = desc.replace(/^承接上镜[：:]?/, "").replace(/[\s，。！？；、：:,.!?]/g, "");
    if (fingerprint.length >= 80) {
      const previous = fingerprints.get(fingerprint);
      if (previous) issues.push(`第${n}镜与第${previous}镜画面描述完全重复，必须推进新的动作或信息`);
      else fingerprints.set(fingerprint, n);
    }
    // 正反打常需保持相同景别/固定机位；只记录上一镜用于兼容旧格式，不把重复本身判为违规。
    if (s.camera?.angle && /正面|直视镜头/.test(s.camera.angle)) issues.push(`第${n}镜 camera.angle 禁止正面直视镜头,请改为侧面、四分之三侧面或过肩`);
    if (s.camera?.movement && /环绕|甩镜|变焦/.test(s.camera.movement)) issues.push(`第${n}镜 camera.movement 不适合对白口型,请改为固定、缓慢推近或小幅横移`);
    const speakers = (Array.isArray(s.dialogue) ? s.dialogue : [])
      .map((l) => /^([^：:]+)[：:]/.exec(l)?.[1]?.trim())
      .filter((speaker): speaker is string => Boolean(speaker));
    for (const speaker of speakers) if (!Array.isArray(s.characters) || !s.characters.includes(speaker)) issues.push(`第${n}镜说话人${speaker}必须出现在characters数组`);
    prevSize = size;
    prevVerb = verb;
    if (Array.isArray(dialoguePlan)) {
      const want = dialoguePlan[i] ?? [];
      const got = Array.isArray(s.dialogue) ? s.dialogue : [];
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        issues.push(`第${n}镜 dialogue 必须逐字等于分配表:${want.length ? want.join("；") : "(空数组)"}`);
      }
    }
  });
  if (shotOffset === 0 && shots[0]?.shotType !== "intro") issues.push("第1镜必须是 cinematic intro");
  if (!Array.isArray(dialoguePlan) && shotOffset === 0 && shots.length >= 4 && shots.filter((s) => s.shotType === "transition" || s.shotType === "cutaway").length < 2) issues.push("至少需要两个 transition/cutaway 过渡镜头");
  if (!Array.isArray(dialoguePlan) && shotOffset === 0 && shots.length >= 5 && !shots.some((s) => s.shotType === "reaction" || !(s.dialogue ?? []).length)) issues.push("需要至少一个无对白反应或静默镜头");
  return issues;
}


export async function POST(req: NextRequest) {
  try {
    const { task, input, shotCount, secondsPerShot } = (await req.json()) as { task?: string; input?: string; shotCount?: number; secondsPerShot?: string };
    const system = task ? PLAN_SYSTEMS[task] : undefined;
    if (!system || typeof input !== "string" || !input.trim()) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    let lastErr: Error | null = null;
    let retryIssues: string[] | undefined;
    // JSON 解析允许多轮重试；大纲字段校验本身只生成 warnings，不再阻断可恢复的任务。
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const raw = await createAgnesChatCompletion({
          messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount, secondsPerShot, retryIssues) }],
          temperature: task === "outline" || task === "storyboard" ? 0.2 : 0.35,
          maxTokens: 12000,
        });
        try {
          let data = extractJson(raw);
          // 分镜输出先做字段归一化，再把无法影响执行的质量项作为 warnings 返回。
          if (task === "storyboard") {
            const parsed = JSON.parse(input) as StoryboardInput;
            const normalized = normalizeStoryboardData(data, parsed.count, parsed.dialoguePlan, parsed.shotOffset);
            const outline = parsed.outline;
            if (outline && typeof outline === "object" && typeof (outline as StoryOutline).script === "string" && Array.isArray((outline as StoryOutline).characters)) {
              const repairedOutline = completeScriptCast(outline as StoryOutline,
                normalized.shots.flatMap((shot) => shot.characters as string[]));
              const added = repairedOutline.characters.filter((c) => !parsed.assetNames?.includes(c.name));
              parsed.assetNames = repairedOutline.characters.map((c) => c.name);
              parsed.outline = repairedOutline;
              normalized.additionalCharacters = added;
            }
            const repairs = await repairStoryboard(normalized.shots, parsed);
            normalized.repairs = repairs;
            data = normalized;
            const issues = validateStoryboard(data, parsed.count, parsed.dialoguePlan, parsed.shotOffset);
            if (issues.length) {
              // 镜头数量、对白分配和执行字段已经在 normalizeStoryboardData 中固定；
              // 景别重复、描述过短、转场数量不足等属于质量提醒，不再阻断后续视频生成。
              console.warn(`[agent/plan] storyboard 结构提醒${issues.length}处:`, issues.join(" | "));
              return NextResponse.json({ ok: true, data, warnings: issues.slice(0, 16) });
            }
            return NextResponse.json({ ok: true, data });
          }
          if (task === "outline" || task === "chapter") {
            const repaired = normalizeOutlineData(data, input, task === "chapter");
            const issues = validateOutline(repaired);
            const dialogueIssues = validateDialogueContinuity(repaired);
            const dialogueCount = usableDialogueCount(repaired);
            if (requiresDialogue(task!, input) && dialogueCount < 2) {
              const missingDialogue = "script 必须包含至少两句带规范角色名的对白（角色名：台词）；不能只输出 synopsis、beats 或动作描写，否则无法生成有声视频";
              if (attempt < 3) {
                retryIssues = [...dialogueIssues, missingDialogue];
                console.warn(`[agent/plan] ${task} 缺少可用对白，自动重试第${attempt + 1}次`);
                continue;
              }
              return NextResponse.json({ error: `大纲未生成可用对白：${missingDialogue}`, issues: [missingDialogue] }, { status: 422 });
            }
            if (dialogueIssues.length && attempt < 3) {
              retryIssues = dialogueIssues;
              console.warn(`[agent/plan] ${task} 对白连贯性重试:`, dialogueIssues.join(" | "));
              continue;
            }
            if (issues.length || dialogueIssues.length) {
              // 字段质量提醒不阻断可恢复任务；对白半句只在重试次数用尽后保留，避免静默改写用户剧本。
              console.warn(`[agent/plan] ${task} 结构提醒${issues.length + dialogueIssues.length}处:`, [...issues, ...dialogueIssues].join(" | "));
              return NextResponse.json({ ok: true, data: repaired, warnings: [...issues, ...dialogueIssues].slice(0, 12) });
            }
            return NextResponse.json({ ok: true, data: repaired });
          }
          return NextResponse.json({ ok: true, data });
        } catch (e) {
          // 记录原始输出头部与尾部,便于定位是截断、闭合符错序还是格式跑偏
          console.error(`[agent/plan] ${task} 第${attempt + 1}次 JSON 解析失败(长度${raw.length}),原始输出头部:`, raw.slice(0, 300), "尾部:", raw.slice(-200));
          throw e;
        }
      } catch (e) {
        lastErr = e as Error;
      }
    }
    return NextResponse.json({ error: `规划失败:${lastErr?.message ?? "未知错误"}` }, { status: 502 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
