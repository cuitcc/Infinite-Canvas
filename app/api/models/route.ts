import { NextRequest, NextResponse } from "next/server";
import { deleteProvider, ensureDefaultProviders, listProviders, providerApiKey, upsertProvider } from "@/lib/model-registry";

export async function GET() {
  ensureDefaultProviders();
  const providers = listProviders().map((p) => ({
    ...p,
    keyConfigured: Boolean(providerApiKey(p)),
  }));
  return NextResponse.json({ providers });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, baseUrl, apiKeyEnv, models } = body as {
      name?: string;
      baseUrl?: string;
      apiKeyEnv?: string;
      models?: Array<{ modelId?: string; label?: string; kind?: string; capabilities?: string[] }>;
    };
    if (!name?.trim() || !baseUrl?.trim() || !apiKeyEnv?.trim()) {
      return NextResponse.json({ error: "名称、Base URL、API Key 环境变量名必填" }, { status: 400 });
    }
    const cleanModels = (models ?? [])
      .filter((m) => m.modelId?.trim())
      .map((m) => ({
        modelId: m.modelId!.trim(),
        label: (m.label?.trim() || m.modelId!.trim()),
        kind: (["text", "image", "video"].includes(m.kind ?? "") ? m.kind : "text") as "text" | "image" | "video",
        capabilities: m.capabilities ?? [],
      }));
    const provider = upsertProvider({ name: name.trim(), baseUrl: baseUrl.trim(), apiKeyEnv: apiKeyEnv.trim(), models: cleanModels });
    return NextResponse.json({ ok: true, provider: { ...provider, keyConfigured: Boolean(providerApiKey(provider)) } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  deleteProvider(id);
  return NextResponse.json({ ok: true });
}
