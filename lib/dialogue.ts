/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 给"……说：台词"格式的行补上引号边界,让模型明确哪段是要念出声的台词;已有引号则原样返回 */
function quoteSpoken(line: string): string {
  if (/["“”]/.test(line)) return line;
  const m = /^([^：:]*说)\s*[：:]\s*(.+)$/.exec(line);
  if (!m) return line;
  return `${m[1]}："${m[2].trim()}"`;
}

/** 台词框内容 → 注入提示词的文本。
 * speakerMap:第 i+1 张参考图对应的角色名(场景图可标"场景"等非说话人名)。
 * 提供且每句台词的说话人都能按名字绑定到参考图时,支持 M 句台词 ≤ N 张参考图,不说台词的角色明确保持倾听;
 * 否则回退:多行台词且行数=参考图数时按行序绑定;都不适用返回 null(调用方回退到通用注入) */
export function buildDialogueInjection(dialogue: string, referenceCount: number, speakerMap?: string[]): string | null {
  const lines = dialogue.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  if (speakerMap && speakerMap.length === referenceCount) {
    const parsed = lines.map((line) => {
      const m = /^([^：:]+)[：:]\s*(.+)$/.exec(line);
      return { speaker: m ? m[1].trim() : "", text: (m ? m[2] : line).trim() };
    });
    const refIndex = (name: string) => speakerMap.findIndex((n) => n === name);
    if (parsed.length > 0 && parsed.every((p) => p.speaker && p.text && refIndex(p.speaker) >= 0)) {
      const header = "台词按角色分配,谁说台词谁开口,口型与台词精确同步:";
      const parts = parsed.map((p) => `第${refIndex(p.speaker) + 1}张参考图中的${p.speaker}说："${p.text}"`);
      const listeners = speakerMap
        .map((name, i) => ({ name, i }))
        .filter(({ name }) => !parsed.some((p) => p.speaker === name))
        .map(({ name, i }) =>
          `第${i + 1}张参考图中的${name}不说台词${name.includes("场景") ? ",仅作场景背景参考" : ",保持倾听和自然反应"}`);
      return `${header}\n${parts.join("\n")}${listeners.length ? `\n${listeners.join("，")}` : ""}`;
    }
  }

  if (referenceCount >= 2 && lines.length === referenceCount) {
    const header = "台词按角色分配,谁说台词谁开口,其余人物保持倾听,口型与台词精确同步:";
    // 用户已写明"参考图N/第N张"绑定时原样使用(仅补引号边界),避免二次编号冲突
    if (lines.some((l) => /参考图\s*\d|第\s*\d\s*张/.test(l))) {
      return `${header}\n${lines.map(quoteSpoken).join("\n")}`;
    }
    const parts = lines.map((line, i) => {
      const m = /^([^：:]+)[：:]\s*(.*)$/.exec(line);
      const speaker = m?.[1]?.trim() ?? "";
      const text = (m?.[2] ?? line).trim();
      const who = speaker || "人物";
      return `第${i + 1}张参考图中的${who}说："${text}"`;
    });
    return `${header}\n${parts.join("\n")}`;
  }

  return null;
}

/** 剥离画面提示词中内嵌的台词内容:同一台词在动作描述和台词块里各出现一次会让模型当成两次说话指令,导致口型错乱/乱说 */
export function stripEmbeddedDialogue(prompt: string, dialogue: string): string {
  const lines = dialogue.split("\n").map((l) => l.trim()).filter(Boolean);
  let out = prompt;
  for (const line of lines) {
    // 台词内容:引号内优先,否则取"说/喊道/问道"等引导词之后的文本
    const quoted = /["“”]([^"“”]+)["“”]/.exec(line);
    const spoken = quoted?.[1] ?? /(?:说|喊道|问道|答道|回应|回答)\s*[：:]?\s*(.+)$/.exec(line)?.[1];
    if (!spoken) continue;
    const core = spoken.replace(/[。！？.!?~～\s]+$/g, "").trim();
    if (core.length < 2) continue;
    // 模糊匹配用的紧凑形式:去掉标点后逐字匹配,字间允许夹标点(如"姐姐，你也穿越过来了" vs "姐姐你也穿越过来了")
    const compact = core.replace(/[，,。.!！?？、;；:：\s"'“”~～]/g, "");
    if (out.includes(core)) {
      out = out.split(core).join("");
    } else if (compact.length >= 4) {
      const fuzzy = new RegExp(compact.split("").map(escapeRegExp).join("[\\s，,。.!！?？、;；:：\"'“”~～]*"));
      out = out.replace(fuzzy, "");
    }
  }
  return out
    // 内容剥离后悬挂的说话动词改为动作表述,保持句子通顺
    .replace(/(喊道|说道|答道|问道|回应道|回答道|开口道|回应|回答)(?=\s|$|[。，,;；、!！?？])/g, "开口说话")
    .replace(/说[：:](?=\s|$|[。，,;；、])/g, "开口说话")
    .replace(/["“”]\s*["“”]/g, "")
    .replace(/。{2,}/g, "。")
    .replace(/([，,;；、])[，,;；、]+/g, "$1")
    .trim();
}
