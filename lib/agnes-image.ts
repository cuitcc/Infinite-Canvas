import { AgnesCreateImageBody, AgnesImageResponse, CreateImageInput } from "@/types/agnes";
import { AgnesApiError } from "./agnes-video";

const DEFAULT_BASE_URL = "https://api.agnes-ai.cn/v1";

const QUALITY_TAG = "masterpiece, best quality, ultra-detailed, 8k uhd, highres, sharp focus";
const DEFAULT_NEGATIVE_PROMPT = "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry";

export function buildAgnesImageRequest(input: CreateImageInput): AgnesCreateImageBody {
  const body: AgnesCreateImageBody = {
    model: "agnes-image-2.1-flash",
    prompt: enhancePrompt(input.prompt),
    // 档位(1K/2K/3K/4K)优先;兼容旧的精确尺寸写法
    size: input.size || "4K",
  };

  if (input.ratio) {
    body.ratio = input.ratio;
  }

  // Agnes text-to-image 队列不支持 negative_prompt，只在图生图时携带
  if (input.mode === "image") {
    body.negative_prompt = input.negative_prompt
      ? `${input.negative_prompt}, ${DEFAULT_NEGATIVE_PROMPT}`
      : DEFAULT_NEGATIVE_PROMPT;
  }

  const imageUrls = input.mode === "image"
    ? normalizeImageUrls(input.imageUrls || (input.imageUrl ? [input.imageUrl] : []))
    : [];

  if (imageUrls.length > 0) {
    body.extra_body = {
      image: imageUrls,
      response_format: "url",
    };
  }

  return body;
}

function enhancePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (/masterpiece|best quality|ultra-detailed/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}, ${QUALITY_TAG}`;
}

function normalizeImageUrls(urls: string[]) {
  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)));
}

export async function createAgnesImage(body: AgnesCreateImageBody): Promise<AgnesImageResponse> {
  return createAgnesImageWithRetry(body, 3);
}

async function createAgnesImageWithRetry(body: AgnesCreateImageBody, maxAttempts: number): Promise<AgnesImageResponse> {
  const apiKey = process.env.AGNES_API_KEY;

  if (!apiKey) {
    throw new AgnesApiError("未配置 AGNES_API_KEY", 500);
  }

  const baseUrl = process.env.AGNES_API_BASE_URL || DEFAULT_BASE_URL;
  let lastError: AgnesApiError | undefined;
  const timeoutMs = parsePositiveInteger(process.env.AGNES_IMAGE_TIMEOUT_MS) || 90_000;

  console.log("[agnes-image] request", {
    model: body.model,
    size: body.size,
    ratio: body.ratio,
    promptLength: body.prompt.length,
    negativePromptLength: body.negative_prompt?.length,
    imageCount: body.extra_body?.image?.length,
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      }, timeoutMs);
    } catch (error) {
      lastError = new AgnesApiError("Agnes 图片生成请求超时或网络失败", 504, {
        attempt,
        maxAttempts,
        cause: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      if (attempt === maxAttempts) {
        throw lastError;
      }
      await sleep(1200 * attempt);
      continue;
    }

    const text = await response.text();
    const data = text ? safeJson(text) : null;

    if (response.ok) {
      console.log("[agnes-image] response", { url: extractImageUrl(data as AgnesImageResponse) });
      return data as AgnesImageResponse;
    }

    lastError = new AgnesApiError(mapAgnesImageError(response.status, data), response.status, {
      ...(data && typeof data === "object" ? data as Record<string, unknown> : { response: data }),
      prompt: body.prompt,
    });
    if (!shouldRetryImageStatus(response.status) || attempt === maxAttempts) {
      throw lastError;
    }

    await sleep(1200 * attempt);
  }

  throw lastError || new AgnesApiError("Agnes 图片生成失败", 500);
}

export function extractImageUrl(response: AgnesImageResponse): string | undefined {
  return response.data?.find((item) => item.url)?.url || response.url || response.image_url;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shouldRetryImageStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function mapAgnesImageError(status: number, data: unknown) {
  if (status === 400 && getAgnesImageErrorCode(data) === "content_policy_violation") {
    return "Agnes 拋绝生成该图片提示词，请调整提示词后重试";
  }

  return "Agnes 图片生成失败";
}

function getAgnesImageErrorCode(data: unknown) {
  if (!data || typeof data !== "object") return undefined;
  const error = (data as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parsePositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
