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

/** 时长锚定:显式授权剩余时间为沉默,防止模型用即兴台词填充空窗(乱说台词的主要来源之一) */
function durationNote(seconds: number | undefined, totalChars: number): string {
  if (!seconds || seconds <= 0) return "";
  const est = Math.max(1, Math.round(totalChars / 4));
  return `本镜时长约${seconds}秒,以上台词念完约${est}秒,剩余时间为沉默、动作与表情,禁止用新的说话内容或旁白填充。`;
}

/** 台词框内容 → 注入提示词的文本。
 * speakerMap:第 i+1 张参考图对应的角色名(场景图可标"场景"等非说话人名)。
 * 提供且每句台词的说话人都能按名字绑定到参考图时,支持 M 句台词 ≤ N 张参考图,不说台词的角色明确保持倾听;
 * 否则回退:多行台词且行数=参考图数时按行序绑定;都不适用返回 null(调用方回退到通用注入)
 * seconds:本镜时长(秒),用于注入时长锚定,让模型把剩余时长留给动作与沉默而非即兴台词 */
export function buildDialogueInjection(dialogue: string, referenceCount: number, speakerMap?: string[], seconds?: number): string | null {
  const lines = dialogue.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const totalChars = lines.reduce((n, l) => {
    const m = /^([^：:]+)[：:]\s*(.+)$/.exec(l);
    return n + (m ? m[2] : l).length;
  }, 0);
  const pacing = durationNote(seconds, totalChars);
  const withPacing = (closing: string) => (pacing ? `${closing}\n${pacing}` : closing);

  if (speakerMap && speakerMap.length === referenceCount) {
    const parsed = lines.map((line) => {
      const m = /^([^：:]+)[：:]\s*(.+)$/.exec(line);
      return { speaker: m ? m[1].trim() : "", text: (m ? m[2] : line).trim() };
    });
    const refIndex = (name: string) => speakerMap.findIndex((n) => n === name);
    if (parsed.length > 0 && parsed.every((p) => p.speaker && p.text && refIndex(p.speaker) >= 0)) {
      const header = "台词按角色分配,谁说台词谁开口,口型与台词精确同步:";
      const parts = parsed.map((p) => `<Picture ${refIndex(p.speaker) + 1}>中的${p.speaker}说："${p.text}"`);
      const listeners = speakerMap
        .map((name, i) => ({ name, i }))
        .filter(({ name }) => !parsed.some((p) => p.speaker === name))
        .map(({ name, i }) =>
          `<Picture ${i + 1}>中的${name}不说台词${/场景|尾帧|^道具·/.test(name) ? ",仅作画面参考" : ",保持倾听和自然反应"}`);
      // 多人台词时显式禁止"一人念完全部":模型容易把多句台词都交给主角色;
      // 台词总量硬性封顶:模型念完给定句后会自行发挥延伸出大段新台词
      const closing = parsed.length >= 2
        ? "\n以上台词由各自角色分别开口,一人只说自己名下的一句,禁止任何角色替他人念台词,禁止重复台词;台词全文只有这些,禁止增加、改写或延伸任何台词,不加旁白解说。"
        : "\n台词全文只有这一句,逐字念出,禁止增加、改写或延伸任何台词,禁止重复,不加旁白解说,念完即止。";
      return `${header}\n${parts.join("\n")}${withPacing(closing)}${listeners.length ? `\n${listeners.join("，")}` : ""}`;
    }
  }

  if (referenceCount >= 2 && lines.length === referenceCount) {
    const header = "台词按角色分配,谁说台词谁开口,其余人物保持倾听,口型与台词精确同步:";
    // 用户已写明"参考图N/第N张"绑定时原样使用(仅补引号边界),避免二次编号冲突
    if (lines.some((l) => /参考图\s*\d|第\s*\d\s*张/.test(l))) {
      return withPacing(`${header}\n${lines.map(quoteSpoken).join("\n")}`);
    }
    const parts = lines.map((line, i) => {
      const m = /^([^：:]+)[：:]\s*(.*)$/.exec(line);
      const speaker = m?.[1]?.trim() ?? "";
      const text = (m?.[2] ?? line).trim();
      const who = speaker || "人物";
      return `<Picture ${i + 1}>中的${who}说："${text}"`;
    });
    return withPacing(`${header}\n${parts.join("\n")}`);
  }

  // 名字绑定兜底:每行都能解析出"角色名：台词"时按名字分配,不依赖参考图编号。
  // 覆盖尾帧首帧模式(唯一参考图是尾帧,说话人不是图)等场景,优于整块引号注入(会一人念完全部)
  const named = lines.map((line) => {
    const m = /^([^：:]+)[：:]\s*(.+)$/.exec(line);
    return m ? { speaker: m[1].trim(), text: m[2].trim() } : null;
  });
  if (named.length > 0 && named.every((n) => n && n.speaker && n.text)) {
    const header = "台词按角色分配,谁说台词谁开口,口型与台词精确同步:";
    const parts = named.map((n) => `${n!.speaker}说："${n!.text}"`);
    const closing = named.length >= 2
      ? "\n以上台词由各自角色分别开口,一人只说自己名下的一句,禁止任何角色替他人念台词,禁止重复台词;台词全文只有这些,禁止增加、改写或延伸任何台词,不加旁白解说。"
      : "\n台词全文只有这一句,逐字念出,禁止增加、改写或延伸任何台词,禁止重复,不加旁白解说,念完即止。";
    return `${header}\n${parts.join("\n")}${withPacing(closing)}`;
  }

  return null;
}

/** 剥离画面提示词中内嵌的台词内容:同一台词在动作描述和台词块里各出现一次会让模型当成两次说话指令,导致口型错乱/乱说 */
export function stripEmbeddedDialogue(prompt: string, dialogue: string): string {
  const lines = dialogue.split("\n").map((l) => l.trim()).filter(Boolean);
  let out = prompt;
  for (const line of lines) {
    // 分镜师违规把整行"角色名：（动作）台词"塞进 description:从说话人冒号起整段剥离(含括号动作)。
    // 该格式既无引号也无"说"类动词,是此前剥离静默失败、台词双重注入的主通道
    const speakerLine = /^([^：:]{1,12})[：:]\s*(.+)$/.exec(line);
    if (speakerLine) {
      const speaker = speakerLine[1].trim();
      // 括号动作神态不参与匹配,只按台词正文字符做模糊定位
      const spokenCore = speakerLine[2].replace(/[（(][^）)]*[)）]/g, "").replace(/[。！？.!?~～\s]+$/g, "").trim();
      const compact = spokenCore.replace(/[，,。.!！?？、;；:：\s"'“”~～]/g, "");
      if (speaker && compact.length >= 2) {
        const fuzzy = new RegExp(compact.split("").map(escapeRegExp).join("[\\s，,。.!！?？、;；:：\"'“”~～]*"));
        // 说话人冒号 + 可选括号动作 + 台词正文,整段移除
        const span = new RegExp(`${escapeRegExp(speaker)}\\s*[：:]\\s*(?:[（(][^）)]*[)）]\\s*)?${fuzzy.source}`);
        const before = out;
        out = out.replace(span, "");
        if (out !== before) continue;
      }
    }
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
