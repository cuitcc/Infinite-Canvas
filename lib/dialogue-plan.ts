import { parseScriptScene, resolveCharacterName } from "./shot-continuity";

/** 元信息行的说话人(大纲的结构字段与舞台指示,不是对白) */
const META_SPEAKERS = /^(梗概|大纲|剧情|角色|人物|场景|题目|片名|片头|类型|标题|旁白|画外音|屏幕|字幕|画面|镜头|备注|说明|动作|音效|音乐|转场|特写|近景|中景|全景)$/;

interface ScriptLine {
  speaker: string;
  text: string;
}

export const VIDEO_DURATION_SECONDS = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type VideoDurationSeconds = (typeof VIDEO_DURATION_SECONDS)[number];

/** 归一说话人：精确匹配优先，仅接受无歧义的职衔变体，不按子串合并人物 */
function canonicalSpeaker(spoken: string, names: Set<string>): string | null {
  return resolveCharacterName(spoken, [...names]) ?? null;
}

export function normalizeDialogueBody(rawText: string): string {
  // 剥掉括号动作神态(舞台指示)与半角"..."(省略号收尾会引诱模型续写台词),只保留要念出声的台词
  return rawText
    // Only leading stage directions are annotations. Parentheses inside speech may contain facts.
    .replace(/^(?:\s*(?:[（(][^）)]*[)）]|[\[【][^\]】]*[\]】]))+\s*/, "")
    // 去掉模型包裹台词的引号，避免后续注入时出现嵌套引号并诱发重复/续写。
    .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, "")
    .replace(/[。！？!?～…\s]+$/, "")
    .replace(/\.{2,}$/, "")
    .trim();
}

function pushLine(lines: ScriptLine[], spoken: string, rawText: string, names: Set<string> | null) {
  const text = normalizeDialogueBody(rawText);
  if (!text) return;
  if (META_SPEAKERS.test(spoken) && !names?.has(spoken)) return;
  if (names) {
    const canonical = canonicalSpeaker(spoken, names);
    // Missing cast metadata must be repaired upstream; never erase the person's speech.
    lines.push({ speaker: canonical ?? spoken, text });
  } else {
    if (META_SPEAKERS.test(spoken)) return;
    lines.push({ speaker: spoken, text });
  }
}

/** 从剧本文本提取对白行。names 提供时按精确姓名或无歧义职衔变体归一说话人;
 * names 为 null 时不过滤说话人,只排除元信息行(兜底路径)。
 * 行级容错:大纲模型会把多句台词挤在同一物理行("A：xx。B：yy。A：zz",实测 2026-09-07 全部台词
 * 一行导致第一镜装入全部台词),行内按"句末标点+说话人冒号"边界二次切分,不指望 LLM 守换行格式。 */
