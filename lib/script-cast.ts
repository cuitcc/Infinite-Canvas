import type { StoryOutline } from "./agent-story";
import { missingDialogueCharacters } from "./dialogue-plan";
import { resolveCharacterName } from "./shot-continuity";

/** Source-backed supporting roles, including silent groups, need assets before filming. */
export function completeScriptCast(outline: StoryOutline, candidates: string[] = []): StoryOutline {
  const characters = [...outline.characters, ...missingDialogueCharacters(outline.script, outline.characters)];
  const script = outline.script;
  const roles = new Set([...candidates, ...(script.match(/安保人员|警卫|守卫|侍卫|士兵|医护人员|工作人员/g) ?? [])]);
  for (const role of roles) {
    if (!role || !script.includes(role) || resolveCharacterName(role, characters.map((c) => c.name))) continue;
    const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const countText = new RegExp(`([两二三四234])(?:名|位|个)[^，。！？\\n\\[\\]【】]{0,16}?${escaped}`).exec(script)?.[1];
    const count = countText ? ({ 两: 2, 二: 2, 三: 3, 四: 4 }[countText] ?? Number(countText)) : 1;
    const context = script.split("\n").find((line) => line.includes(role)) ?? role;
    for (let i = 0; i < count; i++) {
      const name = count > 1 ? `${role}${"甲乙丙丁"[i]}` : role;
      if (characters.some((c) => c.name === name)) continue;
      characters.push({ name, gender: "未知", role: count > 1 ? `${role}中的第${i + 1}位` : role,
        relationship: `仅执行原剧本动作：${context}`, appearance: `${name}的独立单人设定图；根据原剧本${context}设计外观，不推断性别；脸部和服装细节与其他同职务人物可区分，每张图仅一人`,
        wardrobe: "保持剧本所述制服与配饰，首次确定后跨镜复用", voiceProfile: "未授权台词时保持沉默；有台词时沿用本角色固定音色" });
    }
  }
  return { ...outline, characters };
}

export function expandCastGroups(visible: string[], names: string[]): string[] {
  return [...new Set(visible.flatMap((name) => {
    const canonical = resolveCharacterName(name, names);
    if (canonical) return [canonical];
    const group = names.filter((n) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[甲乙丙丁]$`).test(n));
    return group.length > 1 ? group : [name];
  }))];
}
