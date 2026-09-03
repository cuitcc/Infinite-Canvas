import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { PLAN_SYSTEMS, extractJson } from "@/lib/agent-prompts";

function buildUser(task: string, input: string, shotCount?: number): string {
  if (task === "storyboard") {
    const { outline, assetNames, count } = JSON.parse(input) as { outline: unknown; assetNames: string[]; count: number };
    return `分镜数量:${count}\n剧本大纲:\n${JSON.stringify(outline)}\n可用资产:${assetNames.join("、")}`;
  }
  return shotCount ? `${input}\n(分镜数量备用:${shotCount})` : input;
}

export async function POST(req: NextRequest) {
  try {
    const { task, input, shotCount } = (await req.json()) as { task?: string; input?: string; shotCount?: number };
    const system = task ? PLAN_SYSTEMS[task] : undefined;
    if (!system || !input?.trim()) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await createAgnesChatCompletion({
          messages: [{ role: "system", content: system }, { role: "user", content: buildUser(task!, input, shotCount) }],
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
