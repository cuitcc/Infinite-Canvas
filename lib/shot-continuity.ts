/** Only unambiguous title variants are aliases; never merge names by substring. */
export function resolveCharacterName(name: string, names: string[]): string | undefined {
  const value = name.trim();
  if (names.includes(value)) return value;
  const key = (s: string) => s.trim().replace(/^(?:舰长|队长|指挥官|博士|先生|女士)\s*/, "")
    .replace(/\s*(?:舰长|队长|指挥官|博士|先生|女士)$/, "").trim();
  const matches = names.filter((n) => key(n) && key(n) === key(value));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveShotCharacters(visible: string[], dialogue: string[], names: string[]): string[] {
  return [...new Set([...visible, ...dialogue.map((line) => line.split(/[：:]/)[0])].map((name) => {
    const canonical = resolveCharacterName(name, names);
    if (!canonical) throw new Error(`分镜人物“${name}”不在本章角色清单中或称谓有歧义，请修正分镜`);
    return canonical;
  }))];
}

export function resolveDialogueSpeakers(dialogue: string[], names: string[]): string[] {
  return dialogue.map((line) => {
    const match = /^(\s*)([^：:]+)([：:])([\s\S]*)$/.exec(line);
    const canonical = match && resolveCharacterName(match[2], names);
    if (!match || !canonical) throw new Error(`对白说话人无法匹配本章角色：${line}`);
    return `${match[1]}${canonical}${match[3]}${match[4]}`;
  });
}

const sceneKey = (name: string) => name.trim().replace(/\s+/g, "");
const inherited = (name: string) => !name.trim() || /^(沿用上一场景|同上|承接上一场景)$/.test(name.trim());

/** A placeholder may inherit the preceding resolved scene, never the first historical asset. */
export function resolveShotScene(contexts: string[], proposed: string | undefined, names: string[], previous?: string): string {
  const explicit = contexts.map((c) => /^场景=([^；]*)/.exec(c)?.[1] ?? "").filter((s) => !inherited(s));
  const match = (value: string) => {
    const hits = names.filter((n) => sceneKey(n) === sceneKey(value));
    if (hits.length !== 1) throw new Error(`分镜场景“${value}”未匹配本章唯一场景，请修正场景名称`);
    return hits[0];
  };
  const locked = [...new Set(explicit.map(match))];
  if (locked.length > 1) throw new Error("一个对白分镜跨越了多个场景，请拆分分镜");
  if (locked.length) return locked[0];
  if (proposed && !inherited(proposed)) return match(proposed);
  if (previous) return match(previous);
  if (names.length === 1) return names[0];
  throw new Error("分镜缺少明确场景，不能自动使用其他章节的场景资产");
}

export function parseScriptScene(line: string): string | undefined {
  return /^(?:\[|【)?\s*场景\s*[：:]\s*([^。\]】\n]+)(?:[。\]】]|$)/.exec(line.trim())?.[1]?.trim();
}

/** Required identities never yield to optional props or a previous frame. */
export function fitShotReferences<T extends { name: string }>(references: T[], limit = 5): T[] {
  const refs = [...references];
  while (refs.length > limit) {
    let index = refs.findIndex((r) => r.name.startsWith("道具·"));
    if (index < 0) index = refs.findIndex((r) => r.name === "上一镜尾帧");
    if (index < 0) throw new Error("人物与场景参考图超过模型上限，请拆分镜头，不能丢弃身份参考");
    refs.splice(index, 1);
  }
  return refs;
}
