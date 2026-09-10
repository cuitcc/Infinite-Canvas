import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { PLAN_SYSTEMS, extractJson } from "@/lib/agent-prompts";
import { auditScript, minScriptLines, scriptCapacity } from "@/lib/dialogue-plan";

function buildUser(task: string, input: string, shotCount?: number, secondsPerShot?: string, retryIssues?: string[]): string {
  if (task === "storyboard") {
    const { outline, assetNames, sceneNames, count, dialoguePlan, indexOffset, prevShots } = JSON.parse(input) as {
      outline: unknown; assetNames: string[]; sceneNames?: string[]; count: number; dialoguePlan?: string[][] | null;
      indexOffset?: number; prevShots?: { index: number; scene: string; summary: string }[];
    };
    const scenes = sceneNames?.length ? `\n可用场景:${sceneNames.join("、")}` : "";
    // 台词分配表由代码算死,分镜师逐字照抄;每镜秒数供运镜/台词节奏参考
    const planText = Array.isArray(dialoguePlan)
      ? `\n各镜台词分配表(dialogue 必须逐字照抄,禁止增删改):\n${dialoguePlan.map((lines, i) => `第${(indexOffset ?? 0) + i + 1}镜:${lines.length ? lines.join("；") : "(无台词)"}`).join("\n")}`
      : "";
    // 续拍分支:镜号续接 + 前情提要,剧情从上批末尾继续推进
    const continueText = indexOffset && prevShots?.length
      ? `\n本批为续拍:镜号从第${indexOffset + 1}镜起连续编号;剧情必须紧接前情提要的末尾继续推进,禁止重复已拍内容;首镜若与前情末镜同场景,起幅直接延续其结尾画面(尾帧参考图)`
      : "";
    // 校验不合规时带违规清单重试:提示词约束对 LLM 不可靠(台词分配的教训),改用"检查-反馈-重试"合同
    const retry = retryIssues?.length ? `\n\n你上一次的输出存在以下违规,本次必须全部修正:\n${retryIssues.map((s, i) => `${i + 1}.${s}`).join("\n")}` : "";
    return `分镜数量:${count}\n每镜秒数:${secondsPerShot ?? "10"}${planText}${continueText}\n剧本大纲:\n${JSON.stringify(outline)}\n可用角色:${assetNames.join("、")}${scenes}${retry}`;
  }
  // shotCount:outline 分支注入片长容量;storyboard 分支的 count 从 input 内部解析
  if ((task === "outline" || task === "outline-continue") && shotCount && secondsPerShot) {
    const retry = retryIssues?.length ? `\n\n你上一次的输出存在以下违规,本次必须全部修正:\n${retryIssues.map((s, i) => `${i + 1}.${s}`).join("\n")}` : "";
    return `${input}\n(全片共${shotCount}个分镜,每镜${secondsPerShot}秒,全片约${Number(shotCount) * Number(secondsPerShot)}秒)${retry}`;
  }
  // assets 等其余任务:原样透传,但校验违规时同样带清单重试
  const retry = retryIssues?.length ? `\n\n你上一次的输出存在以下违规,本次必须全部修正:\n${retryIssues.map((s, i) => `${i + 1}.${s}`).join("\n")}` : "";
  return shotCount ? `${input}\n(分镜数量备用:${shotCount})${retry}` : `${input}${retry}`;
}

/** 大纲产出校验(A:剧本硬合同)。实测翻车:6镜只写6句台词(后4镜全程无声)、1字超短句"唔..."、
 * 台词提及"姐姐"但角色表没有(幽灵角色,画面无参考图可挂)。返回违规清单,空数组=合规 */
function validateOutline(data: unknown, shotCount?: number, secondsPerShot?: string): string[] {
  const o = data as { characters?: { name?: string }[]; script?: string };
  const names = (Array.isArray(o.characters) ? o.characters : []).map((c) => (c.name ?? "").trim()).filter(Boolean);
  if (!names.length) return ["characters 角色表不能为空"];
  const minLines = shotCount && secondsPerShot ? minScriptLines(shotCount, Number(secondsPerShot)) : null;
  const capacity = shotCount && secondsPerShot ? scriptCapacity(shotCount, Number(secondsPerShot)) : null;
  return auditScript(o.script ?? "", names, minLines, capacity);
}

/** description 提及是否为"实义出场"(D:提及≠出镜)。同分句内含抽象语境词(暗示/幻觉/轮廓/剪影等)
 * 时不强制出镜——实测空镜 description"暗示龙猫的存在并非幻觉"也会触发强制出镜,给无人物的
 * 镜头挂上参考图。按分句(。;, )切分,只有名字出现在不含抽象词的分句里才算实义出场 */
