"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasStore, normalizeKind, type CanvasNodeData } from "@/lib/store";
import { abortAgent } from "@/lib/agent-orchestrator";

interface PipelineMeta {
  id: string;
  name: string;
  node_count: number;
  video_count: number;
  cover_media_id: string | null;
  created_at: number;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

interface Props {
  onClose: () => void;
}

export function PipelineLibraryModal({ onClose }: Props) {
  const projectId = useCanvasStore((s) => s.projectId);
  const setGraph = useCanvasStore((s) => s.setGraph);
  const setTimeline = useCanvasStore((s) => s.setTimeline);

  const [items, setItems] = useState<PipelineMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/pipelines");
      const json = await res.json();
      setItems(json.pipelines ?? []);
    } catch {
      setMessage("列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 3000);
  };

  // 保存当前画布 → 快照入库（节点+连线+时间线,媒体文件不打包）
  const handleSaveCurrent = async () => {
    if (!projectId) return;
    const def = `流水线-${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`;
    const name = window.prompt("给这份流水线起个名字：", def);
    if (name === null) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: name.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      flash(`已保存「${json.name}」`);
      await refresh();
    } catch (error) {
      flash((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 载入快照 → 整体替换当前画布与时间线
  const handleRestore = async (item: PipelineMeta) => {
    if (!projectId) return;
    if (!window.confirm(`载入「${item.name}」将替换当前画布和时间线（未保存的当前内容会丢失），确定？`)) return;
    setBusy(true);
    try {
      // 进行中的 Agent 流程先中止,避免它继续往替换后的画布上写节点
      const st = useCanvasStore.getState();
      if (st.agentState && !["idle", "aborted", "done"].includes(st.agentState.stage)) abortAgent();
      const res = await fetch(`/api/pipelines/${item.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "载入失败");
      // 服务端已替换,重新拉取画布与时间线刷新本地状态
      const graphRes = await fetch(`/api/projects/${projectId}/graph`);
      const graph = await graphRes.json();
      setGraph(
        graph.nodes.map((n: { id: string; position: { x: number; y: number }; data: { kind: string } & CanvasNodeData }) => ({ ...n, type: normalizeKind(n.data.kind), data: { ...n.data, kind: normalizeKind(n.data.kind) } })),
        graph.edges,
      );
      const tlRes = await fetch(`/api/projects/${projectId}/timeline`);
      const tl = await tlRes.json();
      setTimeline(tl.clips ?? []);
      flash(`已载入「${item.name}」`);
      onClose();
    } catch (error) {
      flash((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 下载快照 JSON 文件
  const handleDownload = async (item: PipelineMeta) => {
    try {
      const res = await fetch(`/api/pipelines/${item.id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "获取失败");
      const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `流水线-${item.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      flash((error as Error).message);
    }
  };

  // 从 JSON 文件导入入库
  const handleImportFile = async (file: File) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error("不是有效的流水线 JSON（缺少 nodes/edges）");
      const name = window.prompt("导入的流水线名称：", file.name.replace(/\.json$/i, ""));
      if (name === null) return;
      const res = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: name.trim(), data }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "导入失败");
      flash(`已导入「${json.name}」`);
      await refresh();
    } catch (error) {
      flash((error as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleDelete = async (item: PipelineMeta) => {
    if (!window.confirm(`删除「${item.name}」？此操作不可恢复。`)) return;
    try {
      const res = await fetch(`/api/pipelines/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
      setItems((prev) => prev.filter((p) => p.id !== item.id));
    } catch (error) {
      flash((error as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6" onClick={onClose}>
      <div className="flex h-full max-h-[720px] w-full max-w-4xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* 顶部标题栏 */}
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
          <span className="text-sm font-semibold text-slate-800">📚 视频画布流水线库</span>
          <span className="text-[10px] text-slate-400">保存/载入整条画布流水线（含提示词与时间线,不含媒体文件）</span>
          <button onClick={onClose} className="ml-auto px-1 text-xs text-slate-400 hover:text-slate-600">✕</button>
        </div>

        {/* 操作栏 */}
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-2.5">
          <button
            onClick={handleSaveCurrent}
            disabled={busy}
            className="rounded-md bg-violet-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-600 disabled:bg-slate-300"
          >
            💾 保存当前画布
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            ⬆ 导入 JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportFile(f);
            }}
          />
          {message && <span className="ml-2 text-xs text-sky-600">{message}</span>}
        </div>

        {/* 卡片列表 */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="py-10 text-center text-xs text-slate-400">加载中…</p>
          ) : items.length === 0 ? (
            <div className="py-14 text-center">
              <p className="text-sm font-medium text-slate-500">流水线库还是空的</p>
              <p className="mt-1 text-xs text-slate-400">点「保存当前画布」把做好的流水线存进来,以后一键载入复用</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {items.map((item) => (
                <div key={item.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-md">
                  <div className="aspect-video w-full bg-slate-100">
                    {item.cover_media_id ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/media/${item.cover_media_id}`}
                        alt={item.name}
                        className="h-full w-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-2xl text-slate-300">🎬</div>
                    )}
                  </div>
                  <div className="space-y-1 px-3 py-2">
                    <p className="truncate text-xs font-medium text-slate-700" title={item.name}>{item.name}</p>
                    <p className="text-[10px] text-slate-400">{formatDate(item.created_at)} · {item.node_count} 节点 · {item.video_count} 视频</p>
                    <div className="flex gap-1 pt-1">
                      <button
                        onClick={() => void handleRestore(item)}
                        disabled={busy}
                        className="flex-1 rounded bg-violet-500 px-2 py-1 text-[10px] font-medium text-white hover:bg-violet-600 disabled:bg-slate-300"
                      >
                        载入
                      </button>
                      <button
                        onClick={() => void handleDownload(item)}
                        className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-50"
                      >
                        下载
                      </button>
                      <button
                        onClick={() => void handleDelete(item)}
                        className="rounded border border-rose-200 bg-white px-2 py-1 text-[10px] text-rose-500 hover:bg-rose-50"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
