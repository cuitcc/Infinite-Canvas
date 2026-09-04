import { AgnesCreateVideoBody, AgnesVideoTask, AgnesVideoMode, CreateVideoInput } from "@/types/agnes";

const DEFAULT_BASE_URL = "https://api.agnes-ai.cn/v1";
const DEFAULT_VIDEO_MODEL = "agnes-video-2.5-flash";

export const AGNES_VIDEO_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const AGNES_VIDEO_SECONDS = ["4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;

/** 帧数必须是 8n+1 且 ≤441,向上/就近对齐(仅旧版 v2.0 使用) */
function clampFrames(requested: number): number {
  if (!Number.isFinite(requested) || requested < 9) return 121;
  // 对齐到 8n+1:余数 >4 向上,否则向下
  const remainder = (requested - 1) % 8;
  let aligned = remainder > 4 ? requested + (8 - remainder) : requested - remainder;
  if (aligned > 441) aligned = 441;
  if (aligned < 9) aligned = 9;
  return aligned;
}

function mapGenerationModeToAgnesMode(input: CreateVideoInput): AgnesVideoMode {
  if (input.mode === "image") return "keyframe";
  if (input.mode === "keyframes") return "reference";
  return "text";
}

export function buildAgnesVideoRequest(input: CreateVideoInput, model = DEFAULT_VIDEO_MODEL): AgnesCreateVideoBody {
  // 旧版 v2.0 保持原参数体系
  if (model === "agnes-video-v2.0") {
    const body: AgnesCreateVideoBody = {
      model: "agnes-video-v2.0",
      prompt: input.prompt,
      height: input.height ?? 768,
      width: input.width ?? 1152,
      num_frames: clampFrames(input.num_frames ?? 121),
      frame_rate: input.frame_rate ?? 24,
      extra_body: { response_format: "url" },
    };

    if (input.seed !== undefined) {
      body.seed = input.seed;
    }

    // 仅 v2.0 接受 negative_prompt;2.5-flash 传该字段会 400(invalid_request)
    if (input.negative_prompt) {
      body.negative_prompt = input.negative_prompt;
    }

    if (input.mode === "image" && input.image) {
      body.image = input.image;
    }

    if (input.mode === "keyframes" && input.images && input.images.length > 0) {
      body.extra_body = {
        ...body.extra_body,
        image: input.images,
        mode: "keyframes",
      };
    }

    return body;
  }

  // 新版 2.5 系: mode + seconds + size + aspect_ratio
  // 注意:2.5 系不接受 negative_prompt 字段(400 invalid_request),一律不下发
  const agnesMode = mapGenerationModeToAgnesMode(input);
  const flashOnly = !model || model === "agnes-video-2.5-flash";
  const body: AgnesCreateVideoBody = {
    // 基础版 agnes-video-2.5 支持 720P/960P/2K,flash 仅 720P
    model: flashOnly ? "agnes-video-2.5-flash" : "agnes-video-2.5",
    prompt: input.prompt,
    mode: agnesMode,
    size: flashOnly ? "720P" : ((input.size as "720P" | "960P" | "2K") ?? "960P"),
    seconds: input.seconds ?? "5",
    aspect_ratio: input.aspect_ratio ?? "16:9",
  };

  if (input.seed !== undefined) {
    body.seed = input.seed;
  }

  if (agnesMode === "keyframe") {
    // 单张首帧：first_frame；多张关键帧：first_frame + last_frame（目前只支持首尾两张）
    const refs = input.images && input.images.length > 0 ? input.images : input.image ? [input.image] : [];
    if (refs.length >= 1) body.first_frame = refs[0];
    if (refs.length >= 2) body.last_frame = refs[1];
  }

  if (agnesMode === "reference") {
    // reference 模式：images 数组，最多 5 张
    const refs = input.images && input.images.length > 0 ? input.images : input.image ? [input.image] : [];
    if (refs.length > 0) {
      body.images = refs.slice(0, 5);
    }
  }

  if (input.audios && input.audios.length > 0) {
    body.audios = input.audios.slice(0, 3); // 台词锚定:每句台词一条音频(文档上限 3 条)
  }

  return body;
}

export async function createAgnesVideo(body: AgnesCreateVideoBody): Promise<AgnesVideoTask> {
  console.log("[agnes-video] create request", {
    model: body.model,
    mode: body.mode,
    seconds: body.seconds,
    size: body.size,
    aspect_ratio: body.aspect_ratio,
    promptLength: body.prompt.length,
  });
  try {
    return await requestAgnes<AgnesVideoTask>("/videos", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Agnes 视频限流为每分钟 1 条：等待一个完整窗口后重试一次,仍失败则抛出明确提示
    if (error instanceof AgnesApiError && error.status === 429) {
      console.warn("[agnes-video] rate limited, retrying once after 65s");
      await sleep(65_000);
      return await requestAgnes<AgnesVideoTask>("/videos", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    throw error;
  }
}

export async function getAgnesVideo(taskId: string, model = DEFAULT_VIDEO_MODEL): Promise<AgnesVideoTask> {
  if (model === "agnes-video-2.5-flash") {
    const baseUrl = (process.env.AGNES_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/v1\/?$/, "");
    const url = `${baseUrl}/agnesapi?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(model)}`;
    return requestAgnes<AgnesVideoTask>(url, { method: "GET" }, true);
  }
  return requestAgnes<AgnesVideoTask>(`/videos/${encodeURIComponent(taskId)}`, {
    method: "GET",
  });
}

export async function resolveAgnesVideoUrl(task: AgnesVideoTask): Promise<AgnesVideoTask> {
  const hasUrl = Boolean(task.url || task.video_url || task.metadata?.url);
  if (hasUrl) {
    return task;
  }

  if (task.status !== "completed" || !task.video_id) {
    return task;
  }

  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    return task;
  }

  const model = task.model === "agnes-video-v2.0"
    ? "agnes-video-v2.0"
    : task.model?.startsWith("agnes-video")
      ? task.model
      : DEFAULT_VIDEO_MODEL;
  const baseUrl = (process.env.AGNES_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/v1\/?$/, "");
  const url = `${baseUrl}/agnesapi?video_id=${encodeURIComponent(task.video_id)}&model_name=${encodeURIComponent(model)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    const text = await response.text();
    const data = text ? safeJson(text) : null;

    if (!response.ok || !data || typeof data !== "object") {
      return task;
    }

    const resolvedUrl = (data as Record<string, unknown>).url;
    if (typeof resolvedUrl === "string" && resolvedUrl.trim()) {
      return { ...task, url: resolvedUrl.trim() };
    }
  } catch (error) {
    console.error("[agnes-video] resolve url failed", {
      id: task.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return task;
}

async function requestAgnes<T>(path: string, init: RequestInit, isFullUrl = false): Promise<T> {
  const apiKey = process.env.AGNES_API_KEY;

  if (!apiKey) {
    throw new AgnesApiError("未配置 AGNES_API_KEY", 500);
  }

  const baseUrl = process.env.AGNES_API_BASE_URL || DEFAULT_BASE_URL;
  const url = isFullUrl ? path : `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    cache: "no-store",
  });

  const text = await response.text();
  const data = text ? safeJson(text) : null;

  if (!response.ok) {
    console.error("[agnes-video] request failed", { status: response.status, url: path, data });
    throw new AgnesApiError(mapAgnesError(response.status, data), response.status, data);
  }

  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapAgnesError(status: number, data?: unknown): string {
  if (status === 429) {
    return "Agnes 视频生成限流中（每分钟仅允许创建 1 个任务），已自动等待重试仍失败，请稍等约 1 分钟后再试";
  }
  if (status === 400) {
    const code = getAgnesErrorCode(data);
    const detail = stringifyAgnesError(data).toLowerCase();
    if (code === "content_policy_violation") {
      return "Agnes 拒绝生成该提示词，请调整提示词后重试";
    }
    if (detail.includes("supports at most 1 image")) {
      return "Agnes 图生视频最多支持 1 张图片";
    }
    if (detail.includes("size must be 720p")) {
      return "Agnes Video 2.5 Flash 只支持 size 为 720P";
    }
    if (detail.includes("images length must not exceed 5")) {
      return "Agnes Video 2.5 Flash reference 模式最多支持 5 张参考图";
    }
    return "Agnes 请求参数无效";
  }
  if (status === 401) return "Agnes API Key 未授权";
  if (status === 404) return "Agnes 任务不存在";
  if (status === 503) return "Agnes 服务繁忙，请稍后重试";
  return "Agnes 服务请求失败";
}

function stringifyAgnesError(data: unknown): string {
  if (typeof data === "string") return data;

  try {
    return JSON.stringify(data) || "";
  } catch {
    return String(data);
  }
}

function getAgnesErrorCode(data: unknown) {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  return typeof record.code === "string" ? record.code : undefined;
}

export class AgnesApiError extends Error {
  constructor(message: string, public status = 500, public detail?: unknown) {
    super(message);
  }
}
