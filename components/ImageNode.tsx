"use client";

import { useState } from "react";
import { NodeProps, type Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { PromptOptimizeModal } from "./PromptOptimizeModal";
import { useCanvasStore, type CanvasNodeData } from "@/lib/store";

const STATUS_LABEL: Record<string, string> = {
  idle: "待生成",
  queued: "排队中",
  generating: "生成中…",
  done: "完成",
  failed: "失败",
};

export function ImageNodeView({ id, data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const triggerGeneration = useCanvasStore((s) => s.triggerGeneration);
  const status = data.status ?? "idle";
  const busy = status === "queued" || status === "generating";
  const [optimizeOpen, setOptimizeOpen] = useState(false);

  return (
    <NodeShell kind="image" nodeId={id} title="图片" selected={selected} status={STATUS_LABEL[status]}>
      <div className="space-y-2">
        <textarea
          value={data.prompt ?? ""}
          onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
          placeholder={data.mediaId ? "画面描述(可改后重新生成)" : "直接输入画面描述,或从文本节点连线导入"}
          rows={2}
          className="nodrag w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700 outline-none focus:border-sky-400"
        />
        <div className="flex justify-end">
          <button
            onClick={() => setOptimizeOpen(true)}
            disabled={!(data.prompt ?? "").trim()}
            className="nodrag rounded bg-violet-100 px-2 py-0.5 text-[10px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
          >
            ✨ 优化
          </button>
        </div>
        {data.error && <p className="text-[10px] text-rose-500">{data.error}</p>}
        {data.mediaId ? (
          <div className="relative overflow-hidden rounded-md border border-slate-200 bg-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/media/${data.mediaId}`} alt={data.label ?? "生成的图片"} className="nodrag w-full object-contain" draggable={false} />
          </div>
        ) : (
          <div className={`flex h-36 items-center justify-center rounded-md border border-dashed ${status === "failed" ? "border-rose-300 bg-rose-50" : "border-slate-300 bg-slate-50"} text-xs text-slate-400`}>
            {busy ? (
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                {status === "generating" ? "Agnes 生成中…" : "排队中…"}
              </span>
            ) : status === "failed" ? (
              <span className="px-2 text-center text-rose-500">{data.error ?? "生成失败"}</span>
            ) : (
              <span>等待输入</span>
            )}
          </div>
        )}

        <div className="flex gap-1.5">
          <button
            onClick={() => triggerGeneration(id)}
            disabled={busy}
            className={`nodrag flex-1 rounded px-2 py-1 text-[10px] font-medium text-white ${busy ? "bg-slate-300" : "bg-sky-500 hover:bg-sky-600"}`}
          >
            {busy ? "生成中…" : data.mediaId ? "重新生成" : "生成图片"}
          </button>
          {data.mediaId && (
            <a
              href={`/api/media/${data.mediaId}`}
              download
              className="nodrag rounded bg-sky-100 px-2 py-1 text-[10px] text-sky-700 hover:bg-sky-200"
            >
              下载
            </a>
          )}
        </div>
        <PromptOptimizeModal nodeId={id} kind="image" open={optimizeOpen} onClose={() => setOptimizeOpen(false)} />
      </div>
    </NodeShell>
  );
}
