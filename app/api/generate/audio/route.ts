import { NextRequest, NextResponse } from "next/server";
import { EdgeTTS } from "node-edge-tts";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { updateNodeData, newId, nowTs, MEDIA_DIR, getDb } from "@/lib/db";
import { EDGE_TTS_VOICES, DEFAULT_EDGE_VOICE } from "@/lib/edge-tts-voices";

export const runtime = "nodejs";

/** TTS 只接收要念出的正文；角色名前缀、舞台动作和多余空白会显著降低对白自然度。 */
function prepareSpeech(text: string): string {
  return text
    .replace(/^[^\n：:]{1,24}[：:][ \t]*/gm, "")
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export async function POST(req: NextRequest) {
  let nodeId = "";
  try {
    const body = await req.json();
    const { projectId, nodeId: reqNodeId, text, voice = "zh-CN-XiaoxiaoNeural" } = body as {
      projectId: string;
      nodeId: string;
      text: string;
      voice?: string;
    };
    nodeId = reqNodeId;

    const speech = prepareSpeech(text || "");
    if (!speech) {
      return NextResponse.json({ error: "文本不能为空" }, { status: 400 });
    }

    const safeVoice = EDGE_TTS_VOICES.some((v) => v.id === voice) ? voice : DEFAULT_EDGE_VOICE;

    updateNodeData(nodeId, { status: "generating", error: undefined });

    // 略慢语速和标准音量让中文咬字更清楚，也给视频模型留出更稳定的口型节奏。
    const tts = new EdgeTTS({ voice: safeVoice, rate: "-6%", pitch: "+0Hz", volume: "+0%", outputFormat: "audio-24khz-48kbitrate-mono-mp3" });
    const fileName = `audio-${randomUUID()}.mp3`;
    mkdirSync(MEDIA_DIR, { recursive: true });
    const filePath = path.join(MEDIA_DIR, fileName);

    const TTS_TIMEOUT_MS = 60_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("语音合成超时，请稍后重试")), TTS_TIMEOUT_MS)
    );
    await Promise.race([tts.ttsPromise(speech, filePath), timeout]);

    const fileStat = await stat(filePath);
    const relativePath = path.relative(process.cwd(), filePath);
    const id = newId();

    getDb()
      .prepare("INSERT INTO media (id, type, remote_url, local_path, mime_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, "audio", null, relativePath, "audio/mpeg", fileStat.size, nowTs());

    updateNodeData(nodeId, {
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