function normalizeScriptText(script: unknown): string {
  if (typeof script === "string") return script;
  if (Array.isArray(script)) {
    return script.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const speaker = typeof row.speaker === "string" ? row.speaker : typeof row.name === "string" ? row.name : "";
        const text = typeof row.text === "string" ? row.text : typeof row.dialogue === "string" ? row.dialogue : "";
        return speaker && text ? `${speaker}：${text}` : text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (script && typeof script === "object") {
    const row = script as Record<string, unknown>;
    for (const key of ["text", "content", "dialogue", "script"]) {
      if (typeof row[key] === "string") return row[key] as string;
    }
  }
  return "";
}

export function extractDialogue(script: unknown, names: Set<string> | null): ScriptLine[] {
  const lines: ScriptLine[] = [];
  const scriptText = normalizeScriptText(script);
  for (const raw of scriptText.split("\n")) {
    const line = raw.trim();
    if (/^[\[【]/.test(line)) continue;
    const m = /^([^：:]{1,60}?)(?:[（(][^）)]*[)）])?[：:]\s*(.+)$/.exec(line);
    if (!m) continue;
    const speaker = m[1].trim();
    const body = m[2];
    const boundary = /(?:^|[。！？!?；;～])\s*[^：:，。！？!?；;\n]{1,60}[：:]/g;
    const cuts: { speaker: string; from: number; textStart: number }[] = [];
    for (const b of body.matchAll(boundary)) {
      const sp = b[0].replace(/^[。！？!?；;～]/, "").replace(/[：:]$/, "").trim();
      // A colon in speech (e.g. “目标：奥尔特云”) is not a new speaker.
      if (!names || !canonicalSpeaker(sp, names)) continue;
      cuts.push({ speaker: sp, from: b.index + (/^[。！？!?；;～]/.test(b[0]) ? 1 : 0), textStart: b.index + b[0].length });
    }
    if (cuts.length === 0) {
      pushLine(lines, speaker, body, names);
    } else {
      // 首段归行首说话人,其余各段归各边界处的说话人,段尾句末标点由 pushLine 剥除
      pushLine(lines, speaker, body.slice(0, cuts[0].from), names);
      for (let i = 0; i < cuts.length; i++) {
        const to = i + 1 < cuts.length ? cuts[i + 1].from : body.length;
        pushLine(lines, cuts[i].speaker, body.slice(cuts[i].textStart, to), names);
      }
    }
  }
  return lines;
}

/** These people already speak in the script; fill missing asset metadata without rewriting it. */
export function missingDialogueCharacters(script: unknown, characters: { name?: string }[]) {
  const names = new Set(characters.map((c) => c.name).filter((name): name is string => Boolean(name)));
  return [...new Set(extractDialogue(script, names).map((l) => l.speaker).filter((n) => !names.has(n)))].map((name) => ({
    name, gender: "未知", relationship: "按剧本中与其他角色的对话和行动关系呈现",
    appearance: `${name}的独立角色设定；从剧本提取已有外观信息，未描述的外观首次确定后跨镜复用，不与其他角色共用脸部特征，不猜测性别`,
    wardrobe: "按本章场景与职务设计固定服装，跨镜保持一致",
    voiceProfile: "本角色首次生成时建立独立音色，后续沿用；性别未知，不擅自推断",
  }));
}

export function assertDialogueCoverage(script: unknown, characterNames: string[], plan: string[][]): void {
  const names = new Set(characterNames);
  const expected = extractDialogue(script, names);
  const missing = expected.filter((line) => !names.has(line.speaker));
  if (missing.length) throw new Error(`剧本说话人缺少角色资产：${[...new Set(missing.map((l) => l.speaker))].join("、")}；原台词已保留，请先补齐角色`);
  // Compare every spoken character with its speaker, including duplicates and their order.
  const tokens = (lines: ScriptLine[]) => lines.flatMap((l) => Array.from(l.text.replace(/\s/g, "")).map((c) => `${l.speaker}:${c}`));
  const actual = plan.flatMap((lines) => lines.map((line) => {
    const match = /^([^：:]+)[：:]([\s\S]*)$/.exec(line);
    if (!match) throw new Error(`分镜对白缺少说话人：${line}`);
    return { speaker: canonicalSpeaker(match[1].trim(), names) ?? match[1].trim(), text: match[2].trim() };
  }));
  if (JSON.stringify(tokens(expected)) !== JSON.stringify(tokens(actual))) {
    throw new Error("剧本与分镜台词不完整或顺序不一致，已停止生成；请重新规划本章分镜，不能沿用旧版漏词分镜");
  }
}

/** 保守的普通话时间预算，含标点停顿；不靠加速念词凑满镜头。 */
export function estimateSpeechSeconds(text: string): number {
  const words = text.replace(/^[^：:]+[：:]\s*/, "");
  const chars = words.replace(/[\s，,。.!！?？、;；:："“”]/g, "").length;
  const pauses = (words.match(/[，,。.!！?？、;；]/g) ?? []).length;
  return chars / 3.5 + pauses * 0.18;
}

/** 按视频模型的整数秒档位归一。模型能力上限由 Agnes 的 4-12 秒档位决定，
 * 剧本本身不再用固定时长或字数反向约束。 */
export function clampVideoDuration(seconds: number): VideoDurationSeconds {
  const value = Number.isFinite(seconds) ? Math.ceil(seconds) : 4;
  const nearest = VIDEO_DURATION_SECONDS.find((s) => s >= value);
  return nearest ?? VIDEO_DURATION_SECONDS[VIDEO_DURATION_SECONDS.length - 1];
}

/** Split at clause boundaries within the model's capacity; carry every character forward. */
function splitSpeechText(text: string): string[] {
  const parts: string[] = [];
  let rest = Array.from(text);
  while (estimateSpeechSeconds(`人物：${rest.join("")}`) > 10.5) {
    let end = 1;
    while (end < rest.length && estimateSpeechSeconds(`人物：${rest.slice(0, end + 1).join("")}`) <= 10.5) end++;
    let boundary = end;
    for (let i = end - 1; i >= Math.floor(end / 2); i--) {
      if (/[，,。.!！?？；;]/.test(rest[i])) { boundary = i + 1; break; }
    }
    parts.push(rest.slice(0, boundary).join("").trim());
    rest = rest.slice(boundary);
  }
  if (rest.join("").trim()) parts.push(rest.join("").trim());
  return parts;
}

function plannedContexts(script: unknown, names: string[]): ScriptDialogueContext[] {
  return extractScriptDialogueContexts(script, names).flatMap((c) => {
    const text = c.line.slice(c.line.indexOf("：") + 1);
    return splitSpeechText(text).map((part, i) => ({ ...c, line: `${c.speaker}：${part}`,
      precedingAction: i === 0 ? c.precedingAction : "承接同一人物上一句未完成的讲述，不重演动作" }));
  });
}

/** 两句为一个对白单元；一条预计需要较长口播时间时单独占镜。 */
export function groupDialogueLines(script: unknown, characterNames: string[]): string[][] {
  const contexts = plannedContexts(script, characterNames);
  if (!contexts.length) return [];
  const unknown = contexts.find((c) => !characterNames.includes(c.speaker));
  if (unknown) throw new Error(`说话人${unknown.speaker}缺少角色设定，台词已保留，请先补齐角色资产`);
  const groups: string[][] = [];
  let current: string[] = [];
  let currentSeconds = 0;
  let previousScene = "";
  for (const context of contexts) {
    const scene = context.scene;
    if (scene && previousScene && scene !== previousScene && current.length) {
      groups.push(current); current = []; currentSeconds = 0;
    }
    previousScene = scene || previousScene;
    const value = context.line;
    const speechSeconds = estimateSpeechSeconds(value);
    const isLong = speechSeconds >= 4.8;
    // 两句短对白共享一个镜头；长句、或加上第二句会超过 10 秒时独立成镜。
    if (current.length >= 2 || (current.length > 0 && (isLong || currentSeconds + speechSeconds + 0.65 > 9.5))) {
      groups.push(current);
      current = [];
      currentSeconds = 0;
    }
    current.push(value);
    currentSeconds += speechSeconds;
    if (isLong) {
      groups.push(current);
      current = [];
      currentSeconds = 0;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** 对白镜按口播时长计算；空镜按画面动作描述的复杂度计算。 */
export function estimateShotDuration(dialogue: string[], description = "", shotType?: string): VideoDurationSeconds {
  if (dialogue.length > 0) {
    const speech = dialogue.reduce((sum, line) => sum + estimateSpeechSeconds(line), 0);
    const pause = dialogue.length > 1 ? 0.65 : 0.35;
    return clampVideoDuration(speech + pause + 0.9);
  }
  const visualChars = description.replace(/[\s，。！？；、：:,.!?]/g, "").length;
  const actionCount = (description.match(/移动|走|跑|转身|抬头|低头|拿起|放下|打开|关闭|观察|停下|推近|拉远|横移|跟拍/g) ?? []).length;
  const base = shotType === "intro" ? 5 : shotType === "transition" || shotType === "cutaway" ? 4 : 4;
  return clampVideoDuration(base + Math.min(5, Math.ceil(visualChars / 90)) + Math.min(2, actionCount * 0.5));
}

export function planShotDialogue(
  script: unknown,
  characterNames: string[],
  shotCount: number,
): string[][] {
  const groups = groupDialogueLines(script, characterNames);
  shotCount = Math.max(shotCount, groups.length + (shotCount > 1 ? 1 : 0));
  const plan: string[][] = Array.from({ length: shotCount }, () => []);
  if (!groups.length) return plan;
  // 第一镜固定保留给电影级开场：先建立空间、时间和危机，不强迫人物在 establishing
  // 镜头里抢台词。只有对白数量足够分散时才额外留中段静默镜，避免把大量对白挤到末镜。
  const reserved = new Set<number>();
  if (shotCount > 1) reserved.add(0);
  if (shotCount >= 8 && groups.length <= shotCount - 2) reserved.add(Math.floor(shotCount / 2));
  const dialogueSlots = Array.from({ length: shotCount }, (_, i) => i).filter((i) => !reserved.has(i));
  groups.forEach((group, i) => {
    const slot = dialogueSlots[Math.min(i, Math.max(0, dialogueSlots.length - 1))] ?? 0;
    plan[slot].push(...group);
  });
  return plan;
}

export interface ScriptDialogueContext {
  speaker: string;
  line: string;
  scene: string;
  precedingAction: string;
}

/** Preserve the scene/action immediately surrounding each line of dialogue. */
export function extractScriptDialogueContexts(script: unknown, characterNames: string[]): ScriptDialogueContext[] {
  const names = new Set(characterNames);
  const text = normalizeScriptText(script);
  const out: ScriptDialogueContext[] = [];
  let scene = "";
  let actions: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sceneMatch = parseScriptScene(line);
    if (sceneMatch) { scene = sceneMatch; actions = [line]; continue; }
    const dialogue = extractDialogue(line, names);
    if (dialogue.length) {
      for (const item of dialogue) {
        out.push({ speaker: item.speaker, line: `${item.speaker}：${item.text}`, scene,
          precedingAction: actions.slice(-3).join("；") });
      }
      actions = [];
    } else if (/^[[【]/.test(line) || !/^[^\\s：:]{1,20}[：:]/.test(line)) {
      actions.push(line);
    }
  }
  return out;
}

/** Same deterministic grouping as planShotDialogue, with context attached. */
export function planShotContexts(script: unknown, characterNames: string[], shotCount: number): string[][] {
  const contexts = plannedContexts(script, characterNames);
  const groups = groupDialogueLines(script, characterNames);
  shotCount = Math.max(shotCount, groups.length + (shotCount > 1 ? 1 : 0));
  const plan: string[][] = Array.from({ length: shotCount }, () => []);
  if (!groups.length) return plan;
  const reserved = new Set<number>();
  if (shotCount > 1) reserved.add(0);
  if (shotCount >= 8 && groups.length <= shotCount - 2) reserved.add(Math.floor(shotCount / 2));
  const slots = Array.from({ length: shotCount }, (_, i) => i).filter((i) => !reserved.has(i));
  let cursor = 0;
  groups.forEach((group, i) => {
    const slot = slots[Math.min(i, Math.max(0, slots.length - 1))] ?? 0;
    const lines = contexts.slice(cursor, cursor + group.length);
    cursor += group.length;
    plan[slot].push(...lines.map((c) => `场景=${c.scene || "沿用上一场景"}；对白前置动作=${c.precedingAction || "承接上一镜落幅"}；精确台词=${c.line}`));
  });
  return plan;
}
