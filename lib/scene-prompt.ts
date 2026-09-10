/** 场景资产提示词的代码侧兜底。实测 Agnes 文生图通道不支持 negative_prompt(只在图生图携带),
 * 「空场景」只能靠正向提示词表达;而否定式"无人物"里的"人物"是显著性 token,注意力反而被它
 * 吸引(实测提示词写了"无人物"仍画出主角)。这里做确定性改写:
 * 1.剥掉 LLM 逐字照抄模板泄漏的元指令(「60字内」等);
 * 2.否定式改陈述式("无人物"→"空无一人");
 * 3.未含陈述式表达时追加中英双语空场景锚点 */
export function hardenScenePrompt(prompt: string): string {
  let out = prompt.replace(/，?,?\d+字内/g, "");
  out = out.replace(/无人物|没有人[物影]|不见人影|无人/g, "空无一人");
  out = out.replace(/[,，、\s]+$/g, "");
  if (!/空无一人|empty scene|no people/i.test(out)) {
    out += ",空无一人,empty scene, no people";
  }
  return out;
}
