"use client";

import { useEffect, useState, type DragEvent } from "react";
import { useCanvasStore, type CanvasNodeData } from "@/lib/store";
import { SUPPORTED_IMAGE_RATIOS } from "@/lib/image-config";
import { AGNES_VIDEO_ASPECT_RATIOS, AGNES_VIDEO_SECONDS } from "@/lib/agnes-video";
import { PromptOptimizeModal } from "./PromptOptimizeModal";
import { useDialogueExtract } from "./use-dialogue-extract";
import type { Edge, Node } from "@xyflow/react";

const KIND_LABEL: Record<string, string> = {
  text: "文本节点",
  image: "图片节点",
  video: "视频节点",
  upload: "上传图片节点",
  audio: "音频节点",
};

interface RegistryModel { modelId: string; label: string; kind: string }

/** 从注册中心拉取指定类型模型列表 */
function useRegistryModels(kind: "text" | "image" | "video") {
  const [models, setModels] = useState<RegistryModel[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/models");
        const json = await res.json();
        if (!alive) return;
        const all: RegistryModel[] = [];
        for (const p of json.providers ?? []) {
          for (const m of p.models ?? []) {
            if (m.kind === kind) all.push({ modelId: String(m.modelId), label: `${p.name} · ${m.label}`, kind: m.kind });
          }
        }
        setModels(all);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [kind]);
  return models;
}

// Agnes Video 2.5 Flash 支持的比例与时长
const VIDEO_ASPECT_LABEL: Record<string, string> = {
  "21:9": "21:9 电影宽屏 (1680×720)",
  "16:9": "16:9 横屏 (1280×720)",
  "4:3": "4:3 标屏 (960×720)",
  "1:1": "1:1 方形 (720×720)",
  "3:4": "3:4 竖屏 (720×960)",
  "9:16": "9:16 竖屏 (720×1280)",
};
// Agnes 图片:1K/2K/3K/4K 档位 + ratio 比例(4K 最高 4096×4096)
const IMAGE_TIERS = ["1K", "2K", "3K", "4K"];

