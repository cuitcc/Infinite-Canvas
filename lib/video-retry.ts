/** 只重试上游明确拒绝受理的请求；网络中断/网关超时可能已经创建任务。 */
export function canRetryVideoSubmission(status: number, code?: string): boolean {
  return status === 429 || (status === 503 && code === "video_queue_full");
}

export function videoBackoffMs(attempt: number, retryAfterMs = 0): number {
  return Math.max(Math.min(65_000 * 2 ** Math.max(0, attempt - 1), 300_000), retryAfterMs);
}
// 提交可能在上游排队后才返回 ID。保留有限等待，并让回收期限始终晚于请求截止时间。
export const VIDEO_SUBMIT_TIMEOUT_MS = 240_000;
export const VIDEO_SUBMIT_RECOVERY_GRACE_MS = 60_000;
