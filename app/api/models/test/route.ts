import { NextRequest, NextResponse } from "next/server";
import { getProvider, providerApiKey, resolveModel } from "@/lib/model-registry";

/** 连通性测试:按模型类型发一个最小请求 */
export async function POST(req: NextRequest) {
  try {
    const { modelName } = await req.json() as { modelName?: string };
    if (!modelName) return NextResponse.json({ error: "缺少 modelName" }, { status: 400 });

    const resolved = resolveModel(modelName);
    if (!resolved) return NextResponse.json({ error: "模型不在注册中心" }, { status: 404 });
    const { provider, model } = resolved;
    const apiKey = providerApiKey(provider);
    if (!apiKey) return NextResponse.json({ ok: false, error: `环境变量 ${provider.apiKeyEnv} 未配置` }, { status: 200 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      let endpoint = "";
      let body: Record<string, unknown> = {};
      if (model.kind === "text") {
        endpoint = "/chat/completions";
        body = { model: model.modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 4, chat_template_kwargs: { enable_thinking: false } };
      } else if (model.kind === "image") {
        endpoint = "/images/generations";
        body = { model: model.modelId, prompt: "test", size: "1024x768" };
      } else {
        endpoint = "/videos";
        body = { model: model.modelId, prompt: "test", num_frames: 9, frame_rate: 24 };
      }

      const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      const text = await res.text();
      // 连通即视为成功(400 参数问题也说明 key/网络通,只有 401/403/网络错误算失败)
      const ok = res.ok || res.status === 400;
      return NextResponse.json({ ok, status: res.status, sample: text.slice(0, 200) });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message });
  }
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("providerId");
  if (!id) return NextResponse.json({ error: "缺少 providerId" }, { status: 400 });
  const provider = getProvider(id);
  if (!provider) return NextResponse.json({ error: "厂商不存在" }, { status: 404 });
  return NextResponse.json({ provider, keyConfigured: Boolean(providerApiKey(provider)) });
}
