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
  shots: { index: number; scene?: string; description: string; characters: string[]; dialogue: string[] }[];
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
  const sceneNames = s.assets
    .filter((a) => a.kind === "scene")
    .map((a) => a.name);

  const shotsPlan = await plan<Storyboard>(
    "storyboard",
    JSON.stringify({
      outline: outlineNode?.data.prompt,
      assetNames,
      sceneNames,
      count: s.shotCount,
    }),
    s.shotCount,
  );

  const shots: AgentShot[] = shotsPlan.shots.map((sh, i) => ({
    index: sh.index ?? i + 1,
    description: sh.description,
    dialogue: sh.dialogue ?? [],
    characters: sh.characters ?? [],
    scene: sh.scene ?? "",
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
  // 场景名 → 节点 id 映射,分镜按本镜剧情地点选用;第一个成功场景兜底(模型漏填 scene 时)
  const sceneNodes = new Map<string, string>();
  let fallbackSceneNode: string | null = null;
  for (const a of s.assets) {
    if (a.kind === "scene" && a.nodeId && a.status === "done") {
      sceneNodes.set(a.name, a.nodeId);
      fallbackSceneNode ??= a.nodeId;
    }
  }

  // 上一镜尾帧衔接:{ nodeId, url } | null;截帧失败或上一镜跳过时为 null
  let prevTail: { nodeId: string; url: string } | null = null;

  for (let i = 0; i < shots.length; i++) {
    if (aborted) return;
    const shot = shots[i];

    // 参考图顺序:出场角色立绘(按 characters 顺序,与分镜描述"<Picture N>"编号对齐)→ 出镜道具 → 场景图 → 上一镜尾帧(最后一张);
    // refNames 供台词按角色名精确绑定,非角色条目标注为画面参考。Agnes reference 模式上限 5 张,
    // 超限依次剔除:场景图 → 道具 → 编号最大的角色(保住前面角色的"<Picture N>"锚点),尾帧必留。
    // 注:reference 模式禁传 first_frame,尾帧靠提示词声明"作为首帧起播",为软约束(开头贴近,不保证逐帧一致)。
    const refs: { id: string; name: string }[] = [];
    for (const cname of shot.characters) {
      const src = charNodes.get(cname);
      if (src) refs.push({ id: src, name: cname });
    }
    // 道具:名称出现在本镜画面描述中才作为参考图,帮助道具形制一致
    for (const a of s.assets) {
      if (a.kind === "prop" && a.nodeId && a.status === "done" && shot.description.includes(a.name)) {
        refs.push({ id: a.nodeId, name: `道具·${a.name}` });
      }
    }
    // 本镜场景按分镜标注的剧情地点匹配;分镜未标注或该场景资产生成失败时用第一个成功场景兜底
    const sceneNode = (shot.scene ? sceneNodes.get(shot.scene) : null) ?? fallbackSceneNode;
    if (sceneNode) refs.push({ id: sceneNode, name: "场景" });
    if (prevTail) refs.push({ id: prevTail.nodeId, name: "上一镜尾帧" });
    while (refs.length > 5) {
      const names = refs.map((r) => r.name);
      const sceneIdx = names.lastIndexOf("场景");
      if (sceneIdx !== -1) {
        refs.splice(sceneIdx, 1);
        continue;
      }
      // 从后往前找第一个可剔除项(道具优先于角色,尾帧必留);剔除编号靠后的角色可保住前段"<Picture N>"锚点
      let dropIdx = -1;
      for (let j = refs.length - 2; j >= 0; j--) {
        if (names[j].startsWith("道具·")) { dropIdx = j; break; }
      }
      if (dropIdx === -1) {
        for (let j = refs.length - 2; j >= 0; j--) {
          if (!names[j].startsWith("道具·")) { dropIdx = j; break; }
        }
      }
      if (dropIdx === -1) dropIdx = 0;
      refs.splice(dropIdx, 1);
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

    // 官方 <Picture N> 占位符逐张声明参考图用途:只锁外形,动作朝向机位以提示词为准(立绘正面站姿会被连姿势复制)
    const identityNote = refs
      .map((r, i) => {
        const p = `<Picture ${i + 1}>`;
        if (r.name === "场景") return `${p}为场景与氛围参考`;
        if (r.name === "上一镜尾帧") return `${p}是上一镜结尾画面,本镜必须直接从这一画面开始(把它当作首帧):开头画面与它完全一致,人物位置、朝向、服装与场景状态从它延续,再完成本镜描述的新动作与新机位运镜`;
        if (r.name.startsWith("道具·")) return `${p}为道具${r.name.slice(3)}的形制参考`;
        return `${p}为${r.name}的长相、发型与服装参考,只取外形,其站姿与朝向不作参考`;
      })
      .join(";");
    // 声音设计(官方六要素之一):有台词靠注入锁定人声;无台词用正面声音描述压住旁白幻觉
    // (否定式"不出现人声"实测无效,生视频模型默认爱加解说,必须具体描述画面内声音把它填满)
    const soundNote = boundDialogue.length
      ? "音轨仅包含上述角色台词人声与现场动作音效"
      : "音轨只有画面内的现场声:脚步声、衣物摩擦声、器物声响与自然环境音,没有解说旁白,没有任何说话声";
    const nodeId = addAgentNode("video", { x: 800, y: i * 320 }, {
      label: `第${shot.index}镜`,
      prompt: `${stylePrompt},${shot.description},${identityNote},${soundNote}`,
      dialogue: boundDialogue.length ? boundDialogue.join("\n") : undefined,
      seconds: "10",
      aspectRatio: s.aspectRatio,
      model: "agnes-video-2.5-flash",
      referenceOrder: refIds,
      refNames,
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
