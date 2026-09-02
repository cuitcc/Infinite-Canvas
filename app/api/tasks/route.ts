import { NextRequest, NextResponse } from "next/server";
import { getDb, getPendingGenTasks } from "@/lib/db";
import { startVideoPoller } from "@/lib/poll";

export async function GET(req: NextRequest) {
  try {
    startVideoPoller();
    const projectId = req.nextUrl.searchParams.get("projectId");
    const statuses = getPendingGenTasks()
      .filter((t) => !projectId || t.project_id === projectId)
      .map((t) => ({ id: t.id, nodeId: t.node_id, kind: t.kind, status: t.status }));

    // recent 窗口 10 分钟:页面卡顿/后台节流会错过 15s 窄窗导致节点永远停在生成中,
    // 编排器只能 15 分钟超时重试;客户端只在节点仍 queued/generating 时应用,放宽窗口幂等安全
    const completed = getDb()
      .prepare("SELECT node_id, status, media_id, error FROM gen_tasks WHERE project_id = ? AND status IN ('completed','failed') AND updated_at > ? ORDER BY updated_at DESC LIMIT 100")
      .all(projectId ?? "", Date.now() - 600_000) as Array<{ node_id: string; status: string; media_id: string | null; error: string | null }>;

    return NextResponse.json({ pending: statuses, recent: completed });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
