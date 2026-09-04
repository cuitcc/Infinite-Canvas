"use client";

import { useEffect, useRef } from "react";

interface Props {
  title: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

/** 节点文本框的悬浮大编辑器：点击节点内的小文本框弹出,改动实时写回节点数据 */
export function TextEditorModal({ title, value, onChange, onClose }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // 光标置于末尾,方便接着已有内容继续编辑
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-6" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-700">{title}</span>
          <span className="text-[10px] text-slate-400">编辑实时保存 · Esc 或点外部关闭</span>
          <span className="ml-auto text-[10px] text-slate-400">{value.length} 字</span>
        </div>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={16}
          className="w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-700 outline-none focus:border-violet-400"
        />
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded-md bg-violet-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-violet-600">
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
