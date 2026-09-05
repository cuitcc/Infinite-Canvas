import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { PLAN_SYSTEMS, extractJson } from "@/lib/agent-prompts";

function buildUser(task: string, input: string, shotCount?: number, secondsPerShot?: string): string {
  if (task === "storyboard") {
    const { outline, assetNames, sceneNames, count } = JSON.parse(input) as { outline: unknown; assetNames: string[]; sceneNames?: string[]; count: number };
    const scenes = sceneNames?.length ? `\n可用场景:${sceneNames.join("、")}` : "";
    // 每镜秒数必须出现在用户消息里,分镜规则 4 的台词量匹配依赖它
    return `分镜数量:${count}\n每镜秒数:${secondsPerShot ?? "10"}\n剧本大纲:\n${JSON.stringify(outline)}\n可用角色:${assetNames.join("、")}${scenes}`;
  }
  // outline:注入片长容量(分镜数×每镜秒数),供大纲系统提示词的台词总量控制使用
  if (shotCount && secondsPerShot) {
    return `${input}\n(全片共${shotCount}个分镜,每镜${secondsPerShot}秒,全片约${Number(shotCount) * Number(secondsPerShot)}秒)`;
  }
  return shotCount ? `${input}\n(分镜数量备用:${shotCount})` : input;
}

export async function POST(req: NextRequest) {
  try {
    const { task, input, shotCount, secondsPerShot } = (await req.json()) as { task?: string; input?: string; shotCount?: number; secondsPerShot?: string };
    const system = task ? PLAN_SYSTEMS[task] : undefined;
    if (!system || !input?.trim()) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await createAgnesChatCompletion({
          messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount, secondsPerShot) }],
          maxTokens: 8192,
        });
        try {
          return NextResponse.json({ ok: true, data: extractJson(raw) });
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
