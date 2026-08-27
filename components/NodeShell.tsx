"use client";

import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/lib/store";
import type { NodeKind } from "@/lib/store";

export function NodeShell({
  kind,
  nodeId,
  title,
  children,
  selected,
  status,
  toolbar,
}: {
  kind: NodeKind;
  nodeId: string;
  title: string;
  children: React.ReactNode;
  selected?: boolean;
  status?: string;
  toolbar?: React.ReactNode;
}) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const palette: Record<NodeKind, { border: string; header: string; dot: string }> = {
    text: { border: "border-violet-400", header: "bg-violet-50 text-violet-700", dot: "bg-violet-500" },
    image: { border: "border-sky-400", header: "bg-sky-50 text-sky-700", dot: "bg-sky-500" },
    video: { border: "border-rose-400", header: "bg-rose-50 text-rose-700", dot: "bg-rose-500" },
    upload: { border: "border-amber-400", header: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
    audio: { border: "border-emerald-400", header: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  };
  const p = palette[kind];

  return (
    <div className={`relative w-72 rounded-xl border-2 bg-white shadow-md transition-shadow ${selected ? `${p.border} shadow-lg` : "border-slate-200"}`}>
      {selected && (
        <button
          onClick={() => removeNode(nodeId)}
          title="删除节点"
          className="nodrag nopan absolute -top-3 -right-3 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-xs text-slate-500 shadow-sm hover:border-rose-300 hover:bg-rose-50 hover:text-rose-500"
        >
          ✕
        </button>
      )}
      <div className={`flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-xs font-semibold ${p.header}`}>
        <span className={`h-2 w-2 rounded-full ${p.dot}`} />
        {title}
        {status && <span className="ml-auto text-[10px] font-normal opacity-70">{status}</span>}
      </div>
      <div className="p-3">
        {children}
      </div>
      {toolbar}
      {/* 文本/上传是纯输出节点(只有右侧出桩);图片既入又出;视频纯输入(左侧入桩) */}
      {(kind === "text" || kind === "upload" || kind === "image") && <Handle type="source" position={Position.Right} className="!h-3 !w-3 !bg-slate-400" />}
      {(kind === "image" || kind === "video") && <Handle type="target" position={Position.Left} className="!h-3 !w-3 !bg-slate-400" />}
    </div>
  );
}
