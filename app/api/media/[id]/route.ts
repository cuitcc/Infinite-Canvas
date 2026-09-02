import { NextRequest, NextResponse } from "next/server";
import { getMediaById, MEDIA_DIR } from "@/lib/db";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = getMediaById(id);

  if (!record || !record.localPath) {
    return NextResponse.json({ error: "媒体不存在" }, { status: 404 });
  }

  const filePath = path.join(process.cwd(), record.localPath);
  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "媒体文件缺失" }, { status: 404 });
  }

  const stat = statSync(filePath);
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      const stream = createReadStream(filePath, { start, end });
      return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": record.mimeType || "application/octet-stream",
        },
      });
    }
  }

  const stream = createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Length": String(stat.size),
      "Content-Type": record.mimeType || "application/octet-stream",
      "Accept-Ranges": "bytes",
    },
  });
}
