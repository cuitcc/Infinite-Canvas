"use client";

import { create } from "zustand";
import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange } from "@xyflow/react";
import { buildDialogueInjection, stripEmbeddedDialogue } from "./dialogue";

export type NodeKind = "text" | "image" | "video" | "upload" | "audio";

/** 旧数据里 kind=prompt,读取时归一化为 text */
export function normalizeKind(kind: string): NodeKind {
  return kind === "prompt" ? "text" : (kind as NodeKind);
}

export interface CanvasNodeData extends Record<string, unknown> {
  kind: NodeKind;
  label?: string;
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  quality?: string;
  textModel?: string;
  textBusy?: boolean;
  textError?: string;
  formatAction?: string;
  lockIdentity?: boolean;
  seed?: number;
  imageTier?: string;
  imageRatio?: string;
  size?: string;
  /** 视频节点：分辨率档位 720P/960P/2K(仅 agnes-video-2.5 基础版支持非 720P) */
  videoSize?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  status?: "idle" | "queued" | "generating" | "done" | "failed";
  error?: string;
  mediaId?: string;
  remoteUrl?: string;
  sourceNodeIds?: string[];
  voice?: string;
  /** 视频节点：人物台词，生成时注入提示词由模型直生语音并与口型同步 */
  dialogue?: string;
  /** 视频节点：上游参考图 source node id 顺序 */
  referenceOrder?: string[];
  /** 视频节点：参考图节点 id → 角色名映射（短剧 Agent 设置），台词按名字精确绑定参考图 */
  refNames?: Record<string, string>;
  updatedAt?: number;
}

// ==================== Agent 编排器相关类型 ====================

export type AgentStage = "idle" | "outline" | "style" | "assets" | "storyboard" | "shots" | "assembly" | "done" | "aborted";

export interface AgentAsset {
  id: string;
  kind: "character" | "scene" | "prop";
  name: string;
  prompt: string;
  nodeId: string | null;
  status: "pending" | "running" | "done" | "failed";
}

export interface AgentShot {
  index: number;
  description: string;
  dialogue: string[];
  characters: string[];
  scene: string;
  nodeId: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
}

export interface AgentState {
  stage: AgentStage;
  theme: string;
  shotCount: number;
  /** 每个分镜视频的目标时长(秒),对应 Agnes 支持的 4-12 秒档位 */
  shotSeconds: string;
  aspectRatio: string;
  styleName: string;
  stylePrompt: string;
  outlineNodeId: string | null;
  /** outline 阶段拿到的结构化大纲 JSON，供后续阶段复用，避免重复 LLM 调用 */
  outlineJson?: {
    title: string;
    genre: string;
    synopsis: string;
    characters: { name: string; appearance: string }[];
    scenes: { name: string; description: string }[];
    script: string;
  } | null;
  assets: AgentAsset[];
  shots: AgentShot[];
  error: string | null;
  /** 记录中止发生在哪个阶段，供面板进度展示使用；未中止或从中止态重启时为 undefined */
  abortedFrom?: AgentStage;
}

/** agentState 的初始值：setAgentState 在 agentState 为 null 时以此为基础创建 */
export const EMPTY_AGENT_STATE: AgentState = {
  stage: "idle",
  theme: "",
  shotCount: 8,
  shotSeconds: "10",
  aspectRatio: "9:16",
  styleName: "",
  stylePrompt: "",
  outlineNodeId: null,
  outlineJson: null,
  assets: [],
  shots: [],
  error: null,
};

export interface TimelineClipState {
  id: string;
  nodeId: string;
  mediaId: string;
  order: number;
  trimIn: number;
  trimOut: number | null;
  audioMediaId?: string;
}

interface CanvasStore {
  projectId: string | null;
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  timeline: TimelineClipState[];
  dirty: boolean;
  agentState: AgentState | null;
  setProject: (id: string) => void;
  setAgentState: (patch: Partial<AgentState>) => void;
  setGraph: (nodes: Node<CanvasNodeData>[], edges: Edge[]) => void;
  setTimeline: (clips: TimelineClipState[]) => void;
  addNode: (node: Node<CanvasNodeData>) => void;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
  removeNode: (id: string) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  deselectAll: () => void;
  markDirty: () => void;
  markSaved: () => void;
  triggerGeneration: (nodeId: string) => Promise<void>;
  formatText: (nodeId: string, action: string) => Promise<void>;
}

