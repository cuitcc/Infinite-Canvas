"use client";

import { useState } from "react";
import { useCanvasStore, type AgentStage } from "@/lib/store";
import { STYLE_LIBRARY, STYLE_CATEGORIES, type StyleEntry } from "@/lib/style-library";
import { runAgent, chooseStyle, abortAgent, continueAgent } from "@/lib/agent-orchestrator";
import { remainingScriptLines } from "@/lib/dialogue-plan";
import { AGNES_VIDEO_SECONDS } from "@/lib/agnes-video";

// 六个阶段的顺序与标签
const STEPS: { key: AgentStage; label: string; num: string }[] = [
  { key: "outline", label: "剧本大纲", num: "①" },
  { key: "style", label: "风格选择", num: "②" },
  { key: "assets", label: "资产生成", num: "③" },
  { key: "storyboard", label: "分镜脚本", num: "④" },
  { key: "shots", label: "分镜视频", num: "⑤" },
  { key: "assembly", label: "剪辑成片", num: "⑥" },
];

// 阶段顺序索引，用于比较先后
const STAGE_ORDER: Record<AgentStage, number> = {
  idle: -1,
  outline: 0,
  style: 1,
  assets: 2,
  storyboard: 3,
  shots: 4,
  assembly: 5,
  done: 6,
  aborted: -1,
};

type StepStatus = "pending" | "running" | "done" | "error";

function getStepStatus(
  stepKey: AgentStage,
  current: AgentStage,
  hasError: boolean,
  abortedFrom?: AgentStage,
): StepStatus {
  const stepIdx = STAGE_ORDER[stepKey];

  if (current === "aborted") {
    // 用 abortedFrom 判断中止发生在哪一步；无值时回退到全 pending（旧行为）
    const fromIdx = abortedFrom ? STAGE_ORDER[abortedFrom] : -1;
    if (fromIdx < 0) return "pending";
    if (stepIdx < fromIdx) return "done";
    if (stepIdx === fromIdx) return "error";
    return "pending";
  }

  const curIdx = STAGE_ORDER[current];
  if (stepIdx < curIdx) return "done";
  if (stepIdx === curIdx) return hasError ? "error" : "running";
  return "pending";
}

function StatusIcon({ status }: { status: StepStatus }) {
  const iconMap: Record<StepStatus, { char: string; color: string }> = {
    pending: { char: "○", color: "text-slate-300" },
    running: { char: "◐", color: "text-sky-500" },
    done: { char: "✓", color: "text-emerald-500" },
    error: { char: "✗", color: "text-rose-500" },
  };
  const { char, color } = iconMap[status];
  return <span className={`text-sm ${color}`}>{char}</span>;
}

interface Props {
  onClose: () => void;
}

