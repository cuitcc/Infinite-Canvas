import { NextRequest, NextResponse } from "next/server";
import { deletePipelineSnapshot, getPipelineSnapshot } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const snapshot = getPipelineSnapshot(id);
    if (!snapshot) return NextResponse.json({ error: "快照不存在" }, { status: 404 });
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    deletePipelineSnapshot(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
