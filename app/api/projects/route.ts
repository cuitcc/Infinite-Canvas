import { NextResponse } from "next/server";
import { ensureDefaultProject } from "@/lib/db";

export async function GET() {
  try {
    const project = ensureDefaultProject();
    return NextResponse.json(project);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
