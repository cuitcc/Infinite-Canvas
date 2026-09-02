import { imageSize } from "image-size";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getMediaById } from "./db";
import { SUPPORTED_IMAGE_RATIOS } from "./image-config";

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function getImageDimensions(input: string | Buffer): Promise<ImageDimensions | undefined> {
  try {
    let buffer: Buffer;

    if (Buffer.isBuffer(input)) {
      buffer = input;
    } else if (input.startsWith("/api/media/")) {
      const mediaId = input.replace("/api/media/", "").split("?")[0];
      const record = getMediaById(mediaId);
      if (!record?.localPath) return undefined;
      const filePath = path.join(process.cwd(), record.localPath);
      buffer = readFileSync(filePath);
    } else {
      const response = await fetch(input, { cache: "no-store" });
      if (!response.ok) {
        console.warn("[image-size] 下载参考图失败", { url: input, status: response.status });
        return undefined;
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }

    const result = imageSize(buffer);
    if (!result.width || !result.height) {
      console.warn("[image-size] 无法读取图片尺寸", { type: result.type });
      return undefined;
    }

    return { width: result.width, height: result.height };
  } catch (error) {
    console.warn("[image-size] 读取图片尺寸失败", { input: typeof input === "string" ? input : "Buffer", error: (error as Error).message });
    return undefined;
  }
}

export function simplifyRatio(width: number, height: number): string {
  const gcd = greatestCommonDivisor(width, height);
  return `${width / gcd}:${height / gcd}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export function closestRatio(computed: string, supported = SUPPORTED_IMAGE_RATIOS): string {
  const computedValue = parseRatio(computed);
  if (!computedValue) return supported[0];

  let best = supported[0];
  let bestDiff = Infinity;

  for (const ratio of supported) {
    const value = parseRatio(ratio);
    if (!value) continue;
    const diff = Math.abs(value - computedValue);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ratio;
    }
  }

  return best;
}

function parseRatio(ratio: string): number | undefined {
  const parts = ratio.split(":").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return undefined;
  return parts[0] / parts[1];
}
