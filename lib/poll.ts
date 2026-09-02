import { getAgnesVideo, resolveAgnesVideoUrl } from "./agnes-video";
import { genericVideoPoll } from "./generic-provider";
import { getPendingGenTasks, saveRemoteMedia, updateNodeData, upsertGenTask, nowTs } from "./db";

let pollTimer: ReturnType<typeof setInterval> | null = null;
const pollingTasks = new Set<string>();
const POLL_INTERVAL_MS = 10_000;

export function startVideoPoller() {
  if (pollTimer) return;
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  void tick();
}

async function tick() {
  const pending = getPendingGenTasks().filter((t) => t.kind === "video" && !pollingTasks.has(t.id));
  const agnes = pending.filter((t) => t.agnes_task_id);
  const generic = pending.filter((t) => !t.agnes_task_id && t.provider_task_id);

  await Promise.allSettled([
    ...agnes.map((task) => pollAgnes(task)),
    ...generic.map((task) => pollGeneric(task)),
  ]);
}

async function pollAgnes(task: import("./db").GenTaskRow) {
  pollingTasks.add(task.id);
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
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 429) {
      // 查询频率超限：保持 in_progress，下次轮询自然退避
      console.warn("[poller:agnes] rate limited, will retry", { taskId: task.id, agnesTaskId: task.agnes_task_id });
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
  }
}

async function pollGeneric(task: import("./db").GenTaskRow) {
  pollingTasks.add(task.id);
  try {
    const result = await genericVideoPoll({
      providerId: task.provider_task_id!.split("::")[0],
      providerTaskId: task.provider_task_id!.split("::")[1] ?? task.provider_task_id!,
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
