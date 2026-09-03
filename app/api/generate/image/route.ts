import { NextRequest, NextResponse } from "next/server";
import { buildAgnesImageRequest, createAgnesImage, extractImageUrl } from "@/lib/agnes-image";
import { genericImageGenerate } from "@/lib/generic-provider";
import { resolveModel } from "@/lib/model-registry";
import { saveRemoteMedia, updateNodeData, upsertGenTask, newId, nowTs } from "@/lib/db";
import { closestRatio, getImageDimensions, simplifyRatio } from "@/lib/image-size";
import { SUPPORTED_IMAGE_RATIOS } from "@/lib/image-config";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { projectId, nodeId, prompt, size, ratio, negativePrompt, referenceUrls = [], model } = body as {
      projectId: string;
      nodeId: string;
      prompt: string;
      size?: string;
      ratio?: string;
      negativePrompt?: string;
      referenceUrls?: string[];
      model?: string;
    };

    if (!prompt || !prompt.trim()) {
      return NextResponse.json({ error: "提示词不能为空" }, { status: 400 });
    }

    updateNodeData(nodeId, { status: "generating", error: undefined });

    console.log("[generate/image] request", { nodeId, model, size, ratio, referenceCount: referenceUrls.length, negativePromptLength: negativePrompt?.length });

    let effectiveRatio = ratio;
    if (referenceUrls.length > 0) {
      const dims = await getImageDimensions(referenceUrls[0]);
      if (dims) {
        const computed = simplifyRatio(dims.width, dims.height);
        effectiveRatio = closestRatio(computed, SUPPORTED_IMAGE_RATIOS);
        console.log("[generate/image] reference detected", { referenceUrl: referenceUrls[0], width: dims.width, height: dims.height, computedRatio: computed, effectiveRatio });
      } else {
        console.log("[generate/image] reference dimensions unavailable, using user ratio", { ratio });
      }
    }

    // 按模型路由:Agnes 专用 SDK / 其他厂商通用层
    const resolved = model ? resolveModel(model) : undefined;
    let url: string;
    let mediaId: string;
    let usedModel = model ?? "agnes-image-2.5-flash";

    if (!resolved || resolved.provider.name === "Agnes") {
      usedModel = resolved?.model.modelId ?? "agnes-image-2.5-flash";
      const input = {
        mode: referenceUrls.length > 0 ? ("image" as const) : ("text" as const),
        prompt: prompt.trim(),
        size,
        ratio: effectiveRatio,
        negative_prompt: negativePrompt,
        imageUrls: referenceUrls,
      };
      const requestBody = buildAgnesImageRequest(input);
      const response = await createAgnesImage(requestBody);
      url = extractImageUrl(response) ?? "";
      if (!url) throw new Error("Agnes 未返回图片 URL");
      const media = await saveRemoteMedia("image", url);
      mediaId = media.id;
    } else {
      const result = await genericImageGenerate({ modelName: model!, prompt: prompt.trim(), size, referenceUrls });
      url = result.url;
      mediaId = result.mediaId;
    }

    console.log("[generate/image] completed", { nodeId, mediaId, url, model: usedModel, ratio: effectiveRatio });

    updateNodeData(nodeId, { status: "done", mediaId, remoteUrl: url, updatedAt: nowTs() });
    upsertGenTask({
      id: newId(),
      node_id: nodeId,
      project_id: projectId,
      kind: "image",
      status: "completed",
      agnes_task_id: null,
      remote_url: url,
      media_id: mediaId,
      error: null,
      provider_model: resolved && resolved.provider.name !== "Agnes" ? usedModel : null,
    });

    return NextResponse.json({ ok: true, mediaId, url, model: usedModel });
  } catch (error) {
    const message = (error as Error).message;
    try {
      const body = await req.json();
      if (body?.nodeId) updateNodeData(body.nodeId, { status: "failed", error: message });
    } catch { /* ignore */ }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
