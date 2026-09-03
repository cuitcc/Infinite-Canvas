"use client";

import { useCanvasStore, type AgentAsset, type AgentShot, type CanvasNodeData } from "./store";

// ==================== 类型定义 ====================

type Outline = {
  title: string;
  genre: string;
  synopsis: string;
  characters: { name: string; appearance: string }[];
  scenes: { name: string; description: string }[];
  script: string;
};

type OutlineAsset = { kind: "character" | "scene" | "prop"; name: string; prompt: string };

type Storyboard = {
  shots: { index: number; description: string; characters: string[]; dialogue: string[] }[];
};

// ==================== 模块级状态 ====================

let aborted = false;
let nodeSeq = 0;

const agentNodeId = (p: string) =>
  `agent-${p}-${Date.now().toString(36)}-${nodeSeq++}-${Math.random().toString(36).slice(2, 7)}`;

// ==================== 工具函数 ====================

/** 快速 patch agentState（合并式更新） */
function patch(patchObj: Partial<import("./store").AgentState>) {
  useCanvasStore.getState().setAgentState(patchObj);
}

/** 调用规划 API（outline / assets / storyboard） */
async function plan<T>(task: string, input: string, shotCount?: number): Promise<T> {
  const res = await fetch("/api/agent/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, input, shotCount }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "规划失败");
  return json.data as T;
}

/** 在画布上新增一个 Agent 生成的节点，返回节点 id */
function addAgentNode(
  kind: "text" | "image" | "video",
  position: { x: number; y: number },
  data: Partial<CanvasNodeData>,
): string {
  const id = agentNodeId(kind);
  useCanvasStore.getState().addNode({
    id,
    type: kind,
    position,
    data: { kind, label: "", ...data } as CanvasNodeData,
  });
  return id;
}

/** 连接两个节点（source → target） */
function connect(source: string, target: string) {
  useCanvasStore.getState().onConnect({
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
  });
}

/** 轮询等待节点生成完成；超时或失败返回 false，被 abort 返回 false */
async function waitForNode(nodeId: string, timeoutMs = 15 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (aborted) return false;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    if (node?.data.status === "done") return true;
    if (node?.data.status === "failed") return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** 触发节点生成并等待；失败自动重试一次，再失败返回 false */
async function generateAndAwait(nodeId: string): Promise<boolean> {
  // await 并兜住 triggerGeneration 的同步失败(节点丢失/projectId 为空等),避免 unhandled rejection 与死等超时
  try {
    await useCanvasStore.getState().triggerGeneration(nodeId);
  } catch (e) {
    console.error("[agent] triggerGeneration failed", nodeId, e);
    return false;
  }
  const ok = await waitForNode(nodeId);
  if (!ok && !aborted) {
    // 失败自动重试一次：清掉 error，重置为 queued，再触发
    patchErr(nodeId, undefined);
    try {
      await useCanvasStore.getState().triggerGeneration(nodeId);
    } catch (e) {
      console.error("[agent] triggerGeneration retry failed", nodeId, e);
      return false;
    }
    return waitForNode(nodeId);
  }
  return ok;
}

const patchErr = (nodeId: string, error?: string) =>
  useCanvasStore.getState().updateNodeData(nodeId, { error, status: "queued" });

/** 截取视频最后一帧并上传,返回图片 URL;任何失败返回 null(降级为不使用尾帧衔接)。
 * 用 /api/media/{id} 同源播放避开 canvas 跨域污染,无需 ffmpeg。 */
async function extractLastFrameUrl(mediaId: string): Promise<string | null> {
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = `/api/media/${mediaId}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("视频加载超时")), 30_000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error("视频加载失败")); };
    });
    // seek 到结尾前 0.15s,取最后一帧
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("seek 超时")), 15_000);
      video.onseeked = () => { clearTimeout(timer); resolve(); };
      video.currentTime = Math.max(0, (video.duration || 10) - 0.15);
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width) return null;
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return null;
    const form = new FormData();
    form.append("file", new File([blob], `agent-tail-${mediaId}.jpg`, { type: "image/jpeg" }));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const json = await res.json();
    if (!res.ok || !json.url) return null;
    return json.url as string;
  } catch (e) {
    console.warn("[agent] 截取上一镜尾帧失败,本镜降级为无尾帧衔接", e);
    return null;
  }
}

// ==================== 对外 API ====================

/** 中止当前 Agent 流程 */
export function abortAgent() {
  aborted = true;
  const cur = useCanvasStore.getState().agentState;
  const curStage = cur?.stage;
  if (curStage && !["aborted", "idle", "done"].includes(curStage)) {
    patch({ stage: "aborted", abortedFrom: curStage });
  } else {
    patch({ stage: "aborted" });
  }
}

/** 大纲 → 风格选择（暂停，等待用户调用 chooseStyle） */
export async function runAgent(theme: string, shotCount: number, aspectRatio: string) {
  const cur = useCanvasStore.getState().agentState;
  // 并发保护:流水线运行中拒绝重复启动(避免 aborted 标志与 agentState 被第二路流程破坏)
  if (cur && !["idle", "aborted", "done"].includes(cur.stage)) return;
  aborted = false;
  const st = useCanvasStore.getState();
  if (!st.projectId) {
    // 项目未加载时给可见反馈,而非静默返回让用户以为按钮失灵
    patch({ stage: "idle", error: "项目尚未加载完成,请稍候重试" });
    return;
  }
  if (!theme.trim()) return;

  patch({
    stage: "outline",
    theme,
    shotCount,
    aspectRatio,
    styleName: "",
    stylePrompt: "",
    assets: [],
    shots: [],
    error: null,
    outlineNodeId: null,
    outlineJson: null,
    abortedFrom: undefined,
  });

  try {
    const outline = await plan<Outline>("outline", theme);
    if (aborted) return;

    // 保存结构化大纲 JSON 到 agentState，后续 assets/storyboard 阶段直接复用，
    // 避免重复 LLM 调用（简报授权的微调）。
    const outlineNodeId = addAgentNode("text", { x: 0, y: 0 }, {
      label: `剧本大纲·${outline.title}`,
      prompt: outlineToText(outline),
    });
    patch({
      outlineNodeId,
      outlineJson: outline,
      stage: "style", // 停：面板弹风格库，用户选后调 chooseStyle
    });
  } catch (e) {
    patch({ stage: "idle", error: (e as Error).message });
  }
}

/** 风格选定后继续：assets → storyboard → shots → assembly */
export async function chooseStyle(styleName: string, stylePrompt: string) {
  const s0 = useCanvasStore.getState().agentState;
  if (!s0?.outlineNodeId) return;
  aborted = false;
  patch({ styleName, stylePrompt, stage: "assets" });

  try {
    // 复用 runAgent 阶段已经拿到的 outlineJson，避免再调一次 outline plan
    const outlineJson = s0.outlineJson;
    if (!outlineJson) {
      throw new Error("大纲数据丢失，请重新生成");
    }

    // ---- assets 阶段 ----
    const { assets } = await plan<{ assets: OutlineAsset[] }>(
      "assets",
      JSON.stringify(outlineJson),
    );
    if (aborted) return;

    const assetList: AgentAsset[] = assets.map((a, i) => ({
      id: `a${i}`,
      kind: a.kind,
      name: a.name,
      prompt: a.prompt,
      nodeId: null,
      status: "pending",
    }));
    patch({ assets: assetList });

    for (let i = 0; i < assetList.length; i++) {
      if (aborted) return;
      const a = assetList[i];
      const kindLabel =
        a.kind === "character" ? "角色" : a.kind === "scene" ? "场景" : "道具";
      const nodeId = addAgentNode("image", { x: 400, y: i * 320 }, {
        label: `${kindLabel}-${a.name}`,
        prompt: `${stylePrompt},${a.prompt}`,
        imageTier: "2K", // 参考图无需 4K:减小图片体积,避免多张 4K 大图把页面卡住
      });
      connect(s0.outlineNodeId!, nodeId);
      // 原地更新当前项后再写 store:若从旧数组重建,nodeId 会被下一轮 patch 抹掉,导致分镜阶段筛不到参考图
      assetList[i] = { ...assetList[i], nodeId, status: "running" };
      patch({ assets: [...assetList] });
      const ok = await generateAndAwait(nodeId);
      assetList[i] = { ...assetList[i], status: ok ? "done" : "failed" };
      patch({ assets: [...assetList] });
    }

    await runStoryboardAndShots(stylePrompt);
  } catch (e) {
    patch({ error: (e as Error).message, stage: "style" });
  }
}

// ==================== 内部：分镜 + 合成 ====================

async function runStoryboardAndShots(stylePrompt: string) {
  const s = useCanvasStore.getState().agentState!;
  if (aborted) return;
  patch({ stage: "storyboard" });

  const outlineNode = useCanvasStore.getState().nodes.find(
    (n) => n.id === s.outlineNodeId,
  );
  const assetNames = s.assets
    .filter((a) => a.kind === "character")
    .map((a) => a.name);

  const shotsPlan = await plan<Storyboard>(
    "storyboard",
    JSON.stringify({
      outline: outlineNode?.data.prompt,
      assetNames,
      count: s.shotCount,
    }),
    s.shotCount,
  );

  const shots: AgentShot[] = shotsPlan.shots.map((sh, i) => ({
    index: sh.index ?? i + 1,
    description: sh.description,
    dialogue: sh.dialogue ?? [],
    characters: sh.characters ?? [],
    scene: "",
    nodeId: null,
    status: "pending",
  }));
  patch({ shots, stage: "shots" });

  // 角色名 → 节点 id 映射（仅已成功生成的角色立绘）
  const charNodes = new Map<string, string>();
  for (const a of s.assets) {
    if (a.kind === "character" && a.nodeId && a.status === "done") {
      charNodes.set(a.name, a.nodeId);
    }
  }
  // 取第一个已成功生成的场景图作为通用场景参考
  const sceneNode =
    s.assets.find(
      (a) => a.kind === "scene" && a.nodeId && a.status === "done",
    )?.nodeId ?? null;

  // 上一镜尾帧衔接:{ nodeId, url } | null;截帧失败或上一镜跳过时为 null
  let prevTail: { nodeId: string; url: string } | null = null;

  for (let i = 0; i < shots.length; i++) {
    if (aborted) return;
    const shot = shots[i];

    // 参考图顺序:出场角色立绘(按 characters 顺序,与分镜描述"参考图N"编号对齐)→ 场景图 → 上一镜尾帧(最后一张,衔接基准);
    // refNames 供台词按角色名精确绑定,尾帧/场景图标注为非说话人。Agnes reference 模式上限 5 张,超限先去场景图再去多余角色,尾帧必留。
    const refs: { id: string; name: string }[] = [];
    for (const cname of shot.characters) {
      const src = charNodes.get(cname);
      if (src) refs.push({ id: src, name: cname });
    }
    if (sceneNode) refs.push({ id: sceneNode, name: "场景" });
    if (prevTail) refs.push({ id: prevTail.nodeId, name: "上一镜尾帧" });
    while (refs.length > 5) {
      const sceneIdx = refs.map((r) => r.name).lastIndexOf("场景");
      if (sceneIdx !== -1) {
        refs.splice(sceneIdx, 1);
        continue;
      }
      // 场景图已移除仍超限:从前往后去角色立绘,尾帧必留
      const charIdx = refs.findIndex((r) => r.name !== "上一镜尾帧");
      refs.splice(charIdx === -1 ? 0 : charIdx, 1);
    }
    const refIds = refs.map((r) => r.id);
    const refNames: Record<string, string> = Object.fromEntries(refs.map((r) => [r.id, r.name]));

    // 台词只保留说话人能绑定到参考图的行:否则 buildDialogueInjection 精确绑定整体失效,
    // 回退成整块引号注入,模型会让第一个角色念完全部台词
    const speakerSet = new Set(refs.map((r) => r.name));
    const boundDialogue = shot.dialogue.filter((l) => {
      const m = /^([^：:]+)[：:]/.exec(l.trim());
      return !!m && speakerSet.has(m[1].trim());
    });

    // 参考图仅锁定长相/服装:立绘是正面站姿,不声明会被模型连姿势一起复制,导致全员面向镜头站桩
    const poseNote = "参考图仅用于锁定人物长相、发型与服装,人物的动作、身体朝向和镜头机位以提示词描述为准,不要复制参考图中的站姿";
    const nodeId = addAgentNode("video", { x: 800, y: i * 320 }, {
      label: `第${shot.index}镜`,
      prompt: prevTail
        ? `${stylePrompt},${shot.description},${poseNote},最后一张参考图是上一镜结尾画面:人物位置、场景与画面状态从它自然延续,但禁止沿用上一镜的构图和景别,本镜必须换新机位重新起幅并完成明确的运镜`
        : `${stylePrompt},${shot.description},${poseNote}`,
      dialogue: boundDialogue.length ? boundDialogue.join("\n") : undefined,
      seconds: "10",
      aspectRatio: s.aspectRatio,
      referenceOrder: refIds,
      refNames,
      // 抑制"全员怼脸正面站桩":与分镜运镜要求配合,给模型反向约束
      negativePrompt: "固定机位,画面静止,所有人物正面朝向镜头,呆板站立,字幕,水印,文字",
    });
    for (const src of refIds) connect(src, nodeId);

    // 同 assets 循环:原地更新,避免下一轮 patch 抹掉 nodeId(否则 assembly 装不进时间线)
    shots[i] = { ...shots[i], nodeId, status: "running" };
    patch({ shots: [...shots] });

    const ok = await generateAndAwait(nodeId);
    // 单镜失败跳过不阻塞，标记为 skipped
    shots[i] = { ...shots[i], status: ok ? "done" : "skipped" };
    patch({ shots: [...shots] });

    // 生成成功则截取尾帧供下一镜衔接;失败则清空,下一镜降级为无尾帧
    if (!ok || i + 1 >= shots.length || aborted) {
      prevTail = null;
      continue;
    }
    const doneNode = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const mediaId = doneNode?.data.mediaId;
    const tailUrl = mediaId ? await extractLastFrameUrl(mediaId) : null;
    if (tailUrl) {
      const tailNodeId = addAgentNode("image", { x: 620, y: i * 320 + 160 }, {
        label: `第${shot.index}镜尾帧`,
        prompt: `第${shot.index}镜结尾画面(自动截取,供下一镜开头衔接)`,
        remoteUrl: tailUrl,
        status: "done",
      });
      prevTail = { nodeId: tailNodeId, url: tailUrl };
    } else {
      prevTail = null;
    }
  }

  // ---- assembly：按序填时间线（仅成功的镜） ----
  if (aborted) return;
  patch({ stage: "assembly" });

  const stNow = useCanvasStore.getState();
  const clips = stNow
    .agentState!.shots.filter((sh) => sh.status === "done" && sh.nodeId)
    .map((sh, i) => {
      const node = stNow.nodes.find((n) => n.id === sh.nodeId);
      return {
        id: agentNodeId("clip"),
        nodeId: sh.nodeId!,
        mediaId: node?.data.mediaId ?? "",
        order: i,
        trimIn: 0,
        trimOut: null,
      };
    })
    .filter((c) => c.mediaId);

  stNow.setTimeline([...stNow.timeline, ...clips]);
  patch({ stage: "done" });
}

// ==================== 辅助 ====================

function outlineToText(o: Outline): string {
  const chars = o.characters.map((c) => `${c.name}（${c.appearance}）`).join("；");
  const scenes = o.scenes.map((s) => `${s.name}：${s.description}`).join("；");
  return `《${o.title}》(${o.genre})\n梗概：${o.synopsis}\n角色：${chars}\n场景：${scenes}\n\n${o.script}`;
}
