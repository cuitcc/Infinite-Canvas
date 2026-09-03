import { getDb, nowTs, newId } from "./db";

/** 协议类型:目前全部走 OpenAI 兼容协议(绝大多数国内厂商都兼容) */
export type ProviderProtocol = "openai-compatible";

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  protocol: ProviderProtocol;
  /** 该厂商下的模型列表:kind 决定出现在哪类节点的下拉里 */
  models: ProviderModel[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderModel {
  id: string;
  modelId: string;
  label: string;
  kind: "text" | "image" | "video";
  providerId: string;
  /** 视频模型:是否支持首帧图;图片模型:是否支持参考图 */
  capabilities?: string[];
}

const TABLE = "model_providers";

export function ensureProviderTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_env TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'openai-compatible',
      models TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function rowToProvider(row: {
  id: string; name: string; base_url: string; api_key_env: string; protocol: string; models: string; created_at: number; updated_at: number;
}): ModelProvider {
  const models = JSON.parse(row.models) as Array<Omit<ProviderModel, "providerId">>;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKeyEnv: row.api_key_env,
    protocol: "openai-compatible",
    models: models.map((m) => ({ ...m, providerId: row.id })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProviders(): ModelProvider[] {
  ensureProviderTable();
  const rows = getDb().prepare(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`).all() as Array<{
    id: string; name: string; base_url: string; api_key_env: string; protocol: string; models: string; created_at: number; updated_at: number;
  }>;
  return rows.map(rowToProvider);
}

export function getProvider(id: string): ModelProvider | undefined {
  ensureProviderTable();
  const row = getDb().prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id);
  return row ? rowToProvider(row as Parameters<typeof rowToProvider>[0]) : undefined;
}

/** 根据 "模型名" 找 provider+model(模型名全局唯一即可路由) */
export function resolveModel(modelName: string): { provider: ModelProvider; model: ProviderModel } | undefined {
  for (const p of listProviders()) {
    const m = p.models.find((x) => x.modelId === modelName);
    if (m) return { provider: p, model: m };
  }
  return undefined;
}

/** 通过环境变量读 API key,支持 ${ENV} 形式 */
export function providerApiKey(p: ModelProvider): string | undefined {
  const direct = process.env[p.apiKeyEnv];
  if (direct) return direct;
  const m = /^\$\{(.+)\}$/.exec(p.apiKeyEnv);
  if (m) return process.env[m[1]];
  return undefined;
}

export function upsertProvider(input: {
  id?: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  protocol?: ProviderProtocol;
  models: Array<Omit<ProviderModel, "providerId" | "id">>;
}): ModelProvider {
  ensureProviderTable();
  const db = getDb();
  const ts = nowTs();
  const id = input.id ?? newId();
  const dbModels = input.models.map((m, i) => ({ ...m, id: `${id}-m${i}` }));
  db.prepare(`
    INSERT INTO ${TABLE} (id, name, base_url, api_key_env, protocol, models, created_at, updated_at)
    VALUES (@id, @name, @baseUrl, @apiKeyEnv, @protocol, @models, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET
      name = @name, base_url = @baseUrl, api_key_env = @apiKeyEnv, protocol = @protocol, models = @models, updated_at = @ts
  `).run({
    id,
    name: input.name,
    baseUrl: input.baseUrl,
    apiKeyEnv: input.apiKeyEnv,
    protocol: input.protocol ?? "openai-compatible",
    models: JSON.stringify(dbModels),
    ts,
  });
  return getProvider(id)!;
}

export function deleteProvider(id: string) {
  ensureProviderTable();
  getDb().prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
}

const DEFAULT_AGNES_MODELS: Array<Omit<ProviderModel, "providerId" | "id">> = [
  { modelId: "agnes-video-2.5-flash", label: "Agnes Video 2.5 Flash", kind: "video", capabilities: ["first-frame", "reference"] },
  { modelId: "agnes-image-2.5-flash", label: "Agnes Image 2.5 Flash", kind: "image", capabilities: ["reference"] },
  { modelId: "agnes-2.5-flash", label: "Agnes Chat 2.5 Flash (快)", kind: "text" },
  { modelId: "agnes-2.5-pro", label: "Agnes Chat 2.5 Pro (强)", kind: "text" },
];

const DEFAULT_AGNES_PROVIDER = {
  name: "Agnes",
  baseUrl: "https://api.agnes-ai.cn/v1",
  apiKeyEnv: "AGNES_API_KEY",
  models: DEFAULT_AGNES_MODELS,
};

/** 预置 Agnes:首次启动插入,已存在则同步模型列表(保留用户修改的 baseUrl/apiKeyEnv) */
export function ensureDefaultProviders() {
  ensureProviderTable();
  const existing = listProviders();
  const agnes = existing.find((p) => p.name === "Agnes");

  if (agnes) {
    upsertProvider({
      id: agnes.id,
      name: agnes.name,
      baseUrl: agnes.baseUrl,
      apiKeyEnv: agnes.apiKeyEnv,
      models: DEFAULT_AGNES_PROVIDER.models,
    });
    return;
  }

  if (existing.length === 0) {
    upsertProvider(DEFAULT_AGNES_PROVIDER);
  }
}
