"use client";

import { useCallback, useEffect, useState } from "react";

interface ProviderModelT {
  id?: string;
  modelId: string;
  label: string;
  kind: "text" | "image" | "video";
  capabilities?: string[];
}

interface ProviderT {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  models: ProviderModelT[];
  keyConfigured?: boolean;
}

const PRESETS = [
  { name: "火山方舟 ARK", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKeyEnv: "ARK_API_KEY" },
  { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", apiKeyEnv: "SILICONFLOW_API_KEY" },
  { name: "阿里百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY" },
  { name: "MiniMax", baseUrl: "https://api.minimax.chat/v1", apiKeyEnv: "MINIMAX_API_KEY" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY" },
  { name: "自定义(OpenAI 兼容)", baseUrl: "", apiKeyEnv: "" },
];

export function ModelManagerModal({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<ProviderT[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "", apiKeyEnv: "", modelsText: "" });
  const [error, setError] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/models");
    const json = await res.json();
    setProviders(json.providers ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const applyPreset = (name: string) => {
    const p = PRESETS.find((x) => x.name === name);
    if (!p) return;
    setForm((f) => ({ ...f, name: p.name === "自定义(OpenAI 兼容)" ? f.name : p.name, baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv }));
  };

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      // 每行一个模型:modelId | 显示名 | text/image/video
      const models = form.modelsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [modelId, label, kind] = line.split("|").map((s) => (s ?? "").trim());
          return { modelId, label: label || modelId, kind: (["text", "image", "video"].includes(kind) ? kind : "text") as ProviderModelT["kind"] };
        });
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, models }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      setShowForm(false);
      setForm({ name: "", baseUrl: "", apiKeyEnv: "", modelsText: "" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const testModel = async (modelName: string) => {
    setTestResults((r) => ({ ...r, [modelName]: "测试中…" }));
    const res = await fetch("/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName }),
    });
    const json = await res.json();
    setTestResults((r) => ({ ...r, [modelName]: json.ok ? "✓ 可用" : `✕ ${json.error ?? json.sample ?? "失败"}` }));
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`删除厂商 ${name}?节点引用它的模型将回退默认`)) return;
    await fetch(`/api/models?id=${id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800">模型管理</h2>
          <span className="text-[10px] text-slate-400">OpenAI 兼容厂商 · API Key 从环境变量读取</span>
          <div className="ml-auto flex gap-1.5">
            <button onClick={() => setShowForm((v) => !v)} className="rounded bg-violet-500 px-2.5 py-1 text-[11px] text-white hover:bg-violet-600">
              {showForm ? "收起" : "+ 添加厂商"}
            </button>
            <button onClick={onClose} className="px-1 text-xs text-slate-400 hover:text-slate-600">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {showForm && (
            <div className="mb-4 space-y-2 rounded-xl border border-violet-200 bg-violet-50/50 p-3">
              <div className="flex gap-1.5">
                <select
                  onChange={(e) => applyPreset(e.target.value)}
                  defaultValue=""
                  className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600"
                >
                  <option value="">选择预置厂商…</option>
                  {PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="厂商名称,如 火山方舟" className="rounded border border-slate-200 bg-white px-2 py-1.5" />
                <input value={form.apiKeyEnv} onChange={(e) => setForm({ ...form, apiKeyEnv: e.target.value })} placeholder="API Key 环境变量名,如 ARK_API_KEY" className="rounded border border-slate-200 bg-white px-2 py-1.5" />
              </div>
              <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="Base URL,如 https://ark.cn-beijing.volces.com/api/v3" className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs" />
              <textarea
                value={form.modelsText}
                onChange={(e) => setForm({ ...form, modelsText: e.target.value })}
                placeholder={"每行一个模型:模型ID | 显示名 | 类型(text/image/video)\n如 doubao-seedance-1-0-pro | 豆包视频 | video\n   qwen-image-2.0-pro | 通义万相 | image\n   glm-4.7 | GLM 4.7 | text"}
                rows={4}
                className="w-full rounded border border-slate-200 bg-white p-2 font-mono text-[11px]"
              />
              {error && <p className="text-[10px] text-rose-500">{error}</p>}
              <div className="flex justify-end">
                <button onClick={submit} disabled={busy} className={`rounded px-3 py-1 text-[11px] text-white ${busy ? "bg-slate-300" : "bg-violet-500 hover:bg-violet-600"}`}>
                  {busy ? "保存中…" : "保存厂商"}
                </button>
              </div>
            </div>
          )}

          {providers.length === 0 && <p className="text-xs text-slate-400">暂无厂商</p>}
          {providers.map((p) => (
            <div key={p.id} className="mb-2 rounded-xl border border-slate-200 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700">{p.name}</span>
                <span className={`text-[10px] ${p.keyConfigured ? "text-emerald-500" : "text-rose-400"}`}>
                  {p.keyConfigured ? `✓ ${p.apiKeyEnv} 已配置` : `✕ ${p.apiKeyEnv} 未配置`}
                </span>
                <button onClick={() => remove(p.id, p.name)} className="ml-auto text-[10px] text-rose-400 hover:text-rose-500">删除</button>
              </div>
              <p className="mt-0.5 text-[10px] text-slate-400">{p.baseUrl}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.models.map((m) => (
                  <span key={m.modelId} className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-600">
                    <span className={`h-1.5 w-1.5 rounded-full ${m.kind === "video" ? "bg-rose-400" : m.kind === "image" ? "bg-sky-400" : "bg-violet-400"}`} />
                    {m.label}
                    <button onClick={() => testModel(m.modelId)} className="text-violet-500 hover:underline">测试</button>
                    {testResults[m.modelId] && <span className={testResults[m.modelId].startsWith("✓") ? "text-emerald-500" : "text-rose-400"}>{testResults[m.modelId].slice(0, 30)}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