export function NodeConfigPanel({ node, onClose }: { node: Node<CanvasNodeData>; onClose: () => void }) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const triggerGeneration = useCanvasStore((s) => s.triggerGeneration);
  const edges = useCanvasStore((s) => s.edges);
  const nodes = useCanvasStore((s) => s.nodes);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const { id, data } = node;
  const videoModels = useRegistryModels("video");
  const imageModels = useRegistryModels("image");

  const upstream = edges
    .filter((e) => e.target === id)
    .map((e) => ({ edge: e, node: nodes.find((n) => n.id === e.source) }))
    .filter((x) => x.node);

  const busy = data.status === "queued" || data.status === "generating";
  const seconds = Math.round(((data.numFrames ?? 121) / (data.frameRate ?? 24)) * 10) / 10;
  const audioSrc = data.kind === "audio" ? (data.mediaId ? `/api/media/${data.mediaId}` : data.remoteUrl) : undefined;
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const { extract, extracting, error: dialogueError, clearError } = useDialogueExtract(id);
  const referenceCount = upstream.filter(({ node: n }) => n!.data.kind === "image" || n!.data.kind === "upload").length;

  return (
    <div className="border-t border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="text-xs font-semibold text-slate-700">{KIND_LABEL[data.kind] ?? "节点"}</span>
        <span className="text-[10px] text-slate-400">ID {id.slice(-6)}</span>
        {data.status && <span className="text-[10px] text-slate-400">· {data.status}</span>}
        <div className="ml-auto flex gap-1.5">
          {(data.kind === "image" || data.kind === "video") && (
            <button
              onClick={() => triggerGeneration(id)}
              disabled={busy}
              className={`rounded px-2.5 py-1 text-[11px] font-medium text-white ${busy ? "bg-slate-300" : data.kind === "image" ? "bg-sky-500 hover:bg-sky-600" : "bg-rose-500 hover:bg-rose-600"}`}
            >
              {busy ? "生成中…" : data.mediaId ? "重新生成" : data.kind === "image" ? "生成图片" : "生成视频"}
            </button>
          )}
          <button onClick={() => removeNode(id)} className="rounded border border-rose-200 bg-white px-2.5 py-1 text-[11px] text-rose-500 hover:bg-rose-50">
            删除节点
          </button>
        </div>
        <button onClick={onClose} className="px-1 text-xs text-slate-400 hover:text-slate-600">✕</button>
      </div>

      <div className="max-h-64 overflow-y-auto border-t border-slate-100 px-4 py-3">
        {data.kind === "video" && (
          <div className="grid grid-cols-2 gap-3 text-xs text-slate-600 md:grid-cols-3">
            <label className="flex flex-col gap-1">
              模型
              <select value={data.model ?? "agnes-video-2.5-flash"} onChange={(e) => {
                const next = e.target.value;
                // 切回 flash 时清晰度重置:flash 仅支持 720P,残留 960P/2K 会被 SDK 静默改写
                updateNodeData(id, next === "agnes-video-2.5-flash" ? { model: next, videoSize: "720P" } : { model: next });
              }} className="rounded border border-slate-200 bg-white px-2 py-1.5">
                {videoModels.map((m) => <option key={m.modelId} value={m.modelId}>{m.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              清晰度
              <select
                value={(data.videoSize as string | undefined) ?? "720P"}
                onChange={(e) => updateNodeData(id, { videoSize: e.target.value })}
                className="rounded border border-slate-200 bg-white px-2 py-1.5"
              >
                {(data.model && data.model !== "agnes-video-2.5-flash" ? ["720P", "960P", "2K"] : ["720P"]).map((s) => <option key={s} value={s}>{s}{s !== "720P" ? " (高清版)" : ""}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              比例
              <select
                value={(data.aspectRatio as string | undefined) ?? "16:9"}
                onChange={(e) => updateNodeData(id, { aspectRatio: e.target.value })}
                className="rounded border border-slate-200 bg-white px-2 py-1.5"
              >
                {AGNES_VIDEO_ASPECT_RATIOS.map((r) => <option key={r} value={r}>{VIDEO_ASPECT_LABEL[r] ?? r}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              时长
              <select
                value={(data.seconds as string | undefined) ?? "5"}
                onChange={(e) => updateNodeData(id, { seconds: e.target.value })}
                className="rounded border border-slate-200 bg-white px-2 py-1.5"
              >
                {AGNES_VIDEO_SECONDS.map((s) => <option key={s} value={s}>{s} 秒</option>)}
              </select>
            </label>
          </div>
        )}

        {data.kind === "video" && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600 md:grid-cols-4">
            <label className="flex flex-col gap-1">
              负向提示词(可选)
              <input
                value={data.negativePrompt ?? ""}
                onChange={(e) => updateNodeData(id, { negativePrompt: e.target.value })}
                placeholder="如:面部变形,五官扭曲"
                className="rounded border border-slate-200 bg-white px-2 py-1.5"
              />
            </label>
            <label className="flex flex-col gap-1">
              Seed(可复现)
              <input
                type="number"
                value={data.seed ?? ""}
                onChange={(e) => updateNodeData(id, { seed: e.target.value === "" ? undefined : Number(e.target.value) })}
                placeholder="留空随机"
                className="rounded border border-slate-200 bg-white px-2 py-1.5"
              />
            </label>
            <label className="flex items-end gap-2 pb-1">
              <input
                type="checkbox"
                checked={data.lockIdentity !== false}
                onChange={(e) => updateNodeData(id, { lockIdentity: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              锁定人物面貌(有参考图时自动追加一致性描述)
            </label>
          </div>
        )}

        {data.kind === "video" && (
          <div className="mt-3">
            <button
              onClick={() => setOptimizeOpen(true)}
              disabled={!(data.prompt ?? "").trim()}
              className="rounded bg-violet-100 px-2.5 py-1 text-[11px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
            >
              ✨ 优化提示词
            </button>
          </div>
        )}
        {data.kind === "video" && (
          <div className="mt-3">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              人物台词(可选,生成时注入提示词,由模型直生语音并与口型同步)
              <textarea
                value={data.dialogue ?? ""}
                onChange={(e) => updateNodeData(id, { dialogue: e.target.value })}
                rows={2}
                placeholder="如:少女：原来你也在这里"
                className="w-full resize-none rounded border border-slate-200 bg-white px-2 py-1.5 outline-none focus:border-rose-400"
              />
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={() => { clearError(); extract(); }}
                disabled={extracting}
                className="rounded bg-violet-100 px-2.5 py-1 text-[11px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
              >
                {extracting ? "提取中…" : "✨ 提取台词"}
              </button>
              {dialogueError && <span className="text-[10px] text-rose-500">{dialogueError}</span>}
            </div>
          </div>
        )}

        {data.kind === "image" && (
          <div className="grid grid-cols-2 gap-3 text-xs text-slate-600 md:grid-cols-3">
            <label className="flex flex-col gap-1">
              模型
              <select value={data.model ?? "agnes-image-2.5-flash"} onChange={(e) => updateNodeData(id, { model: e.target.value })} className="rounded border border-slate-200 bg-white px-2 py-1.5">
                {imageModels.map((m) => <option key={m.modelId} value={m.modelId}>{m.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              分辨率档位
              <select value={data.imageTier ?? "4K"} onChange={(e) => updateNodeData(id, { imageTier: e.target.value })} className="rounded border border-slate-200 bg-white px-2 py-1.5">
                {IMAGE_TIERS.map((t) => <option key={t} value={t}>{t}{t === "4K" ? " (最高清)" : t === "1K" ? " (快)" : ""}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              比例
              <select value={data.imageRatio ?? "1:1"} onChange={(e) => updateNodeData(id, { imageRatio: e.target.value })} className="rounded border border-slate-200 bg-white px-2 py-1.5">
                {SUPPORTED_IMAGE_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>
        )}

        {data.kind === "image" && (
          <div className="mt-3 grid grid-cols-1 gap-3 text-xs text-slate-600 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              负向提示词(可选)
              <input
                value={data.negativePrompt ?? ""}
                onChange={(e) => updateNodeData(id, { negativePrompt: e.target.value })}
                placeholder="如:模糊,低质量,面部变形"
                className="rounded border border-slate-200 bg-white px-2 py-1.5"
              />
            </label>
          </div>
        )}

        {data.kind === "image" && (
          <div className="mt-3">
            <button
              onClick={() => setOptimizeOpen(true)}
              disabled={!(data.prompt ?? "").trim()}
              className="rounded bg-violet-100 px-2.5 py-1 text-[11px] text-violet-600 hover:bg-violet-200 disabled:opacity-50"
            >
              ✨ 优化提示词
            </button>
          </div>
        )}

        {data.kind === "text" && (
          <div className="flex flex-col gap-2 text-xs text-slate-600">
            <label className="flex flex-col gap-1">
              文本模型
              <select
                value={data.textModel ?? "agnes-2.5-flash"}
                onChange={(e) => updateNodeData(id, { textModel: e.target.value })}
                className="rounded border border-slate-200 bg-white px-2 py-1.5"
              >
                <option value="agnes-2.5-flash">agnes-2.5-flash (快)</option>
                <option value="agnes-2.5-pro">agnes-2.5-pro (强)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              文本内容
              <textarea
                value={data.prompt ?? ""}
                onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
                rows={3}
                className="w-full resize-none rounded border border-slate-200 bg-slate-50 p-2"
              />
            </label>
          </div>
        )}

        {data.kind === "upload" && data.remoteUrl && (
          <div className="text-xs text-slate-600">
            <p>图片已上传: <a href={data.remoteUrl} target="_blank" rel="noreferrer" className="break-all text-sky-600 underline">{data.remoteUrl.slice(0, 80)}</a></p>
          </div>
        )}

        {data.kind === "audio" && (
          <div className="flex flex-col gap-3 text-xs text-slate-600">
            {data.status && <p className="text-sm text-slate-700">状态: {data.status}</p>}
            {audioSrc && (
              <div className="mt-2">
                <p className="text-[10px] font-medium text-slate-500">音频文件</p>
                <audio controls className="w-full mt-1">
                  <source src={audioSrc} type="audio/mpeg" />
                  您的浏览器不支持音频播放
                </audio>
                <a href={audioSrc} target="_blank" rel="noreferrer" className="break-all text-sky-600 underline text-[10px] mt-1 block">{audioSrc.slice(0, 100)}</a>
              </div>
            )}
          </div>
        )}

        {(data.kind === "image" || data.kind === "video") && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="text-[10px] font-medium text-slate-500">上游参考({upstream.length})</p>
            {upstream.length === 0 ? (
              <p className="mt-1 text-[10px] text-slate-400">无。从文本/图片/上传/音频节点连线到本节点。</p>
            ) : data.kind === "video" ? (
              <VideoUpstreamList nodeId={id} upstream={upstream} referenceOrder={data.referenceOrder as string[] | undefined} />
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-2">
                {upstream.map(({ edge, node }) => {
                  const upstreamNode = node!;
                  const isImage = upstreamNode.data.kind === "image" || upstreamNode.data.kind === "upload";
                  const thumbSrc = upstreamNode.data.mediaId
                    ? `/api/media/${upstreamNode.data.mediaId}`
                    : upstreamNode.data.remoteUrl;
                  return (
                    <div key={edge.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
                      {isImage && thumbSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbSrc} alt="" className="nodrag h-8 w-8 rounded object-cover" />
                      ) : (
                        <span className="flex h-8 w-8 items-center justify-center rounded bg-violet-100 text-[10px] text-violet-600">词</span>
                      )}
                      <span className="text-[10px] text-slate-500">{edge.data?.role === "first-frame" ? "首帧" : "参考"}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {(data.kind === "image" || data.kind === "video") && (
        <PromptOptimizeModal
          nodeId={id}
          kind={data.kind}
          open={optimizeOpen}
          onClose={() => setOptimizeOpen(false)}
        />
      )}
    </div>
  );
}

function VideoUpstreamList({
  nodeId,
  upstream,
  referenceOrder,
}: {
  nodeId: string;
  upstream: { edge: Edge; node: Node<CanvasNodeData> | undefined }[];
  referenceOrder?: string[];
}) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const imageUpstream = upstream.filter(({ node }) => node!.data.kind === "image" || node!.data.kind === "upload");
  const textUpstream = upstream.filter(({ node }) => node!.data.kind === "text");
  const audioUpstream = upstream.filter(({ node }) => node!.data.kind === "audio");
  const order = referenceOrder ?? [];

  const orderedImageUpstream = [...imageUpstream].sort((a, b) => {
    const ia = order.indexOf(a.node!.id);
    const ib = order.indexOf(b.node!.id);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>, targetId: string) {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    setDraggingId(null);
    if (!draggedId || draggedId === targetId) return;
    const ids = orderedImageUpstream.map(({ node }) => node!.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, draggedId);
    updateNodeData(nodeId, { referenceOrder: next });
  }

  return (
    <div className="mt-1.5">
      {orderedImageUpstream.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] text-slate-500">参考图顺序（拖拽排序）</p>
          <div className="mt-1 flex flex-col gap-1">
            {orderedImageUpstream.map(({ edge, node }, idx) => {
              const srcNode = node!;
              const thumbSrc = srcNode.data.mediaId
                ? `/api/media/${srcNode.data.mediaId}`
                : srcNode.data.remoteUrl;
              return (
                <div
                  key={srcNode.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, srcNode.id)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                  onDrop={(e) => handleDrop(e, srcNode.id)}
                  onDragEnd={() => setDraggingId(null)}
                  className={`nodrag flex cursor-move items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 ${draggingId === srcNode.id ? "opacity-50" : ""}`}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-200 text-[10px] font-semibold text-slate-600">
                    {idx + 1}
                  </span>
                  {thumbSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbSrc} alt="" className="h-8 w-8 rounded object-cover" />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded bg-slate-200 text-[10px] text-slate-500">图</span>
                  )}
                  {/* 标签与实际生成模式一致:1 张图=首帧图生视频,2 张及以上=reference 人物参考(按数量自动判断) */}
                  <span className="text-[10px] text-slate-500">{orderedImageUpstream.length >= 2 ? `参考${idx + 1}` : "首帧"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {textUpstream.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {textUpstream.map(({ edge }) => (
            <div key={edge.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
              <span className="flex h-8 w-8 items-center justify-center rounded bg-violet-100 text-[10px] text-violet-600">词</span>
              <span className="text-[10px] text-slate-500">{edge.data?.role === "first-frame" ? "首帧" : "参考"}</span>
            </div>
          ))}
        </div>
      )}
      {audioUpstream.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] text-slate-500">音频参考</p>
          <div className="flex flex-wrap gap-2">
            {audioUpstream.map(({ edge }) => (
              <div key={edge.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
                <span className="flex h-8 w-8 items-center justify-center rounded bg-emerald-100 text-[10px] text-emerald-600">音</span>
                <span className="text-[10px] text-slate-500">音频参考</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
