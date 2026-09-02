/** 台词框内容 → 注入提示词的文本。多行台词且参考图 ≥2 张时按行序绑定参考图;不适用时返回 null(调用方回退到通用注入) */
export function buildDialogueInjection(dialogue: string, referenceCount: number): string | null {
  const lines = dialogue.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  if (referenceCount >= 2 && lines.length === referenceCount) {
    const header = "台词按角色分配,谁说台词谁开口,其余人物保持倾听,口型与台词精确同步:";
    // 用户已写明"参考图N/第N张"绑定时原样使用,避免二次编号冲突
    if (lines.some((l) => /参考图\s*\d|第\s*\d\s*张/.test(l))) {
      return `${header}\n${lines.join("\n")}`;
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
