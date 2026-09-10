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

/** 场景净化图的负向提示词:img2img 是 Agnes 唯一携带 negative_prompt 的通道
 * (lib/agnes-image.ts:21),用负向词压掉人物;质量类负向词由 buildAgnesImageRequest 自动追加 */
export const SCENE_PURIFY_NEGATIVE =
  "人物,人影,人像,修士,侠客,仙人,人, person, people, human, figure, man, woman, character, 1boy, 1girl";

/** 场景净化图的正向提示词:重申同一场景(正向陈述式,否定词会把"人物"概念注入注意力,
 * 人物压制全部交给 negative_prompt 通道);实测强先验场景(云海玉台/祭坛/王座)在 t2i 阶段
 * 就会把人画进图里——「悬浮平台」在修仙语料里与「修士立于台上」强共现,"空无一人"弱锚点
 * 压不住;净化走 img2img 低成本兜底,提示词保持空间结构不变 */
export function buildScenePurifyPrompt(prompt: string): string {
  return `${hardenScenePrompt(prompt)},与参考图完全相同的场景空间,保持空间结构、光影与氛围不变,空无一人,empty scene, no people`;
}
