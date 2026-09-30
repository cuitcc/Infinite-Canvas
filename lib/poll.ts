import { submitQueuedVideo } from "./video-queue";
import { videoBackoffMs } from "./video-retry";
import { getAgnesVideo, resolveAgnesVideoUrl } from "./agnes-video";
import { genericVideoPoll } from "./generic-provider";
import { getPendingGenTasks, saveRemoteMedia, updateNodeData, upsertGenTask, nowTs } from "./db";

// Route Handler 打包可能重复加载本模块；进程内共享锁，避免重复查询同一任务。
const shared = globalThis as typeof globalThis & { videoPollState?: {
  timer: ReturnType<typeof setInterval> | null; polling: Set<string>;
  next: Map<string, number>; failures: Map<string, number>; cooldown: number;
} };
const state = shared.videoPollState ??= { timer: null, polling: new Set(), next: new Map(), failures: new Map(), cooldown: 0 };
const pollingTasks = state.polling;
const POLL_INTERVAL_MS = 10_000;

export function startVideoPoller() {
  if (state.timer) return;
  const safeTick = () => { void tick().catch((error) => console.error("[poller] tick failed", error)); };
  state.timer = setInterval(safeTick, POLL_INTERVAL_MS);
  state.timer.unref?.();
  safeTick();
}

async function tick() {
  const pending = getPendingGenTasks().filter((t) => t.kind === "video" && !pollingTasks.has(t.id));
  const agnes = pending.filter((t) => t.agnes_task_id && Date.now() >= state.cooldown && Date.now() >= (state.next.get(t.id) ?? 0))
    .sort((a, b) => (state.next.get(a.id) ?? 0) - (state.next.get(b.id) ?? 0)).slice(0, 1);
  const generic = pending.filter((t) => !t.agnes_task_id && t.provider_task_id);

  await Promise.allSettled([
    submitQueuedVideo(),
    ...agnes.map((task) => pollAgnes(task)),
    ...generic.map((task) => pollGeneric(task)),
  ]);
}

async function pollAgnes(task: import("./db").GenTaskRow) {
  pollingTasks.add(task.id);
  state.next.set(task.id, Date.now() + 30_000);
  try {
    const model = task.provider_model ?? "agnes-video-2.5-flash";
    let remote = await getAgnesVideo(task.agnes_task_id!, model);
    if (remote.status === "completed") {
      remote = await resolveAgnesVideoUrl(remote);
      const url = remote.url || remote.video_url || remote.metadata?.url;
      if (!url) {
        upsertGenTask({ ...task, status: "failed", error: "Agnes 任务完成但未返回视频 URL", updated_at: nowTs() });
        updateNodeData(task.node_id, { status: "failed", error: "任务完成但未返回视频 URL" });
        return;
      }
      const media = await saveRemoteMedia("video", url);
      upsertGenTask({ ...task, status: "completed", remote_url: url, media_id: media.id, updated_at: nowTs() });
      updateNodeData(task.node_id, { status: "done", mediaId: media.id, remoteUrl: url, updatedAt: nowTs() });
    } else if (remote.status === "failed") {
      const errText = typeof remote.error === "string" ? remote.error : JSON.stringify(remote.error ?? "生成失败");
      upsertGenTask({ ...task, status: "failed", error: errText, updated_at: nowTs() });
      updateNodeData(task.node_id, { status: "failed", error: errText });
    } else {
      upsertGenTask({ ...task, status: "in_progress", updated_at: nowTs() });
    }
    state.failures.delete(task.id);
  } catch (error) {
    const failures = (state.failures.get(task.id) ?? 0) + 1;
    state.failures.set(task.id, failures);
    const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs ?? 0;
    const nextAt = Date.now() + videoBackoffMs(failures, retryAfter);
    state.next.set(task.id, nextAt);
    const status = (error as { status?: number }).status;
    if (status === 429) {
      // 查询限流时整个账户暂停查询，避免其他镜头继续撞限流。
      state.cooldown = nextAt;
      console.warn("[poller:agnes] rate limited, will retry", { taskId: task.id, nextAt });
      return;
    }
    if (status === 404) {
      // 任务不存在或已过期：标记失败，避免无限轮询
      const message = "Agnes 任务不存在或已过期";
      console.error("[poller:agnes] task not found", { taskId: task.id, agnesTaskId: task.agnes_task_id });
      upsertGenTask({ ...task, status: "failed", error: message, updated_at: nowTs() });
      updateNodeData(task.node_id, { status: "failed", error: message });
      return;
    }
    console.error("[poller:agnes] task failed", task.id, error);
  } finally {
    pollingTasks.delete(task.id);
    // 已结束任务的退避状态不常驻内存。
    if (!getPendingGenTasks().some((t) => t.id === task.id)) {
      state.next.delete(task.id);
      state.failures.delete(task.id);
    }
  }
}

async function pollGeneric(task: import("./db").GenTaskRow) {
  pollingTasks.add(task.id);
  try {
    const providerTask = typeof task.provider_task_id === "string" ? task.provider_task_id : "";
    if (!providerTask) {
      upsertGenTask({ ...task, status: "failed", error: "缺少厂商任务标识", updated_at: nowTs() });
      return;
    }
    const result = await genericVideoPoll({
      providerId: providerTask.split("::")[0],
      providerTaskId: providerTask.split("::")[1] ?? providerTask,
      modelName: task.provider_model ?? "",
    });
    if (result.status === "completed") {
      const media = await saveRemoteMedia("video", result.url);
      upsertGenTask({ ...task, status: "completed", remote_url: result.url, media_id: media.id, updated_at: nowTs() });
      updateNodeData(task.node_id, { status: "done", mediaId: media.id, remoteUrl: result.url, updatedAt: nowTs() });
    } else if (result.status === "failed") {
      upsertGenTask({ ...task, status: "failed", error: result.error, updated_at: nowTs() });
      updateNodeData(task.node_id, { status: "failed", error: result.error });
    }
    // pending: 保持 in_progress,下轮再查
  } catch (error) {
    console.error("[poller:generic] task failed", task.id, error);
  } finally {
    pollingTasks.delete(task.id);
  }
}
