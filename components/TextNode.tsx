"use client";

import { useEffect, useState } from "react";
import { NodeProps, type Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useCanvasStore, type CanvasNodeData } from "@/lib/store";
import { TextEditorModal } from "./TextEditorModal";

function useTextModels() {
  const [models, setModels] = useState<Array<{ modelId: string; label: string }>>([]);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/models");
        const json = await res.json();
        const all: Array<{ modelId: string; label: string }> = [];
        for (const p of json.providers ?? []) {
          for (const m of p.models ?? []) {
            if (m.kind === "text") all.push({ modelId: m.modelId, label: m.label });
          }
        }
        setModels(all.length ? all : [{ modelId: "agnes-2.5-flash", label: "agnes-2.5-flash" }]);
      } catch { /* ignore */ }
    })();
  }, []);
  return models;
}

export function TextNodeView({ id, data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const formatText = useCanvasStore((s) => s.formatText);
  const textModels = useTextModels();
  const busy = data.textBusy === true;
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <NodeShell kind="text" nodeId={id} title="文本" selected={selected} status={busy ? "处理中…" : undefined}>
      <textarea
        value={data.prompt ?? ""}
        readOnly
        onClick={() => setEditorOpen(true)}
        title="点击放大编辑"
        placeholder="点击编辑想法或描述…"
        rows={4}
        className="nodrag w-full cursor-pointer resize-none rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700 outline-none hover:border-violet-300"
      />
      {data.textError && <p className="mt-1 text-[10px] text-rose-500">{data.textError}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <select
          value={data.textModel ?? "agnes-2.5-flash"}
          onChange={(e) => updateNodeData(id, { textModel: e.target.value })}
          className="nodrag rounded border border-slate-200 bg-white px-1.5 py-1 text-[10px] text-slate-600"
        >
          {textModels.length > 0 ? textModels.map((m) => (
            <option key={m.modelId} value={m.modelId}>{m.label}</option>
          )) : (
            <option value="agnes-2.5-flash">agnes-2.5-flash</option>
          )}
        </select>
        <button
          onClick={() => formatText(id, "expand")}
          disabled={busy}
          className={`nodrag rounded px-2 py-1 text-[10px] text-white ${busy ? "bg-slate-300" : "bg-violet-500 hover:bg-violet-600"}`}
        >
          {busy ? "…" : "扩写"}
        </button>
        <button
          onClick={() => formatText(id, "polish")}
          disabled={busy}
          className={`nodrag rounded px-2 py-1 text-[10px] text-white ${busy ? "bg-slate-300" : "bg-violet-500 hover:bg-violet-600"}`}
        >
          {busy ? "…" : "润色"}
        </button>
        <button
          onClick={() => formatText(id, "translate-en")}
          disabled={busy}
          className={`nodrag rounded px-2 py-1 text-[10px] text-white ${busy ? "bg-slate-300" : "bg-violet-500 hover:bg-violet-600"}`}
        >
          {busy ? "…" : "译英"}
        </button>
      </div>
      {editorOpen && (
        <TextEditorModal
          title="文本内容"
          value={data.prompt ?? ""}
          onChange={(v) => updateNodeData(id, { prompt: v })}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </NodeShell>
  );
}
