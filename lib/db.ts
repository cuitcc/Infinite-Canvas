import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const EXPORT_DIR = path.join(DATA_DIR, "exports");
export const DB_PATH = path.join(DATA_DIR, "canvas.db");

let dbInstance: import("better-sqlite3").Database | null = null;

export function getDb(): import("better-sqlite3").Database {
  if (dbInstance) return dbInstance;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '未命名项目',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      remote_url TEXT,
      local_path TEXT,
      mime_type TEXT,
      bytes INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timeline (
      project_id TEXT PRIMARY KEY,
      clips TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gen_tasks (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      agnes_task_id TEXT,
      remote_url TEXT,
      media_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_gen_tasks_status ON gen_tasks(status);
  `);
  dbInstance = db;
  // gen_tasks 迁移:多厂商模型路由字段
  const genCols = db.prepare("PRAGMA table_info(gen_tasks)").all() as Array<{ name: string }>;
  const genColNames = new Set(genCols.map((c) => c.name));
  if (!genColNames.has("provider_model")) {
    db.exec("ALTER TABLE gen_tasks ADD COLUMN provider_model TEXT");
  }
  if (!genColNames.has("provider_task_id")) {
    db.exec("ALTER TABLE gen_tasks ADD COLUMN provider_task_id TEXT");
  }
  return db;
}

export function nowTs() {
  return Date.now();
}

export function newId() {
  return randomUUID();
}

export interface NodeRow {
  id: string;
  project_id: string;
  position_x: number;
  position_y: number;
  data: string;
  created_at: number;
  updated_at: number;
}

export interface EdgeRow {
  id: string;
  project_id: string;
  source: string;
  target: string;
  data: string | null;
  created_at: number;
}

export interface MediaRecord {
  id: string;
  type: "image" | "video" | "audio";
  remoteUrl?: string;
  localPath?: string;
  mimeType?: string;
  bytes?: number;
  createdAt: number;
}

export interface TimelineClip {
  id: string;
  nodeId: string;
  mediaId: string;
  order: number;
  trimIn: number;
  trimOut: number | null;
  audioMediaId?: string;
}

export interface GenTaskRow {
  id: string;
  node_id: string;
  project_id: string;
  kind: "image" | "video";
  status: "queued" | "in_progress" | "completed" | "failed";
  agnes_task_id: string | null;
  remote_url: string | null;
  media_id: string | null;
  error: string | null;
  provider_model?: string | null;
  provider_task_id?: string | null;
  created_at: number;
  updated_at: number;
}

export function ensureDefaultProject(): { id: string; name: string } {
  const db = getDb();
  const existing = db.prepare("SELECT id, name FROM projects ORDER BY created_at ASC LIMIT 1").get() as { id: string; name: string } | undefined;
  if (existing) return existing;

  const id = newId();
  const ts = nowTs();
  db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, "我的画布", ts, ts);
  return { id, name: "我的画布" };
}

export function upsertNode(input: { id: string; projectId: string; position: { x: number; y: number }; data: Record<string, unknown> }) {
  const db = getDb();
  const ts = nowTs();
  db.prepare(`
    INSERT INTO nodes (id, project_id, position_x, position_y, data, created_at, updated_at)
    VALUES (@id, @projectId, @x, @y, @data, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET
      position_x = @x, position_y = @y, data = @data, updated_at = @ts
  `).run({ id: input.id, projectId: input.projectId, x: input.position.x, y: input.position.y, data: JSON.stringify(input.data), ts });
}

export function deleteNode(nodeId: string) {
  const db = getDb();
  db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  db.prepare("DELETE FROM edges WHERE source = ? OR target = ?").run(nodeId, nodeId);
}

export function upsertEdge(input: { id: string; projectId: string; source: string; target: string; data?: Record<string, unknown> | null }) {
  const db = getDb();
  const ts = nowTs();
  db.prepare(`
    INSERT INTO edges (id, project_id, source, target, data, created_at)
    VALUES (@id, @projectId, @source, @target, @data, @ts)
    ON CONFLICT(id) DO UPDATE SET source = @source, target = @target, data = @data
  `).run({
    id: input.id,
    projectId: input.projectId,
    source: input.source,
    target: input.target,
    data: input.data ? JSON.stringify(input.data) : null,
    ts,
  });
}

export function deleteEdge(edgeId: string) {
  getDb().prepare("DELETE FROM edges WHERE id = ?").run(edgeId);
}

export function getProjectGraph(projectId: string) {
  const db = getDb();
  const project = db.prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId) as { id: string; name: string } | undefined;
  if (!project) throw new Error(`项目不存在: ${projectId}`);

  const nodeRows = db.prepare("SELECT id, position_x, position_y, data FROM nodes WHERE project_id = ?").all(projectId) as Array<{ id: string; position_x: number; position_y: number; data: string }>;
  const edgeRows = db.prepare("SELECT id, source, target, data FROM edges WHERE project_id = ?").all(projectId) as Array<{ id: string; source: string; target: string; data: string | null }>;

  return {
    project,
    nodes: nodeRows.map(row => ({
      id: row.id,
      position: { x: row.position_x, y: row.position_y },
      data: JSON.parse(row.data) as Record<string, unknown>,
    })),
    edges: edgeRows.map(row => ({
      id: row.id,
      source: row.source,
      target: row.target,
      data: row.data ? JSON.parse(row.data) as Record<string, unknown> : undefined,
    })),
  };
}

export function saveProjectGraph(
  projectId: string,
  graph: {
    nodes: Array<{ id: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
    edges: Array<{ id: string; source: string; target: string; data?: Record<string, unknown> | null }>;
    deletedNodeIds?: string[];
    deletedEdgeIds?: string[];
  }
) {
  const db = getDb();
  const ts = nowTs();
  db.transaction(() => {
    for (const n of graph.deletedNodeIds ?? []) deleteNode(n);
    for (const e of graph.deletedEdgeIds ?? []) deleteEdge(e);
    // 同步删除:payload 中不存在的节点/边视为已删除(前端删除后自动保存场景)
    const keepNodeIds = new Set(graph.nodes.map((n) => n.id));
    const keepEdgeIds = new Set(graph.edges.map((e) => e.id));
    const staleNodes = db.prepare("SELECT id FROM nodes WHERE project_id = ?").all(projectId) as Array<{ id: string }>;
    for (const row of staleNodes) if (!keepNodeIds.has(row.id)) deleteNode(row.id);
    const staleEdges = db.prepare("SELECT id FROM edges WHERE project_id = ?").all(projectId) as Array<{ id: string }>;
    for (const row of staleEdges) if (!keepEdgeIds.has(row.id)) deleteEdge(row.id);
    for (const node of graph.nodes) upsertNode({ ...node, projectId });
    for (const edge of graph.edges) upsertEdge({ ...edge, projectId });
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(ts, projectId);
  })();
}

export async function saveRemoteMedia(type: "image" | "video", url: string): Promise<MediaRecord> {
  mkdirSync(MEDIA_DIR, { recursive: true });

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`媒体下载失败: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  const ext = contentType.includes("video") ? ".mp4" : ".png";
  const id = newId();
  const fileName = `${type}-${id}${ext}`;
  const filePath = path.join(MEDIA_DIR, fileName);

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(filePath, buffer);

  const record: MediaRecord = {
    id,
    type,
    remoteUrl: url,
    localPath: path.relative(process.cwd(), filePath),
    mimeType: contentType,
    bytes: buffer.length,
    createdAt: nowTs(),
  };

  getDb().prepare("INSERT INTO media (id, type, remote_url, local_path, mime_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(record.id, record.type, record.remoteUrl ?? null, record.localPath ?? null, record.mimeType ?? null, record.bytes ?? null, record.createdAt);
  return record;
}

export function getMediaById(id: string): MediaRecord | undefined {
  const row = getDb().prepare("SELECT id, type, remote_url, local_path, mime_type, bytes, created_at FROM media WHERE id = ?").get(id) as {
    id: string; type: "image" | "video" | "audio"; remote_url: string | null; local_path: string | null; mime_type: string | null; bytes: number | null; created_at: number;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    remoteUrl: row.remote_url ?? undefined,
    localPath: row.local_path ?? undefined,
    mimeType: row.mime_type ?? undefined,
    bytes: row.bytes ?? undefined,
    createdAt: row.created_at,
  };
}

export function getTimeline(projectId: string): TimelineClip[] {
  const row = getDb().prepare("SELECT clips FROM timeline WHERE project_id = ?").get(projectId) as { clips: string } | undefined;
  return row ? JSON.parse(row.clips) as TimelineClip[] : [];
}

export function saveTimeline(projectId: string, clips: TimelineClip[]) {
  const db = getDb();
  const ts = nowTs();
  db.prepare(`
    INSERT INTO timeline (project_id, clips, updated_at)
    VALUES (@projectId, @clips, @ts)
    ON CONFLICT(project_id) DO UPDATE SET clips = @clips, updated_at = @ts
  `).run({ projectId, clips: JSON.stringify(clips ?? []), ts });
}

export function upsertGenTask(task: Omit<GenTaskRow, "created_at" | "updated_at"> & { created_at?: number; updated_at?: number; provider_model?: string | null; provider_task_id?: string | null }): GenTaskRow {
  const db = getDb();
  const ts = nowTs();
  const created = task.created_at ?? ts;
  const updated = task.updated_at ?? ts;
  db.prepare(`
    INSERT INTO gen_tasks (id, node_id, project_id, kind, status, agnes_task_id, remote_url, media_id, error, created_at, updated_at, provider_model, provider_task_id)
    VALUES (@id, @node_id, @project_id, @kind, @status, @agnes_task_id, @remote_url, @media_id, @error, @created_at, @updated_at, @provider_model, @provider_task_id)
    ON CONFLICT(id) DO UPDATE SET
      status = @status, agnes_task_id = @agnes_task_id, remote_url = @remote_url, media_id = @media_id, error = @error, updated_at = @updated_at, provider_model = @provider_model, provider_task_id = @provider_task_id
  `).run({
    id: task.id,
    node_id: task.node_id,
    project_id: task.project_id,
    kind: task.kind,
    status: task.status,
    agnes_task_id: task.agnes_task_id ?? null,
    remote_url: task.remote_url ?? null,
    media_id: task.media_id ?? null,
    error: task.error ?? null,
    created_at: created,
    updated_at: updated,
    provider_model: (task as { provider_model?: string | null }).provider_model ?? null,
    provider_task_id: (task as { provider_task_id?: string | null }).provider_task_id ?? null,
  });
  return { ...task, created_at: created, updated_at: updated } as GenTaskRow;
}

export function getPendingGenTasks(): GenTaskRow[] {
  return getDb().prepare("SELECT * FROM gen_tasks WHERE status IN ('queued','in_progress') ORDER BY created_at ASC").all() as GenTaskRow[];
}

export function getGenTasksForProject(projectId: string): GenTaskRow[] {
  return getDb().prepare("SELECT * FROM gen_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").all(projectId) as GenTaskRow[];
}

export function updateNodeData(nodeId: string, dataPatch: Record<string, unknown>) {
  const db = getDb();
  const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(nodeId) as { data: string } | undefined;
  if (!row) return;
  const merged = { ...JSON.parse(row.data), ...dataPatch };
  db.prepare("UPDATE nodes SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), nowTs(), nodeId);
}
