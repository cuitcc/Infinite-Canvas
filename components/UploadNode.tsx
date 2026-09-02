"use client";

import { useRef } from "react";
import { NodeProps, type Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useCanvasStore, type CanvasNodeData } from "@/lib/store";

export function UploadNodeView({ id, data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = data.status === "generating";

  return (
    <NodeShell kind="upload" nodeId={id} title="上传图片" selected={selected} status={uploading ? "上传中…" : undefined}>
      <div className="space-y-2">
        {data.remoteUrl ? (
          <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={data.remoteUrl} alt="上传的图片" className="nodrag w-full object-contain" draggable={false} />
            <div className="flex gap-1.5 p-1.5">
              <button
                onClick={() => fileRef.current?.click()}
                className="nodrag flex-1 rounded bg-amber-100 px-2 py-1 text-[10px] text-amber-700 hover:bg-amber-200"
              >
                换一张
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            className="nodrag flex h-36 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-amber-300 bg-amber-50 text-xs text-amber-600 hover:bg-amber-100"
          >
            {uploading ? (
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
                上传中…
              </span>
            ) : (
              <>
                <span className="text-lg">⬆</span>
                <span>点击选择本地图片</span>
              </>
            )}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            updateNodeData(id, { status: "generating" });
            try {
              const fd = new FormData();
              fd.append("file", file);
              const res = await fetch("/api/upload", { method: "POST", body: fd });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || "上传失败");
              updateNodeData(id, { remoteUrl: json.url, status: "done", error: undefined });
            } catch (err) {
              updateNodeData(id, { status: "failed", error: (err as Error).message });
            }
            e.target.value = "";
          }}
        />
      </div>
    </NodeShell>
  );
}
