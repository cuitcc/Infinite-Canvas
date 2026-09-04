import { NextRequest, NextResponse } from "next/server";
import { EdgeTTS } from "node-edge-tts";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { updateNodeData, newId, nowTs, MEDIA_DIR, getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let nodeId = "";
  try {
    const body = await req.json();
    const { projectId, nodeId: reqNodeId, text, voice = "zh-CN-XiaoxiaoNeural" } = body as {
      projectId: string;
      nodeId?: string;
      text: string;
      voice?: string;
    };
    // nodeId 可选:编排器的台词锚定合成不挂节点,避免污染视频节点状态
    nodeId = reqNodeId ?? "";

    if (!text || !text.trim()) {
      return NextResponse.json({ error: "文本不能为空" }, { status: 400 });
    }

    if (nodeId) updateNodeData(nodeId, { status: "generating", error: undefined });

    const tts = new EdgeTTS({ voice, outputFormat: "audio-24khz-48kbitrate-mono-mp3" });
    const fileName = `audio-${randomUUID()}.mp3`;
    mkdirSync(MEDIA_DIR, { recursive: true });
    const filePath = path.join(MEDIA_DIR, fileName);

    const TTS_TIMEOUT_MS = 60_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("语音合成超时，请稍后重试")), TTS_TIMEOUT_MS)
    );
    await Promise.race([tts.ttsPromise(text.trim(), filePath), timeout]);

    const fileStat = await stat(filePath);
    const relativePath = path.relative(process.cwd(), filePath);
    const id = newId();

    getDb()
      .prepare("INSERT INTO media (id, type, remote_url, local_path, mime_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, "audio", null, relativePath, "audio/mpeg", fileStat.size, nowTs());

    if (nodeId) updateNodeData(nodeId, {
      status: "done",
      mediaId: id,
      remoteUrl: `/api/media/${id}`,
      updatedAt: nowTs(),
    });

    return NextResponse.json({ ok: true, mediaId: id, url: `/api/media/${id}` });
  } catch (error) {
    const message = (error as Error).message;
    if (nodeId) updateNodeData(nodeId, { status: "failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
