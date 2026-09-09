import path from "node:path";

/** 导出烧录字幕的字体与 ASS 模板。字体随 public/ 进镜像,fontsdir 喂给 libass,
 * 容器内无系统字体,缺了它中文全渲染成豆腐块 */
export const SUBTITLE_FONT_DIR = path.join(process.cwd(), "public", "fonts");
export const SUBTITLE_FONT_NAME = "Noto Sans CJK SC";
/** 与导出转码的 scale/pad 目标分辨率一致,ASS 坐标系按此标定 */
export const EXPORT_WIDTH = 1152;
export const EXPORT_HEIGHT = 768;

/** 从节点 dialogue 字段提取字幕行:去掉「说话人：」前缀(短剧惯例字幕不带人名),滤空行 */
export function parseDialogueLines(dialogue: string | undefined | null): string[] {
  if (!dialogue) return [];
  return dialogue
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[^：:]{1,20}[：:]\s*/, ""))
    .map((l) => l.trim())
    .filter(Boolean);
}

/** ASS 时间戳 h:mm:ss.cs */
function assTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const cs = Math.round(clamped * 100);
  const centis = cs % 100;
  const total = Math.floor(cs / 100);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/** 台词正文里的特殊字符会让 ASS 解析器当覆盖标签吃掉,转义掉 */
function escapeAssText(text: string): string {
  return text.replace(/\\/g, "＼").replace(/[{}]/g, "（）").replace(/\n/g, " ");
}

/**
 * 生成单镜的 ASS 字幕文件内容。
 * 行内时序是人声直生方案下的近似:模型没有给出每句台词的精确时刻,按字数比例顺序切分
 * 镜头时长(实测语速约 4 字/秒,比例分配与实际发音节奏吻合),误差 ±0.5 秒级。
 * trimIn 偏移由调用方折算:导出转码用输出侧 -ss,输出时间戳从 0 起,offset 传 0 即可。
 */
export function buildSubtitleAss(lines: string[], durationSec: number, offsetSec = 0): string {
  const duration = Math.max(0, durationSec);
  // 短行给个最低权重,避免 4 字句只闪 0.3 秒
  const weights = lines.map((l) => Math.max(l.length, 4));
  const total = weights.reduce((a, b) => a + b, 0);
  const events: string[] = [];
  let cursor = offsetSec;
  for (let i = 0; i < lines.length; i++) {
    const span = total > 0 ? (weights[i] / total) * duration : duration / lines.length;
    const start = cursor;
    const end = i === lines.length - 1 ? offsetSec + duration : start + span;
    cursor = end;
    if (end - start <= 0.05) continue;
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Sub,${escapeAssText(lines[i])}`);
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${EXPORT_WIDTH}
PlayResY: ${EXPORT_HEIGHT}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Sub,${SUBTITLE_FONT_NAME},40,&H00FFFFFF,&H00000000,&H7F000000,0,2,1,2,60,60,46

[Events]
Format: Layer, Start, End, Style, Text
${events.join("\n")}
`;
}
