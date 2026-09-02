import { TosClient } from "@volcengine/tos-sdk";
import { randomUUID } from "node:crypto";

const region = "cn-beijing";

export async function uploadImageToTos(file: File): Promise<string> {
  const bucket = requireEnv("TOS_BUCKET");
  const publicBaseUrl = requireEnv("TOS_PUBLIC_BASE_URL").replace(/\/$/, "");
  const key = `infinite-canvas/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${sanitizeFileName(file.name)}`;
  const body = Buffer.from(await file.arrayBuffer());

  await getClient().putObject({
    bucket,
    key,
    body,
    contentLength: body.length,
    contentType: file.type || "application/octet-stream",
  });

  return `${publicBaseUrl}/${key}`;
}

export async function uploadRemoteImageToTos(imageUrl: string, fileName = "generated.png"): Promise<string> {
  const response = await fetch(imageUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      "User-Agent": "Infinite-Canvas TOS saver",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`远端图片下载失败：${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("远端资源不是图片，无法保存到 TOS");
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) {
    throw new Error("远端图片内容为空");
  }

  return uploadBufferToTos(body, contentType, fileName);
}

export async function uploadBufferToTos(body: Buffer, contentType: string, fileName = "generated.png"): Promise<string> {
  if (body.length === 0) {
    throw new Error("图片内容为空");
  }

  const bucket = requireEnv("TOS_BUCKET");
  const publicBaseUrl = requireEnv("TOS_PUBLIC_BASE_URL").replace(/\/$/, "");
  const key = `infinite-canvas-generated/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${sanitizeFileName(fileName)}`;

  await getClient().putObject({
    bucket,
    key,
    body,
    contentLength: body.length,
    contentType,
  });

  return `${publicBaseUrl}/${key}`;
}

function getClient() {
  return new TosClient({
    region,
    endpoint: normalizeTosEndpoint(requireEnv("TOS_S3_ENDPOINT")),
    accessKeyId: requireEnv("TOS_ACCESS_KEY_ID"),
    accessKeySecret: requireEnv("TOS_SECRET_ACCESS_KEY"),
    connectionTimeout: 10_000,
    requestTimeout: 60_000,
  });
}

function normalizeTosEndpoint(endpoint: string) {
  return endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "input.png";
}

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`未配置 ${name}`);
  }

  return value;
}
