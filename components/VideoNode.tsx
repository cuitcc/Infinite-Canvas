"use client";

import { useState } from "react";
import { NodeProps, type Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { PromptOptimizeModal } from "./PromptOptimizeModal";
import { useCanvasStore, type CanvasNodeData } from "@/lib/store";
import { useDialogueExtract } from "./use-dialogue-extract";

const STATUS_LABEL: Record<string, string> = {
  idle: "待生成",
  queued: "排队中",
  generating: "生成中…",
  done: "完成",
  failed: "失败",
};

export function VideoNodeView({ id, data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const triggerGeneration = useCanvasStore((s) => s.triggerGeneration);
  const status = data.status ?? "idle";
  const busy = status === "queued" || status === "generating";
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const { extract, extracting, error: dialogueError, clearError } = useDialogueExtract(id);

  return (
    <NodeShell kind="video" nodeId={id} title="视频" selected={selected} status={STATUS_LABEL[status]}>
      <div className="space-y-2">
        <textarea
          value={data.prompt ?? ""}
          onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
          placeholder={data.mediaId ? "画面描述(可改后重新生成)" : "直接输入画面描述,或从文本节点连线导入"}
          rows={2}
          className="nodrag w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700 outline-none focus:border-rose-400"
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
        <div className="flex items-center gap-1.5">
          <input
            value={data.dialogue ?? ""}
            onChange={(e) => updateNodeData(id, { dialogue: e.target.value })}
            placeholder="人物台词(可选)"
            className="nodrag min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 outline-none focus:border-rose-400"
          />
          <button
            onClick={() => { clearError(); extract(); }}
            disabled={extracting}
            className="nodrag shrink-0 rounded bg-violet-100 px-2 py-0.5 text-[10px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
          >
            {extracting ? "提取中…" : "✨ 提取台词"}
          </button>
        </div>
        {dialogueError && <p className="text-[10px] text-rose-500">{dialogueError}</p>}
        {data.error && <p className="text-[10px] text-rose-500">{data.error}</p>}
        {data.mediaId ? (
          <video
            src={`/api/media/${data.mediaId}`}
            controls
            loop
            className="nodrag w-full rounded-md border border-slate-200 bg-black"
            preload="metadata"
          />
        ) : (
          <div className={`flex h-36 items-center justify-center rounded-md border border-dashed ${status === "failed" ? "border-rose-300 bg-rose-50" : "border-slate-300 bg-slate-50"} text-xs text-slate-400`}>
            {busy ? (
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-rose-400 border-t-transparent" />
                {status === "generating" ? "Agnes 视频生成中…" : "排队中…"}
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
            className={`nodrag flex-1 rounded px-2 py-1 text-[10px] font-medium text-white ${busy ? "bg-slate-300" : "bg-rose-500 hover:bg-rose-600"}`}
          >
            {busy ? "生成中…" : data.mediaId ? "重新生成" : "生成视频"}
          </button>
          <select
            value={data.size ?? "1152x768"}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              updateNodeData(id, { width: w, height: h });
            }}
            className="nodrag rounded border border-slate-200 bg-white px-1.5 py-1 text-[10px] text-slate-600"
          >
            <option value="1152x768">1152×768 (横)</option>
            <option value="768x1152">768×1152 (竖)</option>
            <option value="960x960">960×960 (方)</option>
          </select>
          {data.mediaId && (
            <a
              href={`/api/media/${data.mediaId}`}
              download
              className="nodrag rounded bg-rose-100 px-2 py-1 text-[10px] text-rose-700 hover:bg-rose-200"
            >
              下载
            </a>
          )}
        </div>
        <PromptOptimizeModal nodeId={id} kind="video" open={optimizeOpen} onClose={() => setOptimizeOpen(false)} />
      </div>
    </NodeShell>
  );
}