const ABSTRACT_CONTEXT = /暗示|仿佛|的存在|幻觉|轮廓|剪影|影子|消失|梦境|回忆|想象|幻影|一闪而过/;

function mentionedAsPresent(desc: string, name: string): boolean {
  for (const clause of desc.split(/[。；;，,]/)) {
    if (clause.includes(name) && !ABSTRACT_CONTEXT.test(clause)) return true;
  }
  return false;
}

/** 说话人是否被安排了"出场+动作"。实测"四分之三侧身面对高台上的指挥官索尔"这类纯朝向提及
 * 会让 C' 空转——索尔的台词在画面里没有任何动作对应,模型只能即兴处理;提及≠出场,出场必须有戏。
 * 归属口径:句级(中文主语承前省略,动作常在名字后的逗号分句里,子句级会大面积误报),
 * 但名字仅出现在"面对/朝向+名字"宾语位置时不算——动作属于句子主语,不属于说话人。
 * 动作词表全部用双字安全形式:单字"指/推/拉/念"会撞上"指挥官/推近/概念"等普通词素 */
const SPEECH_STAGING = /现身|入画|登场|露面|开口|说道|说话|告诉|脱口|问道|质问|追问|逼问|问出|发问|答道|回答|应答|应声|回应|反驳|低语|大喊|呼喊|喊道|怒吼|吼道|嘀咕|命令|解释|强调|诉说|讲述|讲话|张口|张嘴|嘴巴|嘴唇|嘴角|咬牙|皱眉|瞪着|瞪大|凝视|盯着|注视|目光|眼神|表情|神色|神情|面部|攥|紧握|握着|握住|举起|抬手|抬起|挥动|挥手|挥舞|拍了拍|拍拍|指向|指着|侧目|转身|回头|前倾|后退|站起|起身|坐下|跪下|跪地|点头|摇头|道谢|道别|告别|致意|叮嘱|嘱咐|安慰|问候|打招呼/;

function stagedWithAction(desc: string, name: string): boolean {
  for (const sentence of desc.split(/[。；;]/)) {
    if (!sentence.includes(name)) continue;
    const clauses = sentence.split(/[，,]/);
    const nameClauses = clauses.filter((c) => c.includes(name));
    if (nameClauses.length && nameClauses.every((c) => ABSTRACT_CONTEXT.test(c))) continue;
    if (nameClauses.every((c) => new RegExp(`(?:面对|面向|朝向|朝着|望向|看向|盯向|冲着|对着)[^。；;，,]{0,4}${name}`).test(c))) continue;
    if (SPEECH_STAGING.test(sentence)) return true;
  }
  return false;
}

const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"] as const;
/** 运镜词 → 规范类别:与提示词允许的缓慢运镜词表对齐;子串匹配容易误伤("推开门"),只认显式运镜表述 */
const CAMERA_VERBS: [RegExp, string][] = [
  [/推镜|推近|推进|缓推/, "推"], [/拉镜|拉远|缓拉/, "拉"], [/摇镜|摇拍|缓慢摇/, "摇"], [/横移|移镜|平移/, "移"],
  [/跟拍|跟随/, "跟"], [/环绕|绕拍/, "环绕"],
];

/** 资产清单校验(B合同):大纲 characters/scenes 里的每个名字都必须有逐字一致的资产条目。
 * 实测翻车:续写段引入新角色"外星副官",资产规划 LLM 没把它列进清单,而 assets 是唯一没有
 * 校验的规划环节——该角色全程无立绘参考,台词在说、画面在即兴乱画(第9镜灰皮外星人、
 * 第15镜黑发人形,跨镜身份塌缩)。返回违规清单,空数组=合规 */
