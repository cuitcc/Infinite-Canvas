import { NextRequest, NextResponse } from "next/server";
import { getPipelineSnapshot, saveProjectGraph, saveTimeline } from "@/lib/db";
import type { TimelineClip } from "@/lib/db";

/** 载入快照：用快照的节点/连线/时间线整体替换当前项目画布（不在快照中的现有节点会被清除） */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const projectId = String(body.projectId ?? "");
    if (!projectId) return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
    const snapshot = getPipelineSnapshot(id);
    if (!snapshot) return NextResponse.json({ error: "快照不存在" }, { status: 404 });

    saveProjectGraph(projectId, { nodes: snapshot.data.nodes, edges: snapshot.data.edges });
    saveTimeline(projectId, (snapshot.data.clips ?? []) as TimelineClip[]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
