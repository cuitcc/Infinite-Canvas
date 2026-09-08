import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { PLAN_SYSTEMS, extractJson } from "@/lib/agent-prompts";

function buildUser(task: string, input: string, shotCount?: number, secondsPerShot?: string, retryIssues?: string[]): string {
  if (task === "storyboard") {
    const { outline, assetNames, sceneNames, count, dialoguePlan } = JSON.parse(input) as {
      outline: unknown; assetNames: string[]; sceneNames?: string[]; count: number; dialoguePlan?: string[][] | null;
    };
    const scenes = sceneNames?.length ? `\n可用场景:${sceneNames.join("、")}` : "";
    // 台词分配表由代码算死,分镜师逐字照抄;每镜秒数供运镜/台词节奏参考
    const planText = Array.isArray(dialoguePlan)
      ? `\n各镜台词分配表(dialogue 必须逐字照抄,禁止增删改):\n${dialoguePlan.map((lines, i) => `第${i + 1}镜:${lines.length ? lines.join("；") : "(无台词)"}`).join("\n")}`
      : "";
    // 校验不合规时带违规清单重试:提示词约束对 LLM 不可靠(台词分配的教训),改用"检查-反馈-重试"合同
    const retry = retryIssues?.length ? `\n\n你上一次的输出存在以下违规,本次必须全部修正:\n${retryIssues.map((s, i) => `${i + 1}.${s}`).join("\n")}` : "";
    return `分镜数量:${count}\n每镜秒数:${secondsPerShot ?? "10"}${planText}\n剧本大纲:\n${JSON.stringify(outline)}\n可用角色:${assetNames.join("、")}${scenes}${retry}`;
  }
  // shotCount:outline 分支注入片长容量;storyboard 分支的 count 从 input 内部解析
  if (task === "outline" && shotCount && secondsPerShot) {
    return `${input}\n(全片共${shotCount}个分镜,每镜${secondsPerShot}秒,全片约${Number(shotCount) * Number(secondsPerShot)}秒)`;
  }
  return shotCount ? `${input}\n(分镜数量备用:${shotCount})` : input;
}

const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"] as const;
/** 运镜词 → 规范类别:与提示词允许的缓慢运镜词表对齐;子串匹配容易误伤("推开门"),只认显式运镜表述 */
const CAMERA_VERBS: [RegExp, string][] = [
  [/推镜|推近|推进|缓推/, "推"], [/拉镜|拉远|缓拉/, "拉"], [/摇镜|摇拍|缓慢摇/, "摇"], [/横移|移镜|平移/, "移"],
  [/跟拍|跟随/, "跟"], [/环绕|绕拍/, "环绕"],
];

/** 分镜产出校验:相邻景别/主运镜重复、台词与分配表不符、说话人未出镜、description 提及的说话人未入 characters。
 * 返回违规清单,空数组=合规 */
export function validateStoryboard(data: unknown, count: number, dialoguePlan?: string[][] | null): string[] {
  const shots = (data as { shots?: { description?: string; dialogue?: string[]; characters?: string[] }[] })?.shots;
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
    const n = i + 1;
    const desc = s.description ?? "";
    const size = SHOT_SIZES.find((w) => desc.includes(w)) ?? "";
    const verb = CAMERA_VERBS.find(([re]) => re.test(desc))?.[1] ?? "";
    if (size && size === prevSize) issues.push(`第${n - 1}镜与第${n}镜景别重复(${size}),相邻两镜景别必须变化`);
    if (verb && verb === prevVerb) issues.push(`第${n - 1}镜与第${n}镜主运镜重复(${verb}),相邻两镜主运镜必须不同`);
    prevSize = size;
    prevVerb = verb;
    const characters = Array.isArray(s.characters) ? s.characters : [];
    if (Array.isArray(dialoguePlan)) {
      const want = dialoguePlan[i] ?? [];
      const got = Array.isArray(s.dialogue) ? s.dialogue : [];
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        issues.push(`第${n}镜 dialogue 必须逐字等于分配表:${want.length ? want.join("；") : "(空数组)"}`);
      }
      // 谁说话谁出镜(硬合同):分配表说话人不在该镜 characters 数组时打回,分镜阶段就把人排进画面。
      // 这是孤儿台词的根治——分配表镜头盲,只有这里能强制 description 与台词在同一镜内对齐
      for (const line of want) {
        const sp = /^([^：:]+)[：:]/.exec(line.trim())?.[1]?.trim();
        if (sp && !characters.includes(sp)) {
          issues.push(`第${n}镜分配表台词的说话人"${sp}"不在该镜 characters 数组中,必须让说话人出镜:把"${sp}"加入 characters,并在 description 中安排其出场与说话动作`);
        }
      }
      // 画面提及的角色也必须有参考图锚点:实测 description 写了龙猫但 characters 漏排,
      // 导致龙猫无立绘参考,<Picture N> 编号错位到道具/场景图,跨镜塌缩成不同生物
      for (const sp of universe) {
        if (desc.includes(sp) && !characters.includes(sp)) {
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
export function repairStoryboard(data: unknown, dialoguePlan?: string[][] | null): string[] {
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
      fixes.push(`第${i + 1}镜 dialogue 回填分配表(${(s.dialogue ?? []).length}句→${want.length}句)`);
      s.dialogue = want;
    }
    const add: string[] = [];
    for (const line of want) {
      const sp = /^([^：:]+)[：:]/.exec(line.trim())?.[1]?.trim() ?? "";
      if (sp && !characters.includes(sp) && !add.includes(sp)) add.push(sp);
    }
    for (const sp of universe) {
      if ((s.description ?? "").includes(sp) && !characters.includes(sp) && !add.includes(sp)) add.push(sp);
    }
    if (add.length) {
      fixes.push(`第${i + 1}镜 characters 补入:${add.join("、")}`);
      s.characters = [...characters, ...add];
    }
  });
  return fixes;
}


export async function POST(req: NextRequest) {
  try {
    const { task, input, shotCount, secondsPerShot } = (await req.json()) as { task?: string; input?: string; shotCount?: number; secondsPerShot?: string };
    const system = task ? PLAN_SYSTEMS[task] : undefined;
    if (!system || !input?.trim()) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    let lastErr: Error | null = null;
    let retryIssues: string[] | undefined;
    // 分镜给 3 次机会:实测 2 次时 LLM 会借最后一次重试整篇重写、私自改台词(台词合同由 repairStoryboard 代码兜底)
    const maxAttempts = task === "storyboard" ? 3 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const raw = await createAgnesChatCompletion({
          messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount, secondsPerShot, retryIssues) }],
          maxTokens: 8192,
        });
        try {
          const data = extractJson(raw);
          // 分镜输出做合同校验:违规不直接放行,带违规清单重试;最后一轮仍违规则代码修复后放行
          if (task === "storyboard") {
            const parsed = JSON.parse(input) as { count: number; dialoguePlan?: string[][] | null };
            const issues = validateStoryboard(data, parsed.count, parsed.dialoguePlan);
            if (issues.length > 0 && attempt < maxAttempts - 1) {
              console.warn(`[agent/plan] storyboard 第${attempt + 1}轮违规${issues.length}处,带清单重试:`, issues.join(" | "));
              retryIssues = issues;
              continue;
            }
            const repairs = repairStoryboard(data, parsed.dialoguePlan);
            if (repairs.length) console.warn(`[agent/plan] storyboard 最终代码修复:`, repairs.join(" | "));
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
