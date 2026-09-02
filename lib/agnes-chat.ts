import { AgnesApiError } from "./agnes-video";

const DEFAULT_BASE_URL = "https://api.agnes-ai.cn/v1";

export interface AgnesChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function createAgnesChatCompletion(params: {
  messages: AgnesChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  return createAgnesChatCompletionWithRetry(params, 3);
}

async function createAgnesChatCompletionWithRetry(params: {
  messages: AgnesChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}, maxAttempts: number): Promise<string> {
  const apiKey = process.env.AGNES_API_KEY;

  if (!apiKey) {
    throw new AgnesApiError("未配置 AGNES_API_KEY", 500);
  }

  const baseUrl = process.env.AGNES_TEXT_API_BASE_URL || process.env.AGNES_API_BASE_URL || DEFAULT_BASE_URL;
  const requestBody = {
    model: params.model ?? "agnes-2.5-flash",
    messages: params.messages,
    temperature: params.temperature ?? 0.4,
    max_tokens: params.maxTokens ?? 4096,
    chat_template_kwargs: {
      enable_thinking: false,
    },
  };
  let lastError: AgnesApiError | undefined;
  const timeoutMs = parsePositiveInteger(process.env.AGNES_CHAT_TIMEOUT_MS) || 60_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        cache: "no-store",
      }, timeoutMs);
    } catch (error) {
      lastError = new AgnesApiError("Agnes 文本模型请求超时或网络失败", 504, {
        attempt,
        maxAttempts,
        cause: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      if (attempt === maxAttempts) {
        throw lastError;
      }
      await sleep(1000 * attempt);
      continue;
    }

    const text = await response.text();
    const data = text ? safeJson(text) : null;

    if (!response.ok) {
      lastError = new AgnesApiError("Agnes 文本模型请求失败", response.status, data);
      if (!shouldRetryChatStatus(response.status) || attempt === maxAttempts) {
        throw lastError;
      }
      await sleep(1000 * attempt);
      continue;
    }

    const content = extractCompletionContent(data);

    if (!content) {
      lastError = new AgnesApiError("Agnes 文本模型响应为空", 502, data);
      if (attempt === maxAttempts) {
        throw lastError;
      }
      await sleep(1000 * attempt);
      continue;
    }

    return content;
  }

  throw lastError || new AgnesApiError("Agnes 文本模型请求失败", 500);
}

function extractCompletionContent(data: unknown): string | undefined {
  const choice = (data as { choices?: Array<{ text?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } }> })?.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const joined = content.map((item) => item.text).filter(Boolean).join("\n").trim();
    if (joined) return joined;
  }

  if (typeof choice?.text === "string" && choice.text.trim()) {
    return choice.text;
  }

  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shouldRetryChatStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
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
