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
  if (!st.projectId || !theme.trim()) return;

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
      });
      connect(s0.outlineNodeId!, nodeId);
      patch({
        assets: assetList.map((x, j) =>
          j === i ? { ...x, nodeId, status: "running" } : x,
        ),
      });
      const ok = await generateAndAwait(nodeId);
      patch({
        assets: assetList.map((x, j) =>
          j === i ? { ...x, status: ok ? "done" : "failed" } : x,
        ),
      });
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

  for (let i = 0; i < shots.length; i++) {
    if (aborted) return;
    const shot = shots[i];

    // 参考图顺序：出场角色立绘在前（按 characters 顺序），场景图最后；
    // refNames 供台词按角色名精确绑定，场景图标「场景」。
    const refIds: string[] = [];
    const refNames: Record<string, string> = {};
    for (const cname of shot.characters) {
      const src = charNodes.get(cname);
      if (src) {
        refIds.push(src);
        refNames[src] = cname;
      }
    }
    if (sceneNode) {
      refIds.push(sceneNode);
      refNames[sceneNode] = "场景";
    }

    const nodeId = addAgentNode("video", { x: 800, y: i * 320 }, {
      label: `第${shot.index}镜`,
      prompt: `${stylePrompt},${shot.description}`,
      dialogue: shot.dialogue.length ? shot.dialogue.join("\n") : undefined,
      seconds: "10",
      aspectRatio: s.aspectRatio,
      referenceOrder: refIds,
      refNames,
    });
    for (const src of refIds) connect(src, nodeId);

    patch({
      shots: shots.map((x, j) =>
        j === i ? { ...x, nodeId, status: "running" } : x,
      ),
    });

    const ok = await generateAndAwait(nodeId);
    // 单镜失败跳过不阻塞，标记为 skipped
    patch({
      shots: shots.map((x, j) =>
        j === i ? { ...x, status: ok ? "done" : "skipped" } : x,
      ),
    });
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