export function AgentPanel({ onClose }: Props) {
  const agentState = useCanvasStore((s) => s.agentState);
  const [theme, setTheme] = useState("");
  const [shotCount, setShotCount] = useState(8);
  const [shotSeconds, setShotSeconds] = useState("10");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [category, setCategory] = useState<"all" | "2d" | "3d" | "real">("all");
  const [customOpen, setCustomOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");

  const stage = agentState?.stage ?? "idle";
  const error = agentState?.error ?? null;
  const isRunning = !["idle", "aborted", "done"].includes(stage);

  const filteredStyles = category === "all"
    ? STYLE_LIBRARY
    : STYLE_LIBRARY.filter((s) => s.category === category);

  const handleStart = () => {
    if (!theme.trim()) return;
    void runAgent(theme.trim(), shotCount, aspectRatio, shotSeconds);
  };

  const handleChooseStyle = (name: string, prompt: string) => {
    void chooseStyle(name, prompt);
  };

  const handleCustomConfirm = () => {
    if (!customPrompt.trim()) return;
    void chooseStyle("自定义风格", customPrompt.trim());
    setCustomOpen(false);
    setCustomPrompt("");
  };

  const handleAbort = () => {
    abortAgent();
  };

  const handleRestart = () => {
    // 完整重置 agentState 到初始值，避免上一轮残留（assets/shots/styleName/stylePrompt/outlineJson/abortedFrom 等）
    useCanvasStore.getState().setAgentState({
      stage: "idle",
      theme: "",
      shotCount: 8,
      shotSeconds: "10",
      aspectRatio: "9:16",
      styleName: "",
      stylePrompt: "",
      outlineNodeId: null,
      outlineJson: null,
      assets: [],
      shots: [],
      error: null,
      abortedFrom: undefined,
    });
    setTheme("");
  };

  // 资产阶段计数
  const totalAssets = agentState?.assets.length ?? 0;
  const doneAssets = agentState?.assets.filter((a) => a.status === "done").length ?? 0;

  // 分镜阶段计数
  const totalShots = agentState?.shots.length ?? 0;
  const doneShots = agentState?.shots.filter((s) => s.status === "done").length ?? 0;

  return (
    <aside className="fixed right-0 top-0 z-50 flex h-full w-[400px] flex-col border-l border-slate-200 bg-white shadow-xl">
      {/* 顶部标题栏 */}
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <span className="text-sm font-semibold text-slate-800">🎬 短剧 Agent</span>
        <span className="text-[10px] text-slate-400">一键生成短剧</span>
        <button onClick={onClose} className="ml-auto px-1 text-xs text-slate-400 hover:text-slate-600">
          ✕
        </button>
      </div>

      {/* 主体内容区 */}
      <div className="flex-1 overflow-y-auto">
        {/* idle 态：表单 */}
        {stage === "idle" && (
          <div className="space-y-4 p-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">短剧主题</label>
              <textarea
                rows={4}
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                placeholder="输入短剧主题或剧本…"
                className="w-full resize-none rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-sky-400"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">分镜数</label>
                <select
                  value={shotCount}
                  onChange={(e) => setShotCount(Number(e.target.value))}
                  className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700"
                >
                  {[4, 6, 8, 12, 16].map((n) => (
                    <option key={n} value={n}>{n} 镜</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">每镜秒数</label>
                <select
                  value={shotSeconds}
                  onChange={(e) => setShotSeconds(e.target.value)}
                  className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700"
                >
                  {AGNES_VIDEO_SECONDS.map((s) => (
                    <option key={s} value={s}>{s} 秒</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">画面比例</label>
                <select
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                  className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700"
                >
                  <option value="9:16">9:16 竖屏</option>
                  <option value="16:9">16:9 横屏</option>
                </select>
              </div>
            </div>
            <button
              onClick={handleStart}
              disabled={!theme.trim()}
              className="w-full rounded-md bg-violet-500 py-2 text-sm font-medium text-white hover:bg-violet-600 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              开始制作
            </button>
          </div>
        )}

        {/* 运行 / 中止阶段：进度列表 + 阶段特有内容 */}
        {(isRunning || stage === "aborted") && (
          <div className="space-y-4 p-4">
            {/* 进度步骤 */}
            <div className="space-y-2">
              {STEPS.map((step) => {
                const status = getStepStatus(step.key, stage, !!error, agentState?.abortedFrom);
                const showCount = step.key === "assets" && totalAssets > 0
                  ? `${doneAssets}/${totalAssets}`
                  : step.key === "shots" && totalShots > 0
                    ? `${doneShots}/${totalShots}`
                    : null;
                return (
                  <div key={step.key} className="flex items-center gap-3">
                    <StatusIcon status={status} />
                    <span className="text-xs font-medium text-slate-500">{step.num}</span>
                    <span className={`text-sm ${status === "done" ? "text-slate-700" : status === "running" ? "text-slate-800 font-medium" : status === "error" ? "text-rose-500" : "text-slate-400"}`}>
                      {step.label}
                    </span>
                    {showCount && (
                      <span className="ml-auto text-[11px] text-slate-400">{showCount}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 中止提示卡 */}
            {stage === "aborted" && (
              <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-center">
                <span className="text-2xl">⏹</span>
                <p className="text-sm font-medium text-amber-700">已中止</p>
                <button
                  onClick={handleRestart}
                  className="rounded-md bg-violet-500 px-4 py-2 text-sm font-medium text-white hover:bg-violet-600"
                >
                  重新开始
                </button>
              </div>
            )}

            {/* style 阶段：风格库 */}
            {stage === "style" && (
              <div className="border-t border-slate-100 pt-4">
                <p className="mb-3 text-xs font-medium text-slate-600">选择画面风格</p>

                {/* 分类页签 */}
                <div className="mb-3 flex gap-1">
                  {STYLE_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      onClick={() => setCategory(cat.key as typeof category)}
                      className={`rounded px-2.5 py-1 text-[11px] font-medium ${
                        category === cat.key
                          ? "bg-violet-500 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>

                {/* 风格卡片网格 */}
                <div className="grid grid-cols-2 gap-3">
                  {filteredStyles.map((style) => (
                    <StyleCard
                      key={style.id}
                      style={style}
                      onClick={() => handleChooseStyle(style.name, style.prompt)}
                    />
                  ))}
                  {/* 自定义风格卡片 */}
                  <div
                    onClick={() => setCustomOpen((v) => !v)}
                    className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 p-3 hover:border-violet-300 hover:bg-violet-50"
                  >
                    <div className="flex h-16 w-full items-center justify-center text-2xl text-slate-300">
                      +
                    </div>
                    <p className="mt-1 text-xs font-medium text-slate-500">自定义风格</p>
                  </div>
                </div>

                {/* 自定义风格展开输入 */}
                {customOpen && (
                  <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50/50 p-3">
                    <textarea
                      rows={3}
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder="输入自定义风格描述…"
                      className="w-full resize-none rounded border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-violet-400"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        onClick={() => { setCustomOpen(false); setCustomPrompt(""); }}
                        className="rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleCustomConfirm}
                        disabled={!customPrompt.trim()}
                        className="rounded bg-violet-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-violet-600 disabled:bg-slate-300"
                      >
                        确定
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 错误提示 */}
            {error && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3">
                <p className="text-xs text-rose-500">⚠ {error}</p>
              </div>
            )}
          </div>
        )}

        {/* done 态 */}
        {stage === "done" && (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="text-4xl">✅</span>
            <p className="text-sm font-medium text-emerald-600">已填入时间线</p>
            <p className="text-xs text-slate-500">打开底部时间线，点「导出」生成成片</p>
            {(() => {
              // 续拍入口:剧本台词超出已拍容量时,可继续制作下一批(复用资产,镜号续接)
              const oj = agentState?.outlineJson;
              if (!oj) return null;
              const remaining = remainingScriptLines(
                oj.script,
                oj.characters.map((c) => c.name),
                agentState!.shotCount,
                Number(agentState!.shotSeconds) || 10,
              );
              if (!remaining.length) return null;
              return (
                <>
                  <p className="text-xs text-amber-600">剧本还有 {remaining.length} 句台词未拍完</p>
                  <button
                    onClick={() => void continueAgent()}
                    className="rounded-md bg-violet-500 px-4 py-2 text-sm font-medium text-white hover:bg-violet-600"
                  >
                    ▶ 继续制作下一批
                  </button>
                </>
              );
            })()}
            {error && <p className="text-xs text-rose-500">⚠ {error}</p>}
          </div>
        )}

      </div>

      {/* 底部按钮：运行态显示中止 */}
      {isRunning && stage !== "style" && (
        <div className="border-t border-slate-200 p-3">
          <button
            onClick={handleAbort}
            className="w-full rounded-md border border-rose-200 bg-white py-2 text-sm font-medium text-rose-500 hover:bg-rose-50"
          >
            中止
          </button>
        </div>
      )}
    </aside>
  );
}

function StyleCard({ style, onClick }: { style: StyleEntry; onClick: () => void }) {
  const [imgError, setImgError] = useState(false);

  return (
    <div
      onClick={onClick}
      className="cursor-pointer overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-md hover:ring-2 hover:ring-violet-200"
    >
      <div className="aspect-square w-full">
        {imgError ? (
          <div className="flex h-full w-full items-center justify-center bg-slate-100">
            <span className="text-xs text-slate-400">{style.name}</span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={style.thumb}
            alt={style.name}
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        )}
      </div>
      <div className="px-2 py-1.5 text-center">
        <p className="text-[11px] font-medium text-slate-700">{style.name}</p>
      </div>
    </div>
  );
}
