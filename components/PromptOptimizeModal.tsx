"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasStore } from "@/lib/store";

type OptimizeKind = "image" | "video";

const ACTION_KEY: Record<OptimizeKind, string> = {
  image: "optimize-image",
  video: "optimize-video",
};

export function PromptOptimizeModal({ nodeId, kind, open, onClose }: {
  nodeId: string;
  kind: OptimizeKind;
  open: boolean;
  onClose: () => void;
}) {
  const nodes = useCanvasStore((s) => s.nodes);
  const node = nodes.find((n) => n.id === nodeId);
  const edges = useCanvasStore((s) => s.edges);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const generationRef = useRef(0);

  const data = node?.data;
  const prompt = (data?.prompt as string | undefined) ?? "";
  const textModel = data?.textModel as string | undefined;
  const referenceCount = edges
    .filter((e) => e.target === nodeId)
    .filter((e) => {
      const src = nodes.find((n) => n.id === e.source);
      return src?.data.kind === "image" || src?.data.kind === "upload";
    }).length;

  const optimize = useCallback(async () => {
    if (!prompt.trim()) {
      setError("提示词为空，请先输入内容");
      return;
    }
    const gen = ++generationRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const context = kind === "image"
        ? { ratio: data?.imageRatio as string | undefined, tier: data?.imageTier as string | undefined, referenceCount }
        : { ratio: data?.aspectRatio as string | undefined, seconds: data?.seconds as string | undefined, referenceCount };
      const res = await fetch("/api/text/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt, action: ACTION_KEY[kind], model: textModel, context }),
      });
      const json = await res.json();
      if (gen !== generationRef.current) return;
      if (!res.ok) throw new Error(json.error || "优化失败");
      if (!json.result || !String(json.result).trim()) throw new Error("优化结果为空，请重试");
      setResult(String(json.result));
    } catch (err) {
      if (gen !== generationRef.current) return;
      setError((err as Error).message);
    } finally {
      if (gen === generationRef.current) setBusy(false);
    }
    // data 字段仅在打开瞬间读取,依赖 prompt/referenceCount 即可
  }, [prompt, kind, textModel, referenceCount, data?.imageRatio, data?.imageTier, data?.aspectRatio, data?.seconds]);

  useEffect(() => {
    if (open) {
      setResult("");
      setError(undefined);
      ++generationRef.current;
      void optimize();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const apply = () => {
    if (!result.trim()) return;
    updateNodeData(nodeId, { prompt: result });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">{kind === "image" ? "优化图片提示词" : "优化视频提示词"}</span>
          <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">✕</button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          <div>
            <p className="mb-1 text-[10px] font-medium text-slate-400">原始提示词</p>
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">{prompt || "（空）"}</p>
          </div>
          <div>
            <p className="mb-1 text-[10px] font-medium text-slate-400">优化后提示词</p>
            {busy ? (
              <div className="flex h-20 items-center justify-center gap-2 rounded border border-slate-200 bg-slate-50 text-xs text-slate-400">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                优化中…
              </div>
            ) : error ? (
              <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-500">
                {error}
                <button onClick={() => void optimize()} className="ml-2 rounded bg-rose-100 px-2 py-0.5 text-[10px] text-rose-600 hover:bg-rose-200">重试</button>
              </div>
            ) : (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-violet-200 bg-violet-50 p-2 text-xs text-slate-700">{result}</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">取消</button>
          <button
            onClick={() => void optimize()}
            disabled={busy}
            className="rounded border border-violet-200 bg-white px-3 py-1 text-xs text-violet-600 hover:bg-violet-50 disabled:opacity-50"
          >
            重新优化
          </button>
          <button
            onClick={apply}
            disabled={busy || !!error || !result.trim()}
            className="rounded bg-violet-500 px-3 py-1 text-xs font-medium text-white hover:bg-violet-600 disabled:bg-slate-300"
          >
            应用
          </button>
        </div>
      </div>
    </div>
  );
}
