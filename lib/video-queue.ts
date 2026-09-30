import { AgnesApiError, AgnesTransportError, AgnesResponseError, createAgnesVideo } from "./agnes-video";
import { getDb, newId, nowTs, updateNodeData, upsertGenTask, type GenTaskRow } from "./db";
import type { AgnesCreateVideoBody } from "@/types/agnes";
import { canRetryVideoSubmission, videoBackoffMs, VIDEO_SUBMIT_TIMEOUT_MS, VIDEO_SUBMIT_RECOVERY_GRACE_MS } from "./video-retry";

const SUBMIT_INTERVAL = 65_000;
const MAX_ATTEMPTS = 6;

function queueDb() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS video_submissions (
    task_id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, submitting_at INTEGER, message TEXT
  );
  CREATE TABLE IF NOT EXISTS video_submit_gate (id INTEGER PRIMARY KEY, next_at INTEGER NOT NULL);
  INSERT OR IGNORE INTO video_submit_gate VALUES (1, 0);`);
  const cols = db.prepare("PRAGMA table_info(video_submissions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "submit_deadline_at")) {
    db.exec("ALTER TABLE video_submissions ADD COLUMN submit_deadline_at INTEGER");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS video_submission_diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL, created_at INTEGER NOT NULL, detail TEXT NOT NULL
  );`);
  return db;
}

export function findActiveVideoTask(projectId: string, nodeId: string): GenTaskRow | undefined {
  return getDb().prepare("SELECT * FROM gen_tasks WHERE project_id=? AND node_id=? AND kind='video' AND status IN ('queued','in_progress') ORDER BY created_at DESC LIMIT 1").get(projectId, nodeId) as GenTaskRow | undefined;
}

export function enqueueVideo(projectId: string, nodeId: string, body: AgnesCreateVideoBody): GenTaskRow {
  const db = queueDb();
  // 事务内再次查重，覆盖多个浏览器或参考图处理期间的并发请求。
  return db.transaction(() => {
    const existing = findActiveVideoTask(projectId, nodeId);
    if (existing) return existing;
    const task = upsertGenTask({ id: newId(), project_id: projectId, node_id: nodeId,
      kind: "video", status: "queued", provider_model: body.model,
      agnes_task_id: null, media_id: null, remote_url: null, error: null });
    db.prepare("INSERT INTO video_submissions (task_id,body,message) VALUES (?,?,?)")
      .run(task.id, JSON.stringify(body), "等待提交视频任务");
    updateNodeData(nodeId, { status: "queued", error: null });
    return task;
  }).immediate();
}

export function submissionInfo(taskId: string): { message: string | null; next_at: number; attempts: number } | undefined {
  return queueDb().prepare("SELECT message,next_at,attempts FROM video_submissions WHERE task_id=?").get(taskId) as { message: string | null; next_at: number; attempts: number } | undefined;
}

