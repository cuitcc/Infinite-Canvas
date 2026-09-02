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

    const completed = getDb()
      .prepare("SELECT node_id, status, media_id, error FROM gen_tasks WHERE project_id = ? AND status IN ('completed','failed') AND updated_at > ? ORDER BY updated_at DESC LIMIT 50")
      .all(projectId ?? "", Date.now() - 15000) as Array<{ node_id: string; status: string; media_id: string | null; error: string | null }>;

    return NextResponse.json({ pending: statuses, recent: completed });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
