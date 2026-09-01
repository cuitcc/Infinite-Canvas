"use client";

import { useCallback, useState } from "react";
import { useCanvasStore } from "@/lib/store";

/** 提取台词到视频节点:本节点提示词为空时回退上游节点(与生成链路取值一致) */
export function useDialogueExtract(nodeId: string) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const extract = useCallback(async () => {
    const s = useCanvasStore.getState();
    const node = s.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    let text = node.data.prompt ?? "";
    if (!text.trim()) {
      // 与生成链路一致:按连线顺序取第一个有提示词的上游节点,不限节点类型
      const upstreamText = s.edges
        .filter((e) => e.target === nodeId)
        .map((e) => s.nodes.find((n) => n.id === e.source))
        .find((n) => n && (n.data.prompt ?? "").trim())
        ?.data.prompt;
      text = upstreamText ?? "";
    }
    if (!text.trim()) {
      setError("没有可用提示词,请先填写提示词或从有提示词的节点连线");
      return;
    }
    setExtracting(true);
    setError(undefined);
    try {
      const res = await fetch("/api/text/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, action: "extract-dialogue", model: node.data.textModel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "提取失败");
      const result = String(json.result ?? "").trim();
      if (!result) throw new Error("未从提示词中提取到台词");
      updateNodeData(nodeId, { dialogue: result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [nodeId, updateNodeData]);

  return { extract, extracting, error, clearError: useCallback(() => setError(undefined), []) };
}