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

  // 每镜封顶:4秒镜1句,6秒镜2句,8秒及以上3句(剧本台词每句≤15字,约4秒)
  const perShot = secondsPerShot <= 4 ? 1 : secondsPerShot <= 6 ? 2 : 3;

  const plan: string[][] = [];
  let idx = 0;
  for (let i = 0; i < shotCount; i++) {
    plan.push(lines.slice(idx, idx + perShot).map((l) => `${l.speaker}：${l.text}`));
    idx += perShot;
  }
  return plan; // 超出总容量的台词自然舍弃
}
