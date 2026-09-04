import { NextRequest, NextResponse } from "next/server";
import { buildAgnesVideoRequest, createAgnesVideo } from "@/lib/agnes-video";
import { genericVideoCreate } from "@/lib/generic-provider";
import { resolveModel } from "@/lib/model-registry";
import { getMediaById, updateNodeData, upsertGenTask, newId, nowTs } from "@/lib/db";
import { uploadBufferToTos } from "@/lib/tos";
import { downloadImageBuffer, resizeImageBuffer } from "@/lib/image-utils";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Agnes Image 输出的 4K 大图(常达十几 MB)Agnes Video reference/keyframe 模式无法处理,
 *  需要统一缩放到最大 1024px 后再传给 Agnes。 */
function isAgnesHostedImageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("agnes-ai") || host.includes("platform-outputs");
  } catch {
    return false;
  }
}

function extractMediaId(url: string): string | undefined {
  if (url.startsWith("/api/media/")) {
    return url.replace("/api/media/", "").split("?")[0];
  }
  return undefined;
}

async function fetchReferenceBuffer(url: string): Promise<Buffer> {
  const mediaId = extractMediaId(url);
  if (mediaId) {
    const record = getMediaById(mediaId);
    if (record?.localPath) {
      return readFileSync(path.join(process.cwd(), record.localPath));
    }
  }
  const { buffer } = await downloadImageBuffer(url);
  return buffer;
}

async function uploadResizedReference(url: string): Promise<string | undefined> {
  try {
    const buffer = await fetchReferenceBuffer(url);
    const resized = await resizeImageBuffer(buffer, 1024);
    return await uploadBufferToTos(resized, "image/png", "ref.png");
  } catch (error) {
    console.warn("[generate/video] failed to resize/upload reference, falling back to original", { url, error: (error as Error).message });
    return undefined;
  }
}

async function normalizeReferenceUrls(urls: string[]): Promise<string[]> {
  const normalized: string[] = [];
  for (const url of urls) {
    // Agnes 域名的参考图先缩放后转存,避免 4K 大图导致 Agnes Video 拒绝
    if (isAgnesHostedImageUrl(url)) {
      const resizedUrl = await uploadResizedReference(url);
      normalized.push(resizedUrl ?? url);
    } else {
      normalized.push(url);
    }
  }
  return normalized;
}

async function normalizeAudioUrls(urls: string[]): Promise<string[]> {
  const normalized: string[] = [];
  for (const url of urls) {
    const mediaId = extractMediaId(url);
    if (mediaId) {
      try {
        const record = getMediaById(mediaId);
        if (record?.localPath) {
          const buffer = readFileSync(path.join(process.cwd(), record.localPath));
          const publicUrl = await uploadBufferToTos(buffer, "audio/mpeg", "audio.mp3");
          normalized.push(publicUrl);
          continue;
        }
      } catch (error) {
        console.warn("[generate/video] failed to upload local audio to TOS, keeping original URL", { url, error: (error as Error).message });
      }
    }
    normalized.push(url);
  }
  return normalized;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { projectId, nodeId, prompt, image, referenceUrls = [], audioUrls = [], seconds, aspectRatio, negativePrompt, seed, model, size } = body as {
      projectId: string;
      nodeId: string;
      prompt: string;
      image?: string;
      referenceUrls?: string[];
      audioUrls?: string[];
      seconds?: string;
      aspectRatio?: string;
      negativePrompt?: string;
      seed?: number;
      model?: string;
      size?: string;
    };

    if (!prompt || !prompt.trim()) {
      return NextResponse.json({ error: "提示词不能为空" }, { status: 400 });
    }

    // 按模型路由:Agnes 走专用 SDK,其他厂商走 OpenAI 兼容通用层
    const resolved = model ? resolveModel(model) : undefined;
    const isAgnes = !resolved || resolved.provider.name === "Agnes";

    let images = referenceUrls.filter(Boolean);
    let agnesTaskId: string | null = null;
    let providerTaskId = "";
    let providerId = "";
    let modelName = model ?? "agnes-video-2.5-flash";

    if (isAgnes) {
      // Agnes Video 只有 reference 模式才接受 audios 字段;带音频参考(台词锚定)时强制走 reference,
      // 单张参考图也按 reference 传(避免 400),无参考图时仍拒绝
      const hasAudio = audioUrls.filter(Boolean).length > 0;
      const mode = images.length >= 2 || (hasAudio && images.length >= 1)
        ? "keyframes"
        : image || images.length === 1 ? "image" : "text";
      if (hasAudio && mode !== "keyframes") {
        return NextResponse.json(
          { error: "Agnes Video 仅在 reference 模式下支持音频参考，请添加参考图或移除音频连接" },
          { status: 400 }
        );
      }

      // Agnes Video reference/keyframe 模式对 Agnes Image 输出的 4K 大图兼容性差,先缩放转存到 TOS
      const mirrored = await normalizeReferenceUrls(images);
      if (mirrored.some((u, i) => u !== images[i])) {
        console.log("[generate/video] mirrored reference images", { original: images, mirrored });
      }
      images = mirrored;

      const audios = await normalizeAudioUrls(audioUrls.filter(Boolean));
      const input = {
        mode: mode as "text" | "image" | "keyframes",
        prompt: prompt.trim(),
        image: images.length === 1 ? images[0] : image,
        images: images.length >= 2 ? images : undefined,
        audios,
        seconds,
        aspect_ratio: aspectRatio,
        size,
        negative_prompt: negativePrompt,
        seed,
      };
      console.log("[generate/video] request", { nodeId, model: modelName, mode: input.mode, seconds: input.seconds, aspectRatio: input.aspect_ratio, referenceCount: images.length, referenceUrls: images, audioCount: audios.length });
      const task = await createAgnesVideo(buildAgnesVideoRequest(input, modelName));
      console.log("[generate/video] task created", { nodeId, agnesTaskId: task.id, model: task.model });
      agnesTaskId = task.id;
    } else {
      const genericTask = await genericVideoCreate({
        modelName: model!, prompt: prompt.trim(),
        referenceUrls: images, negativePrompt, seed,
      });
      providerTaskId = genericTask.providerTaskId;
      providerId = genericTask.providerId;
      modelName = genericTask.modelName;
    }

    const taskId = newId();
    upsertGenTask({
      id: taskId,
      node_id: nodeId,
      project_id: projectId,
      kind: "video",
      status: "in_progress",
      agnes_task_id: agnesTaskId,
      remote_url: null,
      media_id: null,
      error: null,
      provider_model: modelName,
      provider_task_id: isAgnes ? null : `${providerId}::${providerTaskId}`,
    });
    updateNodeData(nodeId, { status: "generating", error: undefined, updatedAt: nowTs() });

    return NextResponse.json({ ok: true, taskId, agnesTaskId, providerTaskId, providerId, model: modelName });
  } catch (error) {
    const message = (error as Error).message;
    try {
      const body2 = await req.json();
      if (body2?.nodeId) updateNodeData(body2.nodeId, { status: "failed", error: message });
    } catch { /* ignore */ }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
