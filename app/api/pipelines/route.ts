import { NextRequest, NextResponse } from "next/server";
import { getProjectGraph, getTimeline, listPipelineSnapshots, savePipelineSnapshot, type PipelineSnapshotData } from "@/lib/db";

export async function GET() {
  try {
    return NextResponse.json({ pipelines: listPipelineSnapshots() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim() || `流水线-${new Date().toLocaleString("zh-CN", { hour12: false })}`;

    // 带 data → 从导入的 JSON 文件入库;不带 → 对当前项目画布做快照
    if (body.data) {
      const data = body.data as PipelineSnapshotData;
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        return NextResponse.json({ error: "JSON 格式不正确：缺少 nodes/edges 数组" }, { status: 400 });
      }
      return NextResponse.json(savePipelineSnapshot(name, { nodes: data.nodes, edges: data.edges, clips: Array.isArray(data.clips) ? data.clips : [] }));
    }

    const projectId = String(body.projectId ?? "");
    if (!projectId) return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
    const graph = getProjectGraph(projectId);
    if (graph.nodes.length === 0) {
      return NextResponse.json({ error: "当前画布为空，没有可保存的内容" }, { status: 400 });
    }
    return NextResponse.json(savePipelineSnapshot(name, { nodes: graph.nodes, edges: graph.edges, clips: getTimeline(projectId) }));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