let zidCounter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(zidCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  projectId: null,
  nodes: [],
  edges: [],
  timeline: [],
  dirty: false,
  agentState: null,
  setProject: (id) => set({ projectId: id }),
  setAgentState: (patch) => set((s) => ({ agentState: { ...EMPTY_AGENT_STATE, ...s.agentState, ...patch }, dirty: true })),
  setGraph: (nodes, edges) => set({ nodes, edges, dirty: false }),
  setTimeline: (clips) => set({ timeline: clips, dirty: true }),
  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node], dirty: true })),
  updateNodeData: (id, patch) => set((s) => ({
    nodes: s.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n),
    dirty: true,
  })),
  removeNode: (id) => set((s) => ({
    nodes: s.nodes.filter((n) => n.id !== id),
    edges: s.edges.filter((e) => e.source !== id && e.target !== id),
    timeline: s.timeline.filter((c) => c.nodeId !== id),
    dirty: true,
  })),
  onNodesChange: (changes) => set((s) => {
    const nodes = applyNodeChanges(changes, s.nodes) as Node<CanvasNodeData>[];
    const removedIds = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removedIds.length === 0) {
      return { nodes, dirty: changes.some(c => c.type !== "select") || s.dirty };
    }
    // 节点被删除(键盘/按钮)时,同步清理关联连线和时间线片段
    const removed = new Set(removedIds);
    return {
      nodes,
      edges: s.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
      timeline: s.timeline.filter((c) => !removed.has(c.nodeId)),
      dirty: true,
    };
  }),
  deselectAll: () => set((s) => ({ nodes: s.nodes.map((n) => ({ ...n, selected: false })) })),
  onEdgesChange: (changes) => set((s) => ({
    edges: applyEdgeChanges(changes, s.edges),
    dirty: changes.some(c => c.type !== "select") || s.dirty,
  })),
  onConnect: (connection) => set((s) => {
    const sourceNode = s.nodes.find((n) => n.id === connection.source);
    const targetNode = s.nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return s;

    const src = sourceNode.data.kind;
    const tgt = targetNode.data.kind;
    const isAllowed =
      (src === "text" && (tgt === "image" || tgt === "video")) ||
      (src === "image" && (tgt === "video" || tgt === "image")) ||
      (src === "upload" && (tgt === "image" || tgt === "video")) ||
      (src === "audio" && tgt === "video");
    if (!isAllowed) return s;

    let role = "reference";
    if ((src === "image" || src === "upload") && tgt === "video") role = "first-frame";
    if (src === "audio" && tgt === "video") role = "audio";
    const edge: Edge = {
      id: uid("e"),
      source: connection.source,
      target: connection.target,
      data: { role },
      animated: true,
    };
    return { edges: addEdge(edge, s.edges), dirty: true };
  }),
  markDirty: () => set({ dirty: true }),
  markSaved: () => set({ dirty: false }),
  triggerGeneration: async (nodeId) => {
    const s = get();
    const node = s.nodes.find((n) => n.id === nodeId);
    if (!node || !s.projectId) return;
    const data = node.data;

    let prompt = data.prompt ?? "";
    const imageRefs: { id: string; url: string }[] = [];
    const audioUrls: string[] = [];

    for (const e of s.edges) {
      if (e.target !== nodeId) continue;
      const src = s.nodes.find((n) => n.id === e.source);
      if (!src) continue;
      if (src.data.prompt) prompt = prompt || src.data.prompt;
      if (src.data.kind === "audio") {
        if (!src.data.remoteUrl) {
          set((st) => ({
            nodes: st.nodes.map((n) =>
              n.id === nodeId
                ? { ...n, data: { ...n.data, status: "failed", error: "上游音频节点尚未生成完成，请先合成音频" } }
                : n
            ),
          }));
          return;
        }
        audioUrls.push(src.data.remoteUrl);
      }
      if ((src.data.kind === "image" || src.data.kind === "upload") && src.data.remoteUrl) {
        imageRefs.push({ id: src.id, url: src.data.remoteUrl });
      }
    }

    // 按用户在配置面板拖拽设定的顺序对参考图排序
    const order = (data.referenceOrder as string[] | undefined) ?? [];
    imageRefs.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const imageUrls = imageRefs.map((r) => r.url);

    // 参考图名字映射(短剧 Agent 设置):与排序后的参考图对齐,供台词按角色名精确绑定;有缺名则放弃精确绑定
    const refNames = data.refNames;
    const speakerMap =
      refNames && imageRefs.length > 0 && imageRefs.every((r) => refNames[r.id])
        ? imageRefs.map((r) => refNames[r.id])
        : undefined;

    // 图片→视频:1 张为首帧图生视频;多张为关键帧序列(extra_body.image + keyframes)
    const firstFrameUrl = imageUrls.length === 1 ? imageUrls[0] : undefined;

    // 台词注入:Agnes 可按提示词台词直生人声(Phase 0 实测含音轨),口型与台词同步
    // 多行台词 + 多张参考图时按行序绑定参考图(lib/dialogue.ts),否则用通用注入
    // 注入块拼在参考图一致性后缀之前:视频模型对提示词前部权重更高,长提示词尾部的台词指令易被稀释
    const dialogue = data.dialogue?.trim();
    if (dialogue && data.kind === "video") {
      // 同一台词在画面描述和台词块重复出现会被模型当成两次说话指令,先剥离画面描述里的内嵌台词
      prompt = stripEmbeddedDialogue(prompt, dialogue);
      const injected = buildDialogueInjection(dialogue, imageUrls.length, speakerMap, Number(data.seconds) || undefined);
      prompt = `${prompt}\n${injected ?? `人物开口说出台词(人声清晰、咬字清楚,口型与台词精确同步,台词全文只有这些,逐字念出,禁止增加、改写或延伸任何台词,不加旁白解说,念完即止)："${dialogue}"`}`;
    }

    // 有参考图时追加一致性描述(Agnes 无身份锁定参数,prompt 是官方唯一手段)
    if (imageUrls.length > 0 && data.kind === "video" && data.lockIdentity !== false) {
      const suffix = imageUrls.length >= 2
        ? "。保持人物面部特征、五官、发型和服装与参考图完全一致,角色身份不变,镜头角度一致,关键帧之间自然过渡"
        : "。保持人物面部特征、五官、发型和服装与参考图完全一致,角色身份不变";
      if (!prompt.includes("面部特征")) {
        prompt = `${prompt}${suffix}`;
      }
    }
    if (imageUrls.length > 0 && data.kind === "image" && data.lockIdentity !== false) {
      if (!prompt.includes("面部特征")) {
        prompt = `${prompt},保持人物面部特征、五官、发型与参考图完全一致`;
      }
    }

    // 音轨硬性约束压轴:视频模型对提示词末尾 token 权重最高,音频要求放最后收尾;
    // 仅带台词的镜头追加(无台词镜头的声音设计已由 agent 烘焙进节点提示词)
    if (data.kind === "video" && dialogue) {
      prompt = `${prompt}。音频硬性要求:除台词块中的台词外,全片禁止出现任何其他人声(呢喃、喘息、哼唱、旁白、歌词都禁止),禁止用新的说话内容填充静默,环境音与音乐音量压到最低,台词念完后的剩余时长保持安静`;
    }

    if (!prompt.trim()) {
      set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, status: "failed", error: "没有可用提示词,请先连一个提示词节点或在节点内填写" } } : n) }));
      return;
    }

    set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, status: "queued", error: undefined } } : n) }));

    try {
      if (data.kind === "image") {
        const res = await fetch("/api/generate/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: s.projectId, nodeId, prompt, size: data.imageTier ?? "4K", ratio: data.imageRatio ?? "1:1", negativePrompt: data.negativePrompt, referenceUrls: imageUrls, model: data.model }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "生成失败");
        set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, status: "done", mediaId: json.mediaId, remoteUrl: json.url } } : n) }));
      } else if (data.kind === "video") {
        const res = await fetch("/api/generate/video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: s.projectId, nodeId, prompt, image: firstFrameUrl, referenceUrls: imageUrls, audioUrls, seconds: data.seconds, aspectRatio: data.aspectRatio, negativePrompt: data.negativePrompt, seed: data.seed, model: data.model, size: data.videoSize }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "生成失败");
        set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, status: "generating" } } : n) }));
      }
    } catch (error) {
      set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, status: "failed", error: (error as Error).message } } : n) }));
    }
  },
  formatText: async (nodeId, action) => {
    set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, textBusy: true, textError: undefined } } : n) }));
    try {
      const node = get().nodes.find((n) => n.id === nodeId);
      const text = node?.data.prompt ?? "";
      const res = await fetch("/api/text/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, action, model: node?.data.textModel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "格式化失败");
      set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, prompt: json.result, textBusy: false } } : n) }));
    } catch (error) {
      set((st) => ({ nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, textBusy: false, textError: (error as Error).message } } : n) }));
    }
  },
}));
