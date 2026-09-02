import { NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { EXPORT_DIR } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!name.endsWith(".mp4") || name.includes("..")) {
    return NextResponse.json({ error: "非法文件名" }, { status: 400 });
  }

  const filePath = path.join(EXPORT_DIR, name);
  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const stat = statSync(filePath);
  const stream = createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Length": String(stat.size),
      "Content-Type": "video/mp4",
    },
  });
}
