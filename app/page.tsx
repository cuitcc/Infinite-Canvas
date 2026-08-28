"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasStore, normalizeKind, type CanvasNodeData } from "@/lib/store";
import { DEFAULT_EDGE_VOICE } from "@/lib/edge-tts-voices";
import { ImageNodeView } from "@/components/ImageNode";
import { VideoNodeView } from "@/components/VideoNode";
import { UploadNodeView } from "@/components/UploadNode";
import { AudioNodeView } from "@/components/AudioNode";
import { TimelinePanel } from "@/components/TimelinePanel";
import { NodeConfigPanel } from "@/components/NodeConfigPanel";
import { ModelManagerModal } from "@/components/ModelManagerModal";

import { TextNodeView } from "@/components/TextNode";

const nodeTypes = {
  text: TextNodeView,
  image: ImageNodeView,
  video: VideoNodeView,
  upload: UploadNodeView,
  audio: AudioNodeView,
};

let uidCounter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export default function Home() {
  return (
    <ReactFlowProvider>
      <CanvasPage />
    </ReactFlowProvider>
  );
}

function CanvasPage() {
  const projectId = useCanvasStore((s) => s.projectId);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const dirty = useCanvasStore((s) => s.dirty);
  const setProject = useCanvasStore((s) => s.setProject);
  const setGraph = useCanvasStore((s) => s.setGraph);
  const addNode = useCanvasStore((s) => s.addNode);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const markSaved = useCanvasStore((s) => s.markSaved);
  const deselectAll = useCanvasStore((s) => s.deselectAll);
  const { screenToFlowPosition } = useReactFlow();

  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [showModelManager, setShowModelManager] = useState(false);

  const selectedNode = nodes.find((n) => n.selected) ?? null;

  // 拉取生成任务状态:后端轮询 Agnes,前端每 2s 拉一次本地任务表
  useEffect(() => {
    if (!loaded || !projectId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks?projectId=${projectId}`);
        if (!res.ok) return;
        const json = await res.json();
        const store = useCanvasStore.getState();
        let changed = false;
        for (const t of json.recent ?? []) {
          const node = store.nodes.find((n) => n.id === t.node_id);
          if (!node) continue;
          const isDone = t.status === "completed" && t.media_id;
          const isFailed = t.status === "failed";
          if (node.data.status === "generating" || node.data.status === "queued") {
            if (isDone || isFailed) {
              store.updateNodeData(t.node_id, isDone ? { status: "done", mediaId: t.media_id, error: undefined } : { status: "failed", error: t.error ?? "生成失败" });
              changed = true;
            }
          }
        }
        void changed;
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [loaded, projectId]);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/projects");
      const project = await res.json();
      setProject(project.id);
      const graphRes = await fetch(`/api/projects/${project.id}/graph`);
      if (graphRes.ok) {
        const graph = await graphRes.json();
        setGraph(
          graph.nodes.map((n: { id: string; position: { x: number; y: number }; data: { kind: string } & CanvasNodeData }) => ({ ...n, type: normalizeKind(n.data.kind), data: { ...n.data, kind: normalizeKind(n.data.kind) } })),
          graph.edges,
        );
      }
      setLoaded(true);
    })();
  }, [setGraph, setProject]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded || !projectId || !dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      try {
        // 先取出本次提交的节点/边 id,服务端删除不在本次列表中的孤儿记录
        const payloadNodes = nodes.map(({ id, position, data }) => ({ id, position, data }));
        const payloadEdges = edges.map(({ id, source, target, data }) => ({ id, source, target, data }));
        const res = await fetch(`/api/projects/${projectId}/graph`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodes: payloadNodes, edges: payloadEdges, deletedNodeIds: [], deletedEdgeIds: [] }),
        });
        if (!res.ok) throw new Error(await res.text());
        markSaved();
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [nodes, edges, dirty, loaded, projectId, markSaved]);

  const spawnNode = useCallback((kind: CanvasNodeData["kind"], position: { x: number; y: number }) => {
    const defaults: Partial<CanvasNodeData> = {};
    if (kind === "image") defaults.size = "1024x768";
    if (kind === "video") {
      defaults.width = 1152;
      defaults.height = 768;
      defaults.numFrames = 121;
      defaults.frameRate = 24;
    }
    if (kind === "audio") defaults.voice = DEFAULT_EDGE_VOICE;
    addNode({
      id: uid(kind),
      type: kind,
      position,
      data: { kind, status: "idle", ...defaults },
    });
  }, [addNode]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/canvas-node") as CanvasNodeData["kind"];
    if (!kind) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    spawnNode(kind, position);
  }, [screenToFlowPosition, spawnNode]);

  const handleAddNode = useCallback((kind: CanvasNodeData["kind"]) => {
    spawnNode(kind, { x: 120 + Math.random() * 240, y: 100 + Math.random() * 160 });
  }, [spawnNode]);

  const [exportState, setExportState] = useState<{ status: string; progress?: string; output?: string; error?: string } | null>(null);
  const startExport = useCallback(async () => {
    if (!projectId) return;
    setExportState({ status: "running" });
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "导出失败");
      const jobId = json.jobId;
      const poll = setInterval(async () => {
        const st = await fetch(`/api/export?jobId=${jobId}`);
        const sj = await st.json();
        setExportState(sj);
        if (sj.status !== "running") clearInterval(poll);
      }, 1500);
    } catch (error) {
      setExportState({ status: "failed", error: (error as Error).message });
    }
  }, [projectId]);

  if (!loaded) {
    return (
      <main className="flex h-screen items-center justify-center bg-slate-100 text-sm text-slate-400">
        加载画布中…
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-slate-100">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="text-sm font-semibold text-slate-800">Infinite Canvas</h1>
        <span className={`text-[10px] ${saveState === "error" ? "text-rose-500" : "text-slate-400"}`}>
          {saveState === "saving" ? "保存中…" : saveState === "error" ? "保存失败" : "已保存"}
        </span>
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => setShowModelManager(true)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
            ⚙ 模型管理
          </button>
          <button onClick={() => handleAddNode("text")} className="rounded-md bg-violet-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-violet-600">
            + 文本
          </button>
          <button onClick={() => handleAddNode("image")} className="rounded-md bg-sky-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-sky-600">
            + 图片节点
          </button>
          <button onClick={() => handleAddNode("video")} className="rounded-md bg-rose-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-rose-600">
            + 视频节点
          </button>
          <button onClick={() => handleAddNode("upload")} className="rounded-md bg-amber-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-amber-600">
            + 上传
          </button>
          <button onClick={() => handleAddNode("audio")} className="rounded-md bg-emerald-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-600">
            + 音频
          </button>
        </div>
      </header>

      <div className="relative flex-1" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          proOptions={{ hideAttribution: true }}
          className="bg-slate-50"
        >
          <Background gap={20} size={1.5} color="#cbd5e1" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-white" />
        </ReactFlow>

        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-2xl border border-slate-200 bg-white/90 px-8 py-6 text-center shadow-sm">
              <p className="text-sm font-medium text-slate-700">从空白画布开始</p>
              <p className="mt-1 text-xs text-slate-400">点击上方按钮添加节点,连线组织你的创作流</p>
            </div>
          </div>
        )}
      </div>

      <TimelinePanel onExport={() => void startExport()} />

      {selectedNode && (
        <NodeConfigPanel node={selectedNode} onClose={() => deselectAll()} />
      )}

      {showModelManager && (
        <ModelManagerModal onClose={() => setShowModelManager(false)} />
      )}

      {exportState && (
        <div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
          <div className=" flex items-center gap-2">
            {exportState.status === "running" ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
            ) : exportState.status === "done" ? (
              <span className="text-emerald-500">✓</span>
            ) : (
              <span className="text-rose-500">✕</span>
            )}
            <span className="text-xs font-medium text-slate-700">
              {exportState.status === "running" ? "导出中" : exportState.status === "done" ? "导出完成" : "导出失败"}
            </span>
            <button onClick={() => setExportState(null)} className="ml-auto text-xs text-slate-400 hover:text-slate-600">✕</button>
          </div>
          {exportState.status === "running" && <p className="mt-1 text-[10px] text-slate-400">{exportState.progress}</p>}
          {exportState.status === "failed" && <p className="mt-1 text-[10px] text-rose-400">{exportState.error}</p>}
          {exportState.status === "done" && exportState.output && (
            <a href={`/api/exports/${exportState.output.split("/").pop()}`} download className="mt-2 block">
              <video src={`/api/exports/${exportState.output.split("/").pop()}`} controls className="w-full rounded border border-slate-200" />
            </a>
          )}
        </div>
      )}
    </main>
  );
}
