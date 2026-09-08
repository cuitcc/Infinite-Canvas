/** 剧本台词 → 分镜台词分配表（代码级确定性分配）。
 *
 * 为什么要代码分配而不是让分镜 LLM 自己分:两轮实测证明提示词约束管不住——
 * LLM 会把全部台词塞进后面的镜头、或跳过中间台词挑后面的,导致剧情断裂。
 * 分配策略(用户定策):从剧本第一句起按顺序依次装入,每镜封顶 1~3 句,
 * 分镜数不够时剩余台词直接舍弃(前缀语义),绝不跳句、绝不追求覆盖全部剧本。
 *
 * 返回:string[shotCount][],每项是该镜的台词行("角色名：台词"),按序照抄进分镜。 */

/** 元信息行的说话人(大纲的结构字段与舞台指示,不是对白) */
const META_SPEAKERS = /^(梗概|大纲|剧情|角色|人物|场景|题目|片名|片头|类型|标题|旁白|画外音|屏幕|字幕|画面|镜头|备注|说明)$/;

interface ScriptLine {
  speaker: string;
  text: string;
}

/** 归一说话人:精确匹配优先;否则取包含关系中最长的规范名(最长=最具体,如"索尔"→"指挥官索尔") */
function canonicalSpeaker(spoken: string, names: Set<string>): string | null {
  if (names.has(spoken)) return spoken;
  let best = "";
  for (const n of names) {
    if ((n.includes(spoken) || spoken.includes(n)) && n.length > best.length) best = n;
  }
  return best || null;
}

function pushLine(lines: ScriptLine[], spoken: string, rawText: string, names: Set<string> | null) {
  // 剥掉括号动作神态(舞台指示)与半角"..."(省略号收尾会引诱模型续写台词),只保留要念出声的台词
  const text = rawText.replace(/[（(][^）)]*[)）]/g, "").replace(/[。～…\s]+$/, "").replace(/\.{2,}$/, "").trim();
  if (!text) return;
  if (names) {
    const canonical = canonicalSpeaker(spoken, names);
    if (!canonical) return;
    lines.push({ speaker: canonical, text });
  } else {
    if (META_SPEAKERS.test(spoken)) return;
    lines.push({ speaker: spoken, text });
  }
}

/** 从剧本文本提取对白行。names 提供时按"互相包含"匹配角色名并把说话人归一成规范名;
 * names 为 null 时不过滤说话人,只排除元信息行(兜底路径)。
 * 行级容错:大纲模型会把多句台词挤在同一物理行("A：xx。B：yy。A：zz",实测 2026-09-07 全部台词
 * 一行导致第一镜装入全部台词),行内按"句末标点+说话人冒号"边界二次切分,不指望 LLM 守换行格式。 */
function extractDialogue(script: string, names: Set<string> | null): ScriptLine[] {
  const lines: ScriptLine[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    const m = /^([^\s：:]{1,10})[：:]\s*(.+)$/.exec(line);
    if (!m) continue;
    const body = m[2];
    const boundary = /(?:^|[。！？；～])\s*[^\s：:，。！？；]{1,10}[：:]/g;
    const cuts: { speaker: string; from: number; textStart: number }[] = [];
    for (const b of body.matchAll(boundary)) {
      const sp = b[0].replace(/^[。！？；～]/, "").replace(/[：:]$/, "").trim();
      cuts.push({ speaker: sp, from: b.index, textStart: b.index + b[0].length });
    }
    if (cuts.length <= 1) {
      pushLine(lines, m[1], body, names);
    } else {
      // 首段归行首说话人,其余各段归各边界处的说话人,段尾句末标点由 pushLine 剥除
      pushLine(lines, m[1], body.slice(0, cuts[0].from), names);
      for (let i = 0; i < cuts.length; i++) {
        const to = i + 1 < cuts.length ? cuts[i + 1].from : body.length;
        pushLine(lines, cuts[i].speaker, body.slice(cuts[i].textStart, to), names);
      }
    }
  }
  return lines;
}

/** 每镜台词封顶:4秒镜1句,6秒镜2句,8秒及以上3句(剧本台词每句≤15字,约4秒) */
function shotLineCap(secondsPerShot: number): number {
  return secondsPerShot <= 4 ? 1 : secondsPerShot <= 6 ? 2 : 3;
}

/** 全片可装入的台词总句数(分镜容量):超出容量的台词被前缀截断语义舍弃 */
export function scriptCapacity(shotCount: number, secondsPerShot: number): number {
  return shotCount * shotLineCap(secondsPerShot);
}

/** 剧本台词量下限:分镜容量的一半(低于此值后半片必然是无台词空镜,实测 6 镜只写 6 句) */
export function minScriptLines(shotCount: number, secondsPerShot: number): number {
  return Math.max(4, Math.ceil(scriptCapacity(shotCount, secondsPerShot) / 2));
}

