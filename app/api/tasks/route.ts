import { NextRequest, NextResponse } from "next/server";
import { getDb, getPendingGenTasks } from "@/lib/db";
import { submissionInfo } from "@/lib/video-queue";
import { startVideoPoller } from "@/lib/poll";

export async function GET(req: NextRequest) {
  try {
    startVideoPoller();
    const projectId = req.nextUrl.searchParams.get("projectId");
    const nodeId = req.nextUrl.searchParams.get("nodeId");
    const statuses = getPendingGenTasks()
      .filter((t) => (!projectId || t.project_id === projectId) && (!nodeId || t.node_id === nodeId))
      .map((t) => {
        const queue = t.status === "queued" ? submissionInfo(t.id) : undefined;
        return { id: t.id, nodeId: t.node_id, kind: t.kind, status: t.status,
          message: queue?.message ?? (t.status === "in_progress" ? "上游已受理，正在生成" : "排队中"),
          nextRetryAt: queue?.next_at || undefined };
      });

    // recent 窗口 10 分钟:页面卡顿/后台节流会错过 15s 窄窗导致节点永远停在生成中,
    // 指定 nodeId 时不限制时间窗，供长时间等待后恢复原任务结果。
    // 只取每个节点最新一条任务:重新生成期间,同节点旧的 completed 任务会把 generating 节点瞬间改回旧 done
    const completed = getDb()
      .prepare(`SELECT node_id, status, media_id, error FROM gen_tasks t
        WHERE project_id = ? AND status IN ('completed','failed') AND (? IS NOT NULL OR updated_at > ?) AND (? IS NULL OR node_id=?)
        AND created_at = (SELECT MAX(created_at) FROM gen_tasks t2 WHERE t2.node_id = t.node_id AND t2.project_id = t.project_id)
        ORDER BY updated_at DESC LIMIT 100`)
      .all(projectId ?? "", nodeId, Date.now() - 600_000, nodeId, nodeId) as Array<{ node_id: string; status: string; media_id: string | null; error: string | null }>;

    return NextResponse.json({ pending: statuses, recent: completed });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