function validateAssets(data: unknown, input: string): string[] {
  const assets = (data as { assets?: { kind?: string; name?: string; prompt?: string }[] })?.assets;
  if (!Array.isArray(assets) || !assets.length) return ["assets 资产清单不能为空"];
  let outline: { characters?: { name?: string }[]; scenes?: { name?: string }[] } = {};
  try { outline = JSON.parse(input); } catch { /* 大纲解析失败时跳过覆盖检查,其余检查照常 */ }
  const entries = assets.map((a) => `${a.kind ?? ""}:${(a.name ?? "").trim()}`);
  const issues: string[] = [];
  for (const c of outline.characters ?? []) {
    if (!entries.includes(`character:${c.name ?? ""}`)) {
      issues.push(`角色「${c.name}」在资产清单中缺失:大纲 characters 里的每个角色都必须有 kind:"character" 且 name 逐字一致的条目,没有参考图的出场角色会被视频模型即兴乱画`);
    }
  }
  for (const sc of outline.scenes ?? []) {
    if (!entries.includes(`scene:${sc.name ?? ""}`)) {
      issues.push(`场景「${sc.name}」在资产清单中缺失:大纲 scenes 里的每个场景都必须有 kind:"scene" 且 name 逐字一致的条目`);
    }
  }
  const badKind = assets.filter((a) => !["character", "scene", "prop"].includes(a.kind ?? ""));
  if (badKind.length) issues.push(`assets 存在非法 kind(只允许 character/scene/prop):${badKind.map((a) => `${a.kind}:${a.name}`).join("、")}`);
  const noPrompt = assets.filter((a) => !(a.prompt ?? "").trim());
  if (noPrompt.length) issues.push(`assets 存在缺 prompt 的条目:${noPrompt.map((a) => a.name).join("、")}`);
  const propCount = assets.filter((a) => a.kind === "prop").length;
  if (propCount > 3) issues.push(`道具资产 ${propCount} 个,超过上限 3 个`);
  // 场景纯空间合同:场景图是静止地点的空镜参考,写成剧情事件会被画成剧情瞬间(有动作必有
  // 施动者,实测"剑芒击碎石台"画出持剑人),人物词/否定词同理(实测"无人物"反而画出主角)
  const SCENE_EVENT_RE = /人物|主角|身影|侠客|修士|少年|少女|男子|女子|老者|僧人|道士|士兵|军官|剑芒|剑气|剑光|刀光|击碎|击穿|爆炸|炸裂|斩|劈|挥剑|打斗|对峙|交锋|崩塌|倒塌|燃烧|飞溅|震得|剧烈摇晃/;
  for (const a of assets.filter((x) => x.kind === "scene")) {
    if (SCENE_EVENT_RE.test(a.prompt ?? "")) {
      issues.push(`场景「${a.name}」的 prompt 写成了剧情事件或含人物:场景提示词必须是静止的纯空间描述(空间结构+光影+氛围),禁止事件/动作/能量爆发/人物,不要写"无人物"等否定词(空场景锚点由系统追加)`);
    }
  }
  return issues;
}

/** 分镜产出校验:相邻景别/主运镜重复、台词与分配表不符、说话人未出镜、description 提及的说话人未入 characters。
 * indexOffset>0 表示续拍批次:镜号偏移显示,批次首镜豁免相邻景别/运镜与起幅衔接检查(与上批末镜的衔接由尾帧参考兜底)。
 * 返回违规清单,空数组=合规 */