/** 台词文本中的亲属称谓:提及但角色表中没有时即为"幽灵角色"(实测台词喊"姐姐"而全片无此人) */
const FAMILY_TITLES = ["姐姐", "妹妹", "哥哥", "弟弟", "爸爸", "妈妈", "父亲", "母亲", "爷爷", "奶奶", "外公", "外婆", "叔叔", "阿姨"];

/** 大纲剧本硬校验(分配前的最后一道闸)。提示词约束对 LLM 不可靠(分镜阶段三连教训),大纲同样上
 * "检查-反馈-重试"合同。实测翻车:6镜42秒只写6句台词(后4镜全程无声)、1字超短句"唔..."、
 * 台词提及"姐姐"但角色表没有(资产阶段不会生成,画面里对着空气说话)。 */
export function auditScript(script: string, characterNames: string[], minLines: number | null, capacityLines: number | null = null): string[] {
  const names = new Set(characterNames);
  // 用 null(names 过滤关)提取:审计要看全部原始行,而不是分配层静默丢弃后的残部
  const lines = extractDialogue(script, null);
  const issues: string[] = [];
  // 1) 说话人必须是角色表成员:分配层对陌生人台词是静默丢弃的,内容会无声消失
  const unknown = [...new Set(lines.map((l) => l.speaker).filter((sp) => !canonicalSpeaker(sp, names)))];
  if (unknown.length) {
    issues.push(`台词说话人 ${unknown.join("、")} 不在 characters 角色表中,对白行说话人必须与 characters 的 name 逐字一致`);
  }
  // 2) 句长带宽:下限杀"唔..."式超短句(一镜念不满还诱发音频即兴填充),上限防一镜超时
  const badLen = lines.filter((l) => l.text.length < 9 || l.text.length > 20);
  if (badLen.length) {
    issues.push(`每句台词必须9~20字(目标12~15字):${badLen.map((l) => `"${l.text}"(${l.text.length}字)`).join("、")}`);
  }
  // 3) 省略号禁令:实测"这...这是"会诱导模型拖长音或即兴续写
  const dotted = lines.filter((l) => l.text.includes("...") || l.text.includes("…"));
  if (dotted.length) {
    issues.push(`台词中禁止省略号(.../…),改写成完整句:${dotted.map((l) => `"${l.text}"`).join("、")}`);
  }
  // 4) 台词量下限:写太少则分镜装不满,后半片全程无对白
  if (minLines && lines.length < minLines) {
    issues.push(`台词仅${lines.length}句,至少需要${minLines}句(分镜容量的一半),请继续写后续剧情的对白`);
  }
  // 5) 幽灵亲属:台词提及亲属称谓但角色表无此角色,画面没有对应参考图可挂
  const mentioned = new Set<string>();
  for (const l of lines) {
    for (const t of FAMILY_TITLES) {
      if (l.text.includes(t) && !names.has(t) && ![...names].some((n) => n.includes(t))) mentioned.add(t);
    }
  }
  if (mentioned.size) {
    issues.push(`台词提及 ${[...mentioned].join("、")} 但 characters 中没有该角色:要么将其加入 characters(会生成参考图),要么改写台词不再提及`);
  }
  // 6) 角色必须在可装入容量内有戏份(实测:对立面"猎人"的台词全部落在容量之外,立绘资产白生成、剧情留死钩子)
  if (capacityLines) {
    const loadedSpeakers = lines.slice(0, capacityLines).map((l) => l.speaker);
    const orphan = characterNames.filter(
      (n) => !loadedSpeakers.some((sp) => sp === n || sp.includes(n) || n.includes(sp)),
    );
    if (orphan.length && lines.length > 0) {
      issues.push(`角色 ${orphan.join("、")} 的台词全部落在可装入容量(前${capacityLines}句)之外,这些戏份会被截断丢弃,资产也将白生成:要么让其在台词前段就有戏份,要么从 characters 中移除该角色`);
    }
  }
  return issues;
}

export function planShotDialogue(
  script: string,
  characterNames: string[],
  shotCount: number,
  secondsPerShot: number,
): string[][] {
  const all = extractDialogue(script, new Set(characterNames));
  // 兜底:严格过滤误杀(0句,或只剩单一说话人——对白剧至少两个角色攻防)时,
  // 降级为不过滤说话人,只排除元信息行
  const speakers = new Set(all.map((l) => l.speaker));
  let lines = all;
  if (lines.length === 0 || speakers.size <= 1) {
    const loose = extractDialogue(script, null);
    if (loose.length > lines.length) lines = loose;
  }

  const perShot = shotLineCap(secondsPerShot);

  const plan: string[][] = [];
  let idx = 0;
  for (let i = 0; i < shotCount; i++) {
    plan.push(lines.slice(idx, idx + perShot).map((l) => `${l.speaker}：${l.text}`));
    idx += perShot;
  }
  return plan; // 超出总容量的台词自然舍弃
}