/** 数据库抢占 + 持久化全局节流，重启后不丢排队任务。 */
export async function submitQueuedVideo() {
  const db = queueDb();
  const claimed = db.transaction(() => {
    // 进程在 POST 后崩溃时，无法确定上游是否受理，不能无条件重复提交。
    const stranded = db.prepare(`SELECT t.* FROM gen_tasks t JOIN video_submissions q ON q.task_id=t.id
      WHERE t.status='queued' AND q.submitting_at IS NOT NULL
      AND COALESCE(q.submit_deadline_at, q.submitting_at + ?) < ?`).all(VIDEO_SUBMIT_TIMEOUT_MS + VIDEO_SUBMIT_RECOVERY_GRACE_MS, nowTs()) as GenTaskRow[];
    for (const task of stranded) {
      const error = "视频提交处理超期或服务曾中断，受理结果未知；请核对上游任务后手动重试";
      recordDiagnostic(task.id, 0, { kind: "worker_interrupted", message: error });
      upsertGenTask({ ...task, status: "failed", error, updated_at: nowTs() });
      updateNodeData(task.node_id, { status: "failed", error });
    }
    const gate = db.prepare("SELECT next_at FROM video_submit_gate WHERE id=1").get() as { next_at: number };
    if (gate.next_at > nowTs()) return undefined;
    // 同一部署只保留一个未完成的 Agnes 任务，避免继续占用已拥堵的队列。
    const busy = db.prepare(`SELECT 1 FROM gen_tasks t LEFT JOIN video_submissions q ON q.task_id=t.id
      WHERE (t.status='in_progress' AND t.agnes_task_id IS NOT NULL)
      OR (t.status='queued' AND q.submitting_at IS NOT NULL) LIMIT 1`).get();
    if (busy) return undefined;
    const task = db.prepare(`SELECT t.*,q.body,q.attempts FROM gen_tasks t JOIN video_submissions q ON q.task_id=t.id
      WHERE t.status='queued' AND q.submitting_at IS NULL AND q.next_at<=?
      ORDER BY t.created_at LIMIT 1`).get(nowTs()) as (GenTaskRow & { body: string; attempts: number }) | undefined;
    if (!task) return undefined;
    db.prepare("UPDATE video_submissions SET submitting_at=?, submit_deadline_at=?, attempts=attempts+1, message='正在等待上游受理，繁忙时可能需要数分钟' WHERE task_id=?")
      .run(nowTs(), nowTs() + VIDEO_SUBMIT_TIMEOUT_MS + VIDEO_SUBMIT_RECOVERY_GRACE_MS, task.id);
    db.prepare("UPDATE video_submit_gate SET next_at=? WHERE id=1").run(nowTs() + SUBMIT_INTERVAL);
    return { ...task, attempts: task.attempts + 1 };
  }).immediate();
  if (!claimed) return;
  const startedAt = nowTs();
  try {
    const remote = await createAgnesVideo(JSON.parse(claimed.body));
    upsertGenTask({ ...claimed, status: "in_progress", agnes_task_id: remote.id, error: null, updated_at: nowTs() });
    db.prepare("DELETE FROM video_submissions WHERE task_id=?").run(claimed.id);
    updateNodeData(claimed.node_id, { status: "generating", error: null });
    console.log("[video-queue] accepted", { taskId: claimed.id, nodeId: claimed.node_id, remoteId: remote.id, elapsedMs: nowTs() - startedAt });
  } catch (error) {
    const code = error instanceof AgnesApiError ? (error.detail as { code?: string } | null)?.code : undefined;
    recordDiagnostic(claimed.id, claimed.attempts, {
      kind: error instanceof AgnesTransportError ? error.kind : error instanceof AgnesApiError ? "upstream_http"
        : error instanceof AgnesResponseError ? "invalid_response" : "internal_error",
      elapsedMs: nowTs() - startedAt,
      ...(error instanceof AgnesTransportError ? error.diagnostic : {}),
      ...(error instanceof AgnesApiError ? { httpStatus: error.status, upstreamCode: code,
        requestId: error.requestId ?? extractRequestId(error.detail) } : {}),
    });
    if (error instanceof AgnesApiError && canRetryVideoSubmission(error.status, code) && claimed.attempts < MAX_ATTEMPTS) {
      const nextAt = nowTs() + videoBackoffMs(claimed.attempts, error.retryAfterMs);
      const message = `${error.message}，已排队自动重试（${claimed.attempts}/${MAX_ATTEMPTS}）`;
      db.prepare("UPDATE video_submissions SET submitting_at=NULL,submit_deadline_at=NULL,next_at=?,message=? WHERE task_id=?").run(nextAt, message, claimed.id);
      db.prepare("UPDATE video_submit_gate SET next_at=MAX(next_at,?) WHERE id=1").run(nextAt);
      console.warn("[video-queue] deferred", { taskId: claimed.id, nextAt, message });
    } else {
      const uncertain = !(error instanceof AgnesApiError) || (error.status >= 500 && code !== "video_queue_full");
      const reason = error instanceof AgnesTransportError ? error.message
        : error instanceof AgnesResponseError ? `视频提交响应格式异常：${error.message}`
        : error instanceof AgnesApiError ? `${error.message}（HTTP ${error.status}，已尝试 ${claimed.attempts} 次）`
        : "视频任务本地处理异常";
      const message = uncertain ? `${reason}；受理结果未知，未自动重发，请核对后手动重试` : reason;
      upsertGenTask({ ...claimed, status: "failed", error: message, updated_at: nowTs() });
      db.prepare("DELETE FROM video_submissions WHERE task_id=?").run(claimed.id);
      updateNodeData(claimed.node_id, { status: "failed", error: message });
    }
  }
}

function extractRequestId(detail: unknown): string | undefined {
  const record = detail as { message?: unknown; error?: { message?: unknown } } | null;
  const message = record?.message ?? record?.error?.message;
  return typeof message === "string" ? /request id:\s*([a-zA-Z0-9_-]+)/i.exec(message)?.[1] : undefined;
}

function recordDiagnostic(taskId: string, attempt: number, detail: Record<string, unknown>) {
  // 即使队列任务终止，诊断仍保留；不记录 body、URL、请求头或密钥。
  queueDb().prepare("INSERT INTO video_submission_diagnostics (task_id,attempt,created_at,detail) VALUES (?,?,?,?)")
    .run(taskId, attempt, nowTs(), JSON.stringify(detail));
  console.warn("[video-queue] submission diagnostic", { taskId, attempt, ...detail });
}
