"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useCanvasStore, type TimelineClipState } from "@/lib/store";

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function TimelinePanel({ onExport }: { onExport?: () => void }) {
  const nodes = useCanvasStore((s) => s.nodes);
  const timeline = useCanvasStore((s) => s.timeline);
  const setTimeline = useCanvasStore((s) => s.setTimeline);
  const projectId = useCanvasStore((s) => s.projectId);

  const [collapsed, setCollapsed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([]);

  const doneVideos = useMemo(
    () => nodes.filter((n) => n.data.kind === "video" && n.data.status === "done" && n.data.mediaId),
    [nodes],
  );

  const doneAudios = useMemo(
    () => nodes.filter((n) => n.data.kind === "audio" && n.data.status === "done" && n.data.mediaId),
    [nodes],
  );

  // 持久化(防抖)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!projectId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void fetch(`/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips: timeline }),
      });
    }, 600);
  }, [timeline, projectId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const clips = timeline;

  const addToTimeline = (nodeId: string, mediaId: string) => {
    const next: TimelineClipState[] = [...clips, { id: `clip-${nodeId}-${clips.length}`, nodeId, mediaId, order: clips.length, trimIn: 0, trimOut: null }];
    setTimeline(next);
  };

  const moveClip = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= clips.length) return;
    const next = [...clips];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setTimeline(next.map((c, i) => ({ ...c, order: i })));
  };

  const removeClip = (id: string) => {
    setTimeline(clips.filter((c) => c.id !== id).map((c, i) => ({ ...c, order: i })));
  };

  const setTrim = (id: string, field: "trimIn" | "trimOut", value: number | null) => {
    setTimeline(clips.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const setClipAudio = (id: string, audioMediaId: string | undefined) => {
    setTimeline(clips.map((c) => (c.id === id ? { ...c, audioMediaId } : c)));
  };

  return (
    <div className="border-t border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
        >
          {collapsed ? "▸" : "▾"} 时间线
        </button>
        <span className="text-[10px] text-slate-400">{clips.length} 个片段</span>
        {onExport && (
          <button onClick={onExport} className="ml-auto rounded-md bg-emerald-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-600">
            导出成片
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="max-h-56 overflow-y-auto px-4 pb-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {doneVideos.length === 0 && <span className="text-[10px] text-slate-400">还没有完成的视频节点,先生成视频再加入时间线</span>}
            {doneVideos.map((n) => (
              <button
                key={n.id}
                onClick={() => addToTimeline(n.id, n.data.mediaId!)}
                className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] text-rose-600 hover:bg-rose-100"
              >
                + {n.data.label ?? "视频片段"}
              </button>
            ))}
          </div>

          {doneAudios.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-slate-400">可用音频:</span>
              {doneAudios.map((n) => (
                <span
                  key={n.id}
                  className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[10px] text-sky-600"
                >
                  ♪ {n.data.label ?? "音频"}
                </span>
              ))}
            </div>
          )}

          {clips.length > 0 && (
            <div className="space-y-1">
              {clips.map((clip, i) => {
                const node = nodes.find((n) => n.id === clip.nodeId);
                return (
                  <div key={clip.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
                    <span className="text-[10px] text-slate-400">#{i + 1}</span>
                    <video
                      ref={(el) => { videoRefs.current[i] = el; }}
                      src={`/api/media/${clip.mediaId}`}
                      preload="metadata"
                      muted
                      className="nodrag h-10 w-16 rounded border border-slate-200 bg-black object-cover"
                    />
                    <div className="flex-1 text-[10px] text-slate-500">{node?.data.prompt?.slice(0, 20) ?? "片段"}</div>
                    <select
                      value={clip.audioMediaId ?? ""}
                      onChange={(e) => setClipAudio(clip.id, e.target.value || undefined)}
                      className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] text-slate-600"
                    >
                      <option value="">-- 无音频 --</option>
                      {doneAudios.map((n) => (
                        <option key={n.id} value={n.data.mediaId!}>
                          ♪ {n.data.label ?? "音频"}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-[10px] text-slate-500">
                      入 <input type="number" step="0.1" min={0} value={clip.trimIn} onChange={(e) => setTrim(clip.id, "trimIn", Number(e.target.value))} className="w-14 rounded border border-slate-200 px-1 py-0.5" />
                    </label>
                    <label className="flex items-center gap-1 text-[10px] text-slate-500">
                      出 <input type="number" step="0.1" min={0} value={clip.trimOut ?? ""} placeholder="尾部" onChange={(e) => setTrim(clip.id, "trimOut", e.target.value === "" ? null : Number(e.target.value))} className="w-14 rounded border border-slate-200 px-1 py-0.5" />
                    </label>
                    <div className="flex gap-0.5">
                      <button onClick={() => moveClip(i, -1)} className="rounded bg-white px-1 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100">←</button>
                      <button onClick={() => moveClip(i, 1)} className="rounded bg-white px-1 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100">→</button>
                      <button onClick={() => removeClip(clip.id)} className="rounded bg-white px-1 py-0.5 text-[10px] text-rose-500 hover:bg-rose-50">✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