export function validateStoryboard(data: unknown, count: number, dialoguePlan?: string[][] | null, indexOffset = 0): string[] {
  const shots = (data as { shots?: { scene?: string; description?: string; dialogue?: string[]; characters?: string[] }[] })?.shots;
  if (!Array.isArray(shots) || shots.length !== count) {
    return [`分镜数量必须严格等于${count}`];
  }
  // 全片说话人全集:用于检查 description 提及但 characters 漏排的角色
  const universe = [...new Set(
    (Array.isArray(dialoguePlan) ? dialoguePlan : []).flat()
      .map((l) => /^([^：:]+)[：:]/.exec(l.trim())?.[1]?.trim() ?? "").filter(Boolean),
  )];
  const issues: string[] = [];
  let prevSize = "";
  let prevVerb = "";
  shots.forEach((s, i) => {
    const n = indexOffset + i + 1;
    const desc = s.description ?? "";
    const size = SHOT_SIZES.find((w) => desc.includes(w)) ?? "";
    const verb = CAMERA_VERBS.find(([re]) => re.test(desc))?.[1] ?? "";
    // 续拍批次首镜:上一镜在上批,本批 LLM 看不到其构图,相邻重复/起幅衔接交由尾帧参考兜底
    const firstOfBatch = i === 0 && indexOffset > 0;
    if (!firstOfBatch) {
      if (size && size === prevSize) issues.push(`第${n - 1}镜与第${n}镜景别重复(${size}),相邻两镜景别必须变化`);
      if (verb && verb === prevVerb) issues.push(`第${n - 1}镜与第${n}镜主运镜重复(${verb}),相邻两镜主运镜必须不同`);
    }
    // B:同场景起幅衔接合同——上一镜落幅景别与本镜起幅景别必须一致(实测起幅写全新构图,尾帧参考被完全无视)
    const prev = shots[i - 1];
    // E:落幅必填——B 合同的锚点:LLM 省写"落幅至X"时 B 检查空转(实测第2/3镜无落幅,2→3、3→4 剪切点构图跳变)
    const curEnd = /落幅至?(远景|全景|中景|近景|特写)/.exec(desc)?.[1];
    if (!curEnd) {
      issues.push(`第${n}镜 description 缺少"落幅至X"的景别标注:必须写明运镜三段式并以"落幅至远景/全景/中景/近景/特写"收束(下一镜的起幅衔接以此为准)`);
    }
    if (i > 0 && s.scene && prev?.scene && s.scene === prev.scene) {
      const prevEnd = /落幅至?(远景|全景|中景|近景|特写)/.exec(prev.description ?? "")?.[1];
      const curStart = /^[^。]*?(远景|全景|中景|近景|特写)/.exec(desc)?.[1];
      if (prevEnd && curStart && prevEnd !== curStart) {
        issues.push(`第${n}镜与第${n - 1}镜同场景,上一镜落幅至${prevEnd},本镜起幅却是${curStart}:同场景镜头的起幅构图必须直接延续上一镜落幅画面(尾帧参考图),禁止以全新构图开场`);
      }
    }
    // C:无台词镜禁语——台词为空时 description 写言语动作会产出无声口动(默片穿帮)
    const want = Array.isArray(dialoguePlan) ? dialoguePlan[i] ?? [] : null;
    if (want && want.length === 0) {
      const speech = desc.match(/开口|诉说|说道|喊道|问道|答道|质问|反驳|嘀咕|低语|大喊|大声说|说话/);
      if (speech) {
        issues.push(`第${n}镜没有台词,description 却写了言语动作"${speech[0]}":无台词镜头角色嘴部保持闭合,改用眼神、表情与肢体动作推进剧情`);
      }
    }
    // C':有台词镜反向合同——每个说话人必须在 description 中有出场安排。实测:外星副官的台词
    // 在分配表里,description 却只写它"盯着屏幕",无人安排其说话动作,人声成了来历不明的画外音
    if (want) {
      for (const line of want) {
        const sp = /^([^：:]+)[：:]/.exec(line.trim())?.[1]?.trim();
        if (sp && !stagedWithAction(desc, sp)) {
          issues.push(`第${n}镜分配表台词的说话人"${sp}"未在 description 中安排出场:必须写出其出场与说话动作(纯"面对XX""看向XX"不算),禁止台词由画面外/未描述的人说出`);
        }
      }
      // J:台词镜人物先行——desc 前两句必须出现说话人,禁止连续纯环境/运镜句开场。
      // 实测首镜 desc 前半全是环境(全息舱+光幕+落幅),模型照演成 40% 空镜再硬切人物,
      // 两句台词被压进后 60% 且单镜内两次切镜
      const speakers = want.map((l) => /^([^：:]+)[：:]/.exec(l.trim())?.[1]?.trim()).filter((sp): sp is string => Boolean(sp));
      if (speakers.length) {
        const early = desc.split(/[。；;]/).filter((x) => x.trim()).slice(0, 2)
          .some((s) => speakers.some((sp) => stagedWithAction(s, sp) || s.includes(sp)));
        if (!early) {
          issues.push(`第${n}镜带台词却以纯环境/运镜句开场(前两句无说话人):人物必须出现在前两句内,环境描写并入人物句,禁止先拍空镜再切人物`);
        }
      }
    }
    // H:description 禁止引用台词原文——引用台词会让 description 与运行时注入的说话提示
    // 互相矛盾,且诱导模型把念白演成转脸/看字幕(实测第6镜 desc 写『清理者索尔』的名字落下,
    // 与"嘴部可见禁止转向镜头"冲突,模型折中成对镜头说话)。台词只允许出现在 dialogue 数组
    if (want?.length) {
      const texts = want.map((l) => l.replace(/^[^：:]+[：:]/, "").trim()).filter(Boolean);
      const quoted = [...desc.matchAll(/[「『"][^」』"]{2,}[」』"]/g)].map((m) => m[0].slice(1, -1));
      const badQuote = quoted.find((q) => texts.some((t) => t.includes(q) || q.includes(t)));
      const badBare = texts.find((t) => t.length >= 6 && desc.includes(t));
      if (badQuote || badBare) {
        issues.push(`第${n}镜 description 引用了台词原文"${badQuote ?? badBare}":台词只允许出现在 dialogue 数组,description 只写动作与神态(如"开口质问"),同一句台词绝不允许两处重复`);
      }
      // I:带台词镜禁止"背对镜头"调度——desc 写背对而 speakerNote 要求嘴部可见,两指令冲突时
      // 模型折中成转正对镜头说话(实测第6镜)。说话人必须侧对或四分之三侧,保证口型可见
      if (/背(?:对|向|朝)镜头/.test(desc)) {
        issues.push(`第${n}镜带台词却安排"背对镜头":说话人必须侧对或四分之三侧朝向画面内对象,保证嘴部动作清晰可见,禁止背对镜头(与说话口型要求冲突,模型会折中成对镜头说话)`);
      }
    }
    // F':description 禁用 <Picture N> 占位符——运行时参考图按"本镜出镜角色"动态编号,
    // 与分镜师按大纲全局顺序写的编号必然错位(实测"<Picture 3>外星副官"实际指向场景图,
    // 提示词自相矛盾,模型即兴乱画);绑定由系统按角色名自动完成
    const picRef = desc.match(/<Picture\s*\d+/i);
    if (picRef) {
      issues.push(`第${n}镜 description 使用了"${picRef[0]}"占位符:禁止使用 <Picture N>,人物直接写角色名,系统会自动将角色名绑定到参考图`);
    }
    // G':运镜速度词——运镜类别检查认不出"迅速拉远"(实测第16镜写了"镜头迅速拉远",
    // 前30%帧差19~25为全批最快,违反缓慢匀速硬性要求)
    const camSpeed = desc.match(/(?:镜头|机位)(?:迅速|快速|急速|猛|骤然)[^。；;，,]{0,6}|(迅速|快速|急速)(拉远|推近|摇移|横移|摇镜|变焦)/);
    if (camSpeed) {
      issues.push(`第${n}镜 description 运镜速度违规"${camSpeed[0]}":主运镜必须缓慢匀速,删去速度词,只允许缓慢推近/拉远/横移/摇镜/跟随/小幅环绕`);
    }
    prevSize = size;
    prevVerb = verb;
    const characters = Array.isArray(s.characters) ? s.characters : [];
    if (Array.isArray(dialoguePlan)) {
      const table = dialoguePlan[i] ?? [];
      const got = Array.isArray(s.dialogue) ? s.dialogue : [];
      if (JSON.stringify(table) !== JSON.stringify(got)) {
        issues.push(`第${n}镜 dialogue 必须逐字等于分配表:${table.length ? table.join("；") : "(空数组)"}`);
      }
      // 谁说话谁出镜(硬合同):分配表说话人不在该镜 characters 数组时打回,分镜阶段就把人排进画面。
      // 这是孤儿台词的根治——分配表镜头盲,只有这里能强制 description 与台词在同一镜内对齐
      for (const line of table) {
        const sp = /^([^：:]+)[：:]/.exec(line.trim())?.[1]?.trim();
        if (sp && !characters.includes(sp)) {
          issues.push(`第${n}镜分配表台词的说话人"${sp}"不在该镜 characters 数组中,必须让说话人出镜:把"${sp}"加入 characters,并在 description 中安排其出场与说话动作`);
        }
      }
      // 画面实义出场的角色也必须有参考图锚点:实测 description 写了龙猫但 characters 漏排,
      // 导致龙猫无立绘参考,<Picture N> 编号错位到道具/场景图,跨镜塌缩成不同生物(D:抽象提及不算出场)
      for (const sp of universe) {
        if (!characters.includes(sp) && mentionedAsPresent(desc, sp)) {
          issues.push(`第${n}镜 description 提及了"${sp}"但未加入该镜 characters 数组,出场角色必须列入 characters 以获得参考图锚点`);
        }
      }
    }
  });
  return issues;
}

/** 分镜最终产出修复(代码兜底,三次重试后执行):台词逐字回填分配表 + 出场角色补全。
 * 实测:首轮台词合规、仅景别违规触发重试后,LLM 借机整篇重写,把分配表 [3,3,3,3,3] 改成
 * [3,2,2,2,2],龙猫 4 句台词与告别句全部消失;说话人随之不再出镜→无立绘参考→跨镜身份塌缩。
 * 台词与分配表的逐字合同不再信任 LLM,由代码强制执行;description 按被改写台词写就的残留
 * 漂移是零丢句的代价(三次重试已给足 LLM 对齐机会)。返回修复清单供日志审计。 */
export function repairStoryboard(data: unknown, dialoguePlan?: string[][] | null, indexOffset = 0): string[] {
  if (!Array.isArray(dialoguePlan)) return [];
  const shots = (data as { shots?: { description?: string; dialogue?: string[]; characters?: string[] }[] })?.shots;
  if (!Array.isArray(shots)) return [];
  const universe = [...new Set(
    dialoguePlan.flat().map((l) => /^([^：:]+)[：:]/.exec(l.trim())?.[1]?.trim() ?? "").filter(Boolean),
  )];
  const fixes: string[] = [];
  shots.forEach((s, i) => {
    const want = dialoguePlan[i] ?? [];
    const characters = Array.isArray(s.characters) ? s.characters : [];
    if (JSON.stringify(s.dialogue ?? []) !== JSON.stringify(want)) {
      fixes.push(`第${indexOffset + i + 1}镜 dialogue 回填分配表(${(s.dialogue ?? []).length}句→${want.length}句)`);
      s.dialogue = want;
    }
    const add: string[] = [];
    for (const line of want) {
      const sp = /^([^：:]+)[：:]/.exec(line.trim())?.[1]?.trim() ?? "";
      if (sp && !characters.includes(sp) && !add.includes(sp)) add.push(sp);
    }
    for (const sp of universe) {
      if (!characters.includes(sp) && !add.includes(sp) && mentionedAsPresent(s.description ?? "", sp)) add.push(sp);
    }
    if (add.length) {
      fixes.push(`第${indexOffset + i + 1}镜 characters 补入:${add.join("、")}`);
      s.characters = [...characters, ...add];
    }
  });
  return fixes;
}

/** 关键违规的代码模板修复(定向修复前的确定性兜底,C'/H/I 三类逐条可机械修复):
 * I 背对镜头→侧对镜头(词面替换);H 引用台词→删除含台词片段的子句(子句已被台词污染,整句删);
 * C' 说话人未安排出场→desc 末尾追加入画说话模板句(desc 是给视频模型的 prose,合式指令即有效)。
 * 修复后必须重新过 validateStoryboard 复检,复检通过才放行——不中断不等于放水。
 * 返回修复清单供日志审计 */
export function templateRepairStoryboard(data: unknown, dialoguePlan?: string[][] | null, indexOffset = 0): string[] {
  if (!Array.isArray(dialoguePlan)) return [];
  const shots = (data as { shots?: { description?: string; dialogue?: string[]; characters?: string[] }[] })?.shots;
  if (!Array.isArray(shots)) return [];
  const fixes: string[] = [];
  shots.forEach((s, i) => {
    const want = dialoguePlan[i] ?? [];
    const n = indexOffset + i + 1;
    let desc = s.description ?? "";
    if (!desc || want.length === 0) return;
    const texts = want.map((l) => l.replace(/^[^：:]+[：:]/, "").trim()).filter(Boolean);
    // I:背对→侧对(带台词镜与 speakerNote 口型要求冲突,侧对是保口型的安全折中)
    if (/背(?:对|向|朝)镜头/.test(desc)) {
      desc = desc.replace(/背对镜头/g, "侧对镜头").replace(/背向镜头/g, "侧对镜头").replace(/背朝镜头/g, "侧对镜头");
      fixes.push(`第${n}镜 背对镜头→侧对镜头`);
    }
    // H:删除含台词片段的子句(保留分隔符切分,只删污染句,不伤运镜/落幅结构)
    const clauses = desc.split(/(?<=[。；;，,])/);
    const kept = clauses.filter((cl) => {
      const quoted = [...cl.matchAll(/[「『"][^」』"]{2,}[」』"]/g)].map((m) => m[0].slice(1, -1));
      if (quoted.some((q) => texts.some((t) => t.includes(q) || q.includes(t)))) return false;
      return !texts.some((t) => t.length >= 6 && cl.includes(t));
    });
    if (kept.length < clauses.length) {
      desc = kept.join("");
      fixes.push(`第${n}镜 删除台词原文子句${clauses.length - kept.length}句`);
    }
    // C':未实义出场的说话人追加模板句(在 H 删除之后判断,删除可能连带删掉原出场描写;
    // 检测口径与 C' 检查一致用 stagedWithAction,否则检查打回而修复认为已出场,梯子空转)
    for (const line of want) {
      const sp = /^([^：:]+)[：:]/.exec(line.trim())?.[1]?.trim();
      if (sp && !stagedWithAction(desc, sp)) {
        desc = `${desc.replace(/[。；;，,\s]+$/, "")},${sp}侧身入画,面向画面内对象开口说话。`;
        fixes.push(`第${n}镜 追加说话人出场:${sp}`);
      }
    }
    s.description = desc;
  });
  return fixes;
}

/** 定向修复:模板修复仍不达标时,把完整分镜+违规清单送 storyboard-fix 修复师,只接受
 * 被点名镜头的修复结果,其余镜头逐字保持原样——"整篇重写回归"(修 A 坏 B,实测借重试
 * 把分配表 [3,3,3,3,3] 改成 [3,2,2,2,2])在结构上被排除。失败/超长/镜数不符返回 null */
async function targetedStoryboardFix(
  shots: unknown[],
  dialoguePlan: string[][],
  indexOffset: number,
  issues: string[],
): Promise<unknown[] | null> {
  try {
    const raw = await createAgnesChatCompletion({
      messages: [
        { role: "system", content: PLAN_SYSTEMS["storyboard-fix"] },
        { role: "user", content: JSON.stringify({ shots, dialoguePlan, violations: issues }) },
      ],
      maxTokens: 8192,
    });
    const fixed = extractJson(raw) as { shots?: unknown[] };
    const fixedShots = fixed?.shots;
    if (!Array.isArray(fixedShots) || fixedShots.length !== shots.length) {
      console.warn(`[agent/plan] storyboard 定向修复输出镜数不符(${Array.isArray(fixedShots) ? fixedShots.length : "n/a"}/${shots.length}),弃用`);
      return null;
    }
    // 拼回:只有 violations 点名的镜号才取修复结果,未点名镜头保持原样
    const named = new Set(issues.map((i) => /第(\d+)镜/.exec(i)?.[1]).filter(Boolean).map(Number));
    return shots.map((s, i) => (named.has(indexOffset + i + 1) ? fixedShots[i] : s));
  } catch (e) {
    console.warn("[agent/plan] storyboard 定向修复调用失败:", (e as Error).message);
    return null;
  }
}


export async function POST(req: NextRequest) {
  try {
    const { task, input, shotCount, secondsPerShot } = (await req.json()) as { task?: string; input?: string; shotCount?: number; secondsPerShot?: string };
    const system = task ? PLAN_SYSTEMS[task] : undefined;
    if (!system || !input?.trim()) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    let lastErr: Error | null = null;
    let retryIssues: string[] | undefined;
    // 分镜/大纲/资产给 3 次机会:实测 2 次时 LLM 会借最后一次重试整篇重写、私自改台词(台词合同由 repairStoryboard 代码兜底)
    const maxAttempts = ["storyboard", "outline", "outline-continue", "assets"].includes(task!) ? 3 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // 大纲任务走 Best-of-N(并行候选),其余任务单发
        if (task === "outline" || task === "outline-continue") {
          // C: Best-of-N——大纲 token 便宜,每轮并行 3 候选,取首个零违规者;全违规则取违规
          // 最少者进入重试/硬阻断梯,把语义类违规(句长)的失败率压在最便宜的阶段
          const settled = await Promise.allSettled(
            Array.from({ length: 3 }, () => createAgnesChatCompletion({
              messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount, secondsPerShot, retryIssues) }],
              maxTokens: 8192,
            })),
          );
          const raws = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
          if (!raws.length) throw (settled[0] as PromiseRejectedResult).reason;
          const candidates = raws.map((raw) => {
            try {
              const data = extractJson(raw);
              return { data, issues: validateOutline(data, shotCount, secondsPerShot) };
            } catch {
              return { data: null as unknown, issues: ["输出 JSON 解析失败"] };
            }
          });
          const clean = candidates.find((c) => c.issues.length === 0);
          if (clean) return NextResponse.json({ ok: true, data: clean.data });
          const best = candidates.reduce((a, b) => (b.issues.length < a.issues.length ? b : a));
          if (!best.data) throw new Error("3 候选输出 JSON 解析均失败");
          if (attempt < maxAttempts - 1) {
            console.warn(`[agent/plan] ${task} 第${attempt + 1}轮3候选全违规(最少${best.issues.length}处),取最优带清单重试:`, best.issues.join(" | "));
            retryIssues = best.issues;
            continue;
          }
          // 句长违规硬阻断:超短句(1~8字)留静音空窗,视频模型用即兴语音填空——"台词乱说"的老根因
          const badLen = best.issues.filter((i) => i.includes("每句台词必须9~20字"));
          if (badLen.length) {
            console.error(`[agent/plan] ${task} ${maxAttempts}轮×3候选后台词句长仍不达标${badLen.length}处,整批打回`);
            return NextResponse.json({ error: `大纲台词句长合同未达标(重试${maxAttempts}轮×3候选):${badLen.join("；")}` }, { status: 502 });
          }
          return NextResponse.json(best.issues.length ? { ok: true, data: best.data, issues: best.issues } : { ok: true, data: best.data });
        }
        const raw = await createAgnesChatCompletion({
          messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount, secondsPerShot, retryIssues) }],
          maxTokens: 8192,
        });
        try {
          const data = extractJson(raw);
          // 分镜输出做合同校验:违规不直接放行,带违规清单重试;最后一轮仍违规则代码修复后放行
          if (task === "storyboard") {
            const parsed = JSON.parse(input) as { count: number; dialoguePlan?: string[][] | null; indexOffset?: number };
            const issues = validateStoryboard(data, parsed.count, parsed.dialoguePlan, parsed.indexOffset ?? 0);
            if (issues.length > 0 && attempt < maxAttempts - 1) {
              console.warn(`[agent/plan] storyboard 第${attempt + 1}轮违规${issues.length}处,带清单重试:`, issues.join(" | "));
              retryIssues = issues;
              continue;
            }
            // 关键违规不放行:说话人未安排出场(C' desc 侧)与引用台词原文(H)带病放行即产出
            // "画外音即兴乱说/对镜头说话"的缺陷视频(实测首批 17 处违规照常 ship)。修复梯子:
            // 代码修复(repair+template)→复检 → 定向修复(只送违规镜头,2轮)→复检 → 才打回。
            // 不中断≠放水:每步修复后都过同一把 validateStoryboard 复检,复检通过才继续
            const repairs = repairStoryboard(data, parsed.dialoguePlan, parsed.indexOffset ?? 0);
            const templateFixes = templateRepairStoryboard(data, parsed.dialoguePlan, parsed.indexOffset ?? 0);
            if (repairs.length || templateFixes.length) {
              console.warn(`[agent/plan] storyboard 代码修复:`, [...repairs, ...templateFixes].join(" | "));
            }
            const isCritical = (list: string[]) =>
              list.filter((i) => i.includes("未在 description 中安排出场") || i.includes("引用了台词原文") || i.includes("前两句无说话人"));
            let remaining = validateStoryboard(data, parsed.count, parsed.dialoguePlan, parsed.indexOffset ?? 0);
            if (isCritical(remaining).length && Array.isArray(parsed.dialoguePlan)) {
              const container = data as { shots?: unknown[] };
              for (let fixRound = 0; fixRound < 2; fixRound++) {
                const spliced = await targetedStoryboardFix(
                  container.shots ?? [], parsed.dialoguePlan, parsed.indexOffset ?? 0, remaining,
                );
                if (!spliced) break;
                container.shots = spliced;
                remaining = validateStoryboard(data, parsed.count, parsed.dialoguePlan, parsed.indexOffset ?? 0);
                if (isCritical(remaining).length === 0) {
                  console.warn(`[agent/plan] storyboard 第${fixRound + 1}轮定向修复后复检通过`);
                  break;
                }
              }
            }
            const critical = isCritical(remaining);
            if (critical.length) {
              console.error(`[agent/plan] storyboard 修复梯子(${maxAttempts}轮重试+代码修复+定向修复)后仍有关键违规${critical.length}处,整批打回:`, critical.join(" | "));
              return NextResponse.json({ error: `分镜关键合同未达标(已重试${maxAttempts}轮+代码/定向修复):${critical.join("；")}` }, { status: 502 });
            }
            return NextResponse.json(remaining.length ? { ok: true, data, issues: remaining } : { ok: true, data });
          }
          // 资产清单校验(B合同):大纲角色/场景逐字覆盖检查,缺则带清单重试
          if (task === "assets") {
            const issues = validateAssets(data, input!);
            if (issues.length > 0 && attempt < maxAttempts - 1) {
              console.warn(`[agent/plan] assets 第${attempt + 1}轮违规${issues.length}处,带清单重试:`, issues.join(" | "));
              retryIssues = issues;
              continue;
            }
            return NextResponse.json(issues.length ? { ok: true, data, issues } : { ok: true, data });
          }
          return NextResponse.json({ ok: true, data });
        } catch (e) {
          // 记录原始输出头部与尾部,便于定位是截断、闭合符错序还是格式跑偏
          console.error(`[agent/plan] ${task} 第${attempt + 1}次 JSON 解析失败(长度${raw.length}),原始输出头部:`, raw.slice(0, 300), "尾部:", raw.slice(-200));
          throw e;
        }
      } catch (e) {
        lastErr = e as Error;
      }
    }
    return NextResponse.json({ error: `规划失败:${lastErr?.message ?? "未知错误"}` }, { status: 502 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
