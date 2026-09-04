"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useCanvasStore } from "@/lib/store";
import { EDGE_TTS_VOICES, DEFAULT_EDGE_VOICE } from "@/lib/edge-tts-voices";
import { TextEditorModal } from "./TextEditorModal";

export function AudioNodeView({ id, data, selected }: NodeProps) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [customVoice, setCustomVoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const voice = (data.voice as string) || DEFAULT_EDGE_VOICE;
  const isCustom = !EDGE_TTS_VOICES.some((v) => v.id === voice);
  const text = (data.prompt as string) || "";
  const mediaId = data.mediaId as string | undefined;
  const status = data.status as string | undefined;

  const generate = async () => {
    if (!text.trim()) return;
    updateNodeData(id, { status: "generating", error: undefined });
    setBusy(true);
    try {
      const res = await fetch("/api/generate/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: useCanvasStore.getState().projectId, nodeId: id, text, voice }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "生成失败");
      updateNodeData(id, { status: "done", mediaId: json.mediaId, remoteUrl: json.url });
    } catch (error) {
      updateNodeData(id, { status: "failed", error: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <NodeShell kind="audio" nodeId={id} title="音频" selected={selected} status={status === "generating" ? "生成中…" : undefined}>
      <div className="flex flex-col gap-2">
        <textarea
          value={text}
          readOnly
          onClick={() => setEditorOpen(true)}
          title="点击放大编辑"
          placeholder="点击编辑要合成语音的文本"
          rows={3}
          className="nodrag w-full cursor-pointer resize-none rounded border border-slate-200 bg-slate-50 p-2 text-xs hover:border-emerald-300"
        />
        <select
          value={isCustom ? "__custom__" : voice}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "__custom__") {
              updateNodeData(id, { voice: customVoice || DEFAULT_EDGE_VOICE });
            } else {
              updateNodeData(id, { voice: value });
            }
          }}
          className="nodrag rounded border border-slate-200 bg-white px-2 py-1 text-xs"
        >
          {EDGE_TTS_VOICES.map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
          <option value="__custom__">自定义音色</option>
        </select>
        {isCustom && (
          <input
            value={customVoice || voice}
            onChange={(e) => {
              setCustomVoice(e.target.value);
              updateNodeData(id, { voice: e.target.value });
            }}
            placeholder="输入 Edge voice name"
            className="nodrag rounded border border-slate-200 bg-white px-2 py-1 text-xs"
          />
        )}
        <button
          onClick={generate}
          disabled={busy || !text.trim()}
          className={`nodrag rounded px-2.5 py-1 text-[11px] font-medium text-white ${busy || !text.trim() ? "bg-slate-300" : "bg-emerald-500 hover:bg-emerald-600"}`}
        >
          {busy ? "合成中…" : mediaId ? "重新生成" : "生成语音"}
        </button>
        {status === "failed" && (data as { error?: string }).error && <p className="text-[10px] text-rose-500">{(data as { error?: string }).error}</p>}
        {mediaId && (
          <audio src={`/api/media/${mediaId}`} controls className="w-full" />
        )}
      </div>
      {editorOpen && (
        <TextEditorModal
          title="语音文本"
          value={text}
          onChange={(v) => updateNodeData(id, { prompt: v })}
          onClose={() => setEditorOpen(false)}
        />
      )}
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !bg-emerald-500" />
    </NodeShell>
  );
}
