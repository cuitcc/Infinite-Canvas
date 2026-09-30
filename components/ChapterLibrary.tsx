"use client";

import { useState } from "react";
import { useCanvasStore } from "@/lib/store";
import { importNovelChapters, startChapter } from "@/lib/agent-orchestrator";
import { readNovelFiles } from "@/lib/agent-story";

export function NovelInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  return <div className="space-y-2">
    <textarea aria-label="小说正文" rows={7} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={"粘贴小说章节，可一次多章：\n第一章 雨夜来客\n小说正文……\n第二章 消失的信\n小说正文……"}
      className="w-full resize-y rounded border border-slate-200 bg-white px-3 py-2 text-sm" />
    <label className="block text-xs text-violet-700">{reading ? "正在读取…" : "上传章节文件（TXT / Markdown，可多选）"}
      <input aria-label="上传小说章节" type="file" accept=".txt,.md,text/plain,text/markdown" multiple disabled={reading}
        className="mt-1 block w-full text-xs text-slate-500" onChange={async (e) => {
          const files = Array.from(e.target.files ?? []); e.target.value = "";
          setReading(true); setError("");
          try { const text = await readNovelFiles(files); if (text) onChange(value ? `${value}\n\n${text}` : text); }
          catch (e) { setError((e as Error).message); }
          finally { setReading(false); }
        }} />
    </label>
    <p className="text-[11px] text-slate-500">按“第X章”或“Chapter N”标题拆章；无标题按一章导入。支持 UTF-8 / GB18030 文本，每章最多3万字，较长章节请分段。</p>
    {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
  </div>;
}

const labels = { planned: "待制作", writing: "写作中", ready: "待选风格", running: "制作中", done: "已完成", partial: "待继续 / 有缺镜", failed: "失败" };
export function ChapterLibrary() {
  const state = useCanvasStore((s) => s.agentState);
  const [source, setSource] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  if (!state?.story) return null;
  const story = state.story;
  const busy = !["idle", "done", "aborted", "style"].includes(state.stage);
  const next = story.chapters.find((c) => c.status === "planned");
  return <section className="space-y-3 border-b border-slate-200 bg-slate-50 p-4">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{story.title}</h2><span className="text-xs text-violet-600">{story.mode === "novel" ? "小说改编" : "原创长篇"} · {story.chapters.length}章</span></div>
    <details><summary className="cursor-pointer text-xs text-slate-600">故事主线与结局方向</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-5">{story.mainline}</p><p className="mt-1 text-xs text-slate-500">{story.ending}</p></details>
    <p className="text-[11px] text-slate-500">共享资产 {state.assets.length} 项 · 每幕一章，按章制作并追加到同一时间线</p>
    <div className="max-h-72 space-y-2 overflow-y-auto">
      {story.chapters.map((chapter) => <details key={chapter.id} className={`rounded border p-2 ${state.activeChapterId === chapter.id ? "border-violet-300 bg-violet-50" : "border-slate-200 bg-white"}`}>
        <summary className="cursor-pointer text-xs"><span className="font-medium">{chapter.number}. {chapter.title}</span><span className="ml-2 text-slate-500">{labels[chapter.status]} · {chapter.shots.filter((s) => s.status === "done").length}/{chapter.shots.length}镜</span></summary>
        <p className="mt-2 text-xs leading-5 text-slate-600">{chapter.goal}</p>
        {chapter.outline && <details className="mt-2"><summary className="cursor-pointer text-xs text-violet-700">查看章节剧本</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5">{chapter.outline.script}</pre></details>}
        {chapter.sourceText && <details className="mt-2"><summary className="cursor-pointer text-xs text-slate-500">查看小说原文</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5">{chapter.sourceText}</pre></details>}
        {chapter.error && <p className="mt-2 text-xs text-rose-600">{chapter.error}</p>}
        {chapter.status !== "done" && <button disabled={busy || importing || story.chapters.some((c) => c.number < chapter.number && !c.outline)}
          onClick={() => void startChapter(chapter.id)} className="mt-2 rounded bg-violet-600 px-3 py-1.5 text-xs text-white disabled:bg-slate-300">{chapter.outline ? "继续本章" : "制作本章"}</button>}
      </details>)}
    </div>
    {!busy && next && <button onClick={() => void startChapter(next.id)} disabled={importing} className="w-full rounded bg-violet-600 py-2 text-xs text-white disabled:bg-slate-300">制作下一章：{next.title}</button>}
    {story.mode === "novel" && <>
      <button disabled={busy || importing} onClick={() => setShowImport(!showImport)} className="w-full rounded border border-violet-300 py-2 text-xs text-violet-700 disabled:text-slate-400">添加小说新章节</button>
      {showImport && <div className="space-y-2"><NovelInput value={source} onChange={setSource} /><button disabled={busy || importing || !source.trim()} className="w-full rounded bg-violet-600 py-2 text-xs text-white disabled:bg-slate-300" onClick={async () => {
        setImporting(true); setMessage("");
        try { await importNovelChapters(source); setSource(""); setMessage("新章节已保存，制作时将复用原有资产并补充新人物和场景"); }
        catch (e) { setMessage((e as Error).message); }
        finally { setImporting(false); }
      }}>{importing ? "保存中…" : "保存新章节"}</button></div>}
      {message && <p role="status" className="text-xs text-slate-600">{message}</p>}
    </>}
  </section>;
}
