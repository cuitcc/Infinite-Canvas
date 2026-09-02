import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function downloadImageBuffer(imageUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(imageUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      "User-Agent": "Infinite-Canvas reference downloader",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`图片下载失败：${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("远端资源不是图片");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("图片内容为空");
  }

  return { buffer, contentType };
}

function resolveFfmpeg(): string {
  const candidates = [
    process.env.FFMPEG_BINARY_PATH,
    path.join(process.cwd(), "bin", "ffmpeg"),
    path.join(process.cwd(), "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg"),
    "ffmpeg",
  ];
  for (const c of candidates) {
    if (c && (c === "ffmpeg" || existsSync(c))) return c;
  }
  return "ffmpeg";
}

/** 将图片缩放到最大边不超过 maxPx,保持宽高比。返回 PNG buffer。 */
export async function resizeImageBuffer(buffer: Buffer, maxPx = 1024): Promise<Buffer> {
  if (!buffer || buffer.length === 0) {
    throw new Error("图片内容为空");
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "canvas-img-"));
  const inputPath = path.join(tmpDir, "input");
  const outputPath = path.join(tmpDir, "output.png");

  try {
    writeFileSync(inputPath, buffer);
    const ffmpeg = resolveFfmpeg();
    await execFileAsync(
      ffmpeg,
      [
        "-y",
        "-i", inputPath,
        "-vf", `scale=${maxPx}:${maxPx}:force_original_aspect_ratio=decrease`,
        "-pix_fmt", "rgba",
        outputPath,
      ],
      { timeout: 60_000 },
    );
    return readFileSync(outputPath);
  } finally {
    try {
      // 清理临时目录
      const { rmSync } = await import("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
