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

/** 分镜产出校验:相邻景别/主运镜重复、台词与分配表不符。返回违规清单,空数组=合规 */
function validateStoryboard(data: unknown, count: number, dialoguePlan?: string[][] | null): string[] {
  const shots = (data as { shots?: { description?: string; dialogue?: string[] }[] })?.shots;
  if (!Array.isArray(shots) || shots.length !== count) {
    return [`分镜数量必须严格等于${count}`];
  }
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
    if (Array.isArray(dialoguePlan)) {
      const want = dialoguePlan[i] ?? [];
      const got = Array.isArray(s.dialogue) ? s.dialogue : [];
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        issues.push(`第${n}镜 dialogue 必须逐字等于分配表:${want.length ? want.join("；") : "(空数组)"}`);
      }
    }
  });
  return issues;
}


export async function POST(req: NextRequest) {
  try {
    const { task, input, shotCount, secondsPerShot } = (await req.json()) as { task?: string; input?: string; shotCount?: number; secondsPerShot?: string };
    const system = task ? PLAN_SYSTEMS[task] : undefined;
    if (!system || !input?.trim()) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    let lastErr: Error | null = null;
    let retryIssues: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await createAgnesChatCompletion({
          messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount, secondsPerShot, retryIssues) }],
          maxTokens: 8192,
        });
        try {
          const data = extractJson(raw);
          // 分镜输出做合同校验:首轮违规不直接放行,带违规清单重试一次;仍违规则返回数据并把清单带给调用方
          if (task === "storyboard") {
            const parsed = JSON.parse(input) as { count: number; dialoguePlan?: string[][] | null };
            const issues = validateStoryboard(data, parsed.count, parsed.dialoguePlan);
            if (issues.length > 0 && attempt === 0) {
              console.warn(`[agent/plan] storyboard 首轮违规${issues.length}处,带清单重试:`, issues.join(" | "));
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
