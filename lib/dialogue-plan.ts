/** 剧本台词 → 分镜台词分配表（代码级确定性分配）。
 *
 * 为什么要代码分配而不是让分镜 LLM 自己分:两轮实测证明提示词约束管不住——
 * LLM 会把全部台词塞进后面的镜头、或跳过中间台词挑后面的,导致剧情断裂。
 * 分配策略(用户定策):从剧本第一句起按顺序依次装入,每镜封顶 1~3 句,
 * 分镜数不够时剩余台词直接舍弃(前缀语义),绝不跳句、绝不追求覆盖全部剧本。
 *
 * 返回:string[shotCount][],每项是该镜的台词行("角色名：台词"),按序照抄进分镜。 */
export function planShotDialogue(
  script: string,
  characterNames: string[],
  shotCount: number,
  secondsPerShot: number,
): string[][] {
  const names = new Set(characterNames);
  const all: string[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    const m = /^([^\s：:]{1,10})[：:]\s*(.+)$/.exec(line);
    if (!m) continue;
    // 说话人必须是已定义角色:顺带滤掉"梗概：/场景：/屏幕亮起："等非对白行与旁白
    if (!names.has(m[1])) continue;
    // 剥掉括号内的动作神态(舞台指示),只保留要念出声的台词
    const text = m[2].replace(/[（(][^）)]*[)）]/g, "").replace(/[。～…\s]+$/, "").trim();
    if (!text) continue;
    all.push(`${m[1]}：${text}`);
  }

  // 每镜封顶:4秒镜1句,6秒镜2句,8秒及以上3句(剧本台词每句≤15字,约4秒)
  const perShot = secondsPerShot <= 4 ? 1 : secondsPerShot <= 6 ? 2 : 3;

  const plan: string[][] = [];
  let idx = 0;
  for (let i = 0; i < shotCount; i++) {
    plan.push(all.slice(idx, idx + perShot));
    idx += perShot;
  }
  return plan; // 超出总容量的台词自然舍弃
}
