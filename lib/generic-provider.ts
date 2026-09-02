import { providerApiKey, resolveModel, type ModelProvider, type ProviderModel } from "./model-registry";
import { saveRemoteMedia } from "./db";

/** OpenAI 兼容厂商的通用调用层:图片同步、视频异步任务、文本同步 */

export interface GenericGenParams {
  modelName: string;
  prompt: string;
  size?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  image?: string;
  referenceUrls?: string[];
  negativePrompt?: string;
  seed?: number;
}

async function authHeaders(provider: ModelProvider): Promise<HeadersInit> {
  const key = providerApiKey(provider);
  if (!key) throw new Error(`环境变量 ${provider.apiKeyEnv} 未配置,无法调用 ${provider.name}`);
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function postJson(provider: ModelProvider, path: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: await authHeaders(provider),
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const record = data as Record<string, unknown>;
      const errMsg = typeof record.error === "object" && record.error && "message" in (record.error as object)
        ? String((record.error as { message?: unknown }).message)
        : typeof record.error === "string" ? record.error : record.message ? String(record.message) : `${provider.name} 请求失败 (HTTP ${res.status})`;
      throw new Error(errMsg);
    }
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/** 从任意响应结构里挖出媒体 URL */
function extractUrl(data: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    data.url, data.video_url, data.image_url,
    Array.isArray(data.data) && data.data[0] ? (data.data[0] as Record<string, unknown>).url : undefined,
    Array.isArray(data.images) ? (data.images[0] as Record<string, unknown>)?.url ?? (typeof data.images[0] === "string" ? data.images[0] : undefined) : undefined,
    Array.isArray(data.videos) ? (data.videos[0] as Record<string, unknown>)?.url ?? (typeof data.videos[0] === "string" ? data.videos[0] : undefined) : undefined,
    Array.isArray(data.output) && typeof data.output[0] === "string" ? data.output[0] : undefined,
    data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>).video_url ?? (data.output as Record<string, unknown>).url : undefined,
    typeof data.output === "string" ? data.output : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
  }
  return undefined;
}

/** 通用图片生成(OpenAI 兼容 images/generations) */
export async function genericImageGenerate(params: GenericGenParams): Promise<{ mediaId: string; url: string }> {
  const resolved = resolveModel(params.modelName);
  if (!resolved) throw new Error(`模型 ${params.modelName} 未注册`);
  const { provider, model } = resolved;

  const refs = params.referenceUrls ?? [];
  const body: Record<string, unknown> = {
    model: model.modelId,
    prompt: params.prompt,
    size: params.size ?? "1024x768",
  };
  if (refs.length > 0) body.image = refs;
  if (params.seed !== undefined) body.seed = params.seed;

  const data = await postJson(provider, "/images/generations", body, 180_000);
  const url = extractUrl(data);
  if (!url) throw new Error(`${provider.name} 未返回图片 URL`);
  const media = await saveRemoteMedia("image", url);
  return { mediaId: media.id, url };
}

/** 通用文本生成(OpenAI 兼容 chat/completions) */
export async function genericTextGenerate(params: { modelName: string; system: string; user: string }): Promise<string> {
  const resolved = resolveModel(params.modelName);
  if (!resolved) throw new Error(`模型 ${params.modelName} 未注册`);
  const { provider, model } = resolved;

  const data = await postJson(provider, "/chat/completions", {
    model: model.modelId,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
    max_tokens: 4096,
  }, 120_000);

  const choice = Array.isArray(data.choices) ? (data.choices[0] as Record<string, unknown>) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content.map((c) => (c as { text?: string }).text).filter(Boolean).join("\n");
    if (joined) return joined;
  }
  throw new Error(`${provider.name} 文本模型响应为空`);
}

export interface GenericVideoTask {
  providerTaskId: string;
  providerId: string;
  modelName: string;
}

/** 通用视频生成:提交任务,返回厂商任务号(轮询方式因厂商而异,统一在 poll 层适配) */
export async function genericVideoCreate(params: GenericGenParams): Promise<GenericVideoTask> {
  const resolved = resolveModel(params.modelName);
  if (!resolved) throw new Error(`模型 ${params.modelName} 未注册`);
  const { provider, model } = resolved;

  const refs = params.referenceUrls ?? [];
  const body: Record<string, unknown> = {
    model: model.modelId,
    prompt: params.prompt,
  };
  if (params.width && params.height) {
    body.width = params.width;
    body.height = params.height;
  }
  if (params.numFrames) body.num_frames = params.numFrames;
  if (params.frameRate) body.frame_rate = params.frameRate;
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  if (params.seed !== undefined) body.seed = params.seed;
  if (refs.length === 1) body.image = refs[0];
  if (refs.length >= 2) body.extra_body = { image: refs, mode: "keyframes" };

  const data = await postJson(provider, "/videos", body, 120_000);

  const taskId = (data.id ?? data.task_id ?? data.request_id ?? (data as Record<string, unknown>).taskId) as string | undefined;
  if (!taskId) {
    // 有些厂商同步直接返回 URL
    const url = extractUrl(data);
    if (url) {
      return { providerTaskId: `sync:${url}`, providerId: provider.id, modelName: model.modelId };
    }
    throw new Error(`${provider.name} 未返回任务 ID`);
  }
  return { providerTaskId: taskId, providerId: provider.id, modelName: model.modelId };
}

/** 查询通用视频任务;sync: 前缀 = 提交时已拿到 URL */
export async function genericVideoPoll(task: { providerId: string; providerTaskId: string; modelName: string }): Promise<
  { status: "pending" } | { status: "completed"; url: string } | { status: "failed"; error: string }
> {
  if (task.providerTaskId.startsWith("sync:")) {
    return { status: "completed", url: task.providerTaskId.slice(5) };
  }
  const provider = (await import("./model-registry")).getProvider(task.providerId);
  if (!provider) return { status: "failed", error: "厂商不存在" };
  const apiKey = providerApiKey(provider);
  if (!apiKey) return { status: "failed", error: `环境变量 ${provider.apiKeyEnv} 未配置` };

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/videos/${encodeURIComponent(task.providerTaskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) return { status: "failed", error: `HTTP ${res.status}: ${text.slice(0, 200)}` };

  const status = String(data.status ?? "").toLowerCase();
  const url = extractUrl(data);
  const errorField = data.error;
  if (status === "completed" || status === "succeeded" || status === "success" || (url && status !== "failed")) {
    if (url) return { status: "completed", url };
  }
  if (status === "failed" || status === "error" || status === "cancelled") {
    return { status: "failed", error: typeof errorField === "string" ? errorField : "厂商返回失败" };
  }
  return { status: "pending" };
}

export type { ProviderModel };
