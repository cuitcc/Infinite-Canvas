import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { getMediaById, getNodeData, getTimeline, EXPORT_DIR, newId, nowTs } from "@/lib/db";

const execFileAsync = promisify(execFile);

type ExportClip = { nodeId: string; mediaId: string; trimIn: number; trimOut: number | null; audioMediaId?: string };
type Media = { id: string; localPath?: string; mimeType?: string };
type Cue = { start: number; end: number; text: string };
type SegmentTiming = { duration?: number; leadingSilence?: number };

function resolveFfmpeg(): string {
  if (process.env.FFMPEG_BINARY_PATH && existsSync(process.env.FFMPEG_BINARY_PATH)) return process.env.FFMPEG_BINARY_PATH;
  const local = path.join(process.cwd(), "bin", "ffmpeg");
  if (existsSync(local)) return local;
  const npmBinary = path.join(process.cwd(), "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg");
  if (existsSync(npmBinary)) return npmBinary;
  return "ffmpeg";
}

interface ExportJob { id: string; status: "running" | "done" | "failed"; progress: string; output?: string; error?: string; createdAt: number }
const jobs = new Map<string, ExportJob>();

function dialogueLines(data: Record<string, unknown> | undefined): string[] {
  if (!data || typeof data.dialogue !== "string") return [];
  return data.dialogue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) =>
    wrapSubtitle(line.replace(/^[^：:]{1,40}[：:]/, "").replace(/["“”「」『』]/g, "").trim()),
  ).filter(Boolean);
}

/** 中文字幕按字符换行，避免长台词横向溢出；保留一条 cue 以维持对白时间。 */
function wrapSubtitle(text: string, maxChars = 18): string {
  const chars = Array.from(text); const rows: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) rows.push(chars.slice(i, i + maxChars).join(""));
  return rows.join("\n");
}

function timestamp(value: number): string {
  const ms = Math.max(0, Math.round(value * 1000));
  const h = Math.floor(ms / 3_600_000); const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000); const rest = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(rest).padStart(3, "0")}`;
}

function buildCues(clips: ExportClip[], timings: SegmentTiming[] = []): Cue[] {
  let cursor = 0; const cues: Cue[] = [];
  for (const [index, clip] of clips.entries()) {
    const data = getNodeData(clip.nodeId);
    const lines = dialogueLines(data);
    const configured = Number(data?.seconds);
    const fallbackDuration = clip.trimOut != null && clip.trimOut > clip.trimIn ? clip.trimOut - clip.trimIn : (Number.isFinite(configured) && configured > 0 ? configured : 4);
    const probedDuration = timings[index]?.duration;
    const clipDuration = Number.isFinite(probedDuration) && (probedDuration ?? 0) > 0 ? probedDuration! : fallbackDuration;
    // 模型有时会把环境底噪或第一个音节当成非静音，未检测到片头静默时仍保留小幅安全前置。
    const leadIn = lines.length
      ? Math.min(Math.max(0, timings[index]?.leadingSilence ?? 0.22), Math.max(0, clipDuration - 0.35))
      : 0;
    const totalChars = lines.reduce((n, line) => n + Math.max(1, line.replace(/[\s，。！？、,.!?]/g, "").length), 0);
    const gap = lines.length > 1 ? 0.12 : 0;
    const usable = Math.max(0.35, clipDuration - leadIn - gap * Math.max(0, lines.length - 1));
    let offset = 0;
    for (const line of lines) {
      const weight = Math.max(1, line.replace(/[\s，。！？、,.!?]/g, "").length) / Math.max(1, totalChars);
      const span = lines.length === 1 ? usable : Math.max(0.55, usable * weight);
      const start = cursor + leadIn + offset; const end = Math.min(cursor + clipDuration, start + span);
      if (end > start + 0.15) cues.push({ start, end, text: line });
      offset += span + 0.12;
    }
    cursor += clipDuration;
  }
  return cues;
}

/** 从已转码片段读取真实时长和开头静默，避免字幕按计划秒数累计漂移并提前出现。 */
async function probeSegmentTiming(ffmpeg: string, file: string): Promise<SegmentTiming> {
  try {
    const { stderr } = await execFileAsync(ffmpeg, [
      "-hide_banner", "-i", file,
      "-af", "silencedetect=noise=-35dB:d=0.12",
      "-f", "null", "-",
    ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    const duration = durationMatch
      ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
      : undefined;
    const firstStart = /silence_start:\s*([0-9.]+)/.exec(stderr);
    let leadingSilence: number | undefined;
    if (firstStart && Number(firstStart[1]) <= 0.01) {
      const tail = stderr.slice((firstStart.index ?? 0) + firstStart[0].length);
      const end = /silence_end:\s*([0-9.]+)/.exec(tail);
      if (end) leadingSilence = Number(end[1]);
    }
    return { duration, leadingSilence };
  } catch {
    // 无音轨片段会让 silencedetect 返回非零，但不应阻塞导出；调用方回退到计划时长。
    return {};
  }
}

function writeSrt(cues: Cue[], file: string) {
  writeFileSync(file, cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`).join("\n"), "utf8");
}

function subtitleFilter(file: string): string {
  // FFmpeg's subtitles filter treats ':' as an option separator; escape the absolute path.
  const safe = file.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return `subtitles=${safe}:fontsdir=/usr/share/fonts/opentype/noto:force_style='FontName=Noto Sans CJK SC\\,FontSize=16\\,PrimaryColour=&H00FFFFFF\\,OutlineColour=&H90000000\\,BorderStyle=1\\,Outline=1\\,Shadow=0\\,Alignment=2\\,MarginV=28'`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { projectId?: string; subtitles?: boolean };
    if (!body.projectId) return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
    const clips = getTimeline(body.projectId) as ExportClip[];
    if (!clips.length) return NextResponse.json({ error: "时间线为空,请先添加视频片段" }, { status: 400 });
    const mediaRecords = clips.map((c) => getMediaById(c.mediaId)).filter((m): m is NonNullable<typeof m> => Boolean(m));
    if (mediaRecords.length !== clips.length) return NextResponse.json({ error: "部分片段媒体缺失,请重新生成" }, { status: 400 });
    const jobId = newId(); const job: ExportJob = { id: jobId, status: "running", progress: "准备中", createdAt: nowTs() }; jobs.set(jobId, job);
    void runExport(job, clips, mediaRecords, body.subtitles !== false);
    return NextResponse.json({ ok: true, jobId, subtitles: body.subtitles !== false });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
}

async function runExport(job: ExportJob, clips: ExportClip[], media: Media[], includeSubtitles: boolean) {
  const ffmpeg = resolveFfmpeg(); const workDir = path.join(EXPORT_DIR, job.id); mkdirSync(workDir, { recursive: true });
  try {
    const segFiles: string[] = [];
    const segmentTimings: SegmentTiming[] = [];
    for (let i = 0; i < media.length; i++) {
      job.progress = `转码片段 ${i + 1}/${media.length}`;
      const localPath = media[i].localPath;
      if (!localPath) throw new Error(`片段 ${i + 1} 缺少本地媒体文件`);
      const src = path.join(process.cwd(), localPath); const seg = path.join(workDir, `seg-${String(i).padStart(3, "0")}.mp4`);
      const clip = clips[i]; const trimIn = Math.max(0, clip.trimIn || 0); const trimOut = clip.trimOut;
      const audioRecord = clip.audioMediaId ? getMediaById(clip.audioMediaId) : undefined; const hasAudio = Boolean(audioRecord?.localPath);
      const args: string[] = ["-y", "-i", src];
      if (hasAudio) args.push("-i", path.join(process.cwd(), audioRecord!.localPath!));
      if (trimIn > 0) args.push("-ss", String(trimIn));
      if (trimOut != null && trimOut > trimIn) args.push("-t", String(trimOut - trimIn));
      if (hasAudio) args.push("-map", "0:v:0", "-map", "1:a:0", "-af", "apad=pad_dur=6", "-shortest");
      args.push("-vf", "scale=1152:768:force_original_aspect_ratio=decrease,pad=1152:768:(ow-iw)/2:(oh-ih)/2", "-r", "24",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-video_track_timescale", "600", seg);
      await execFileAsync(ffmpeg, args, { timeout: 300_000 });
      segFiles.push(seg);
      segmentTimings.push(await probeSegmentTiming(ffmpeg, seg));
    }
    job.progress = includeSubtitles ? "生成字幕并合成成片" : "拼接成片";
    const listFile = path.join(workDir, "concat.txt"); writeFileSync(listFile, segFiles.map((f) => `file '${f}'`).join("\n"));
    const concatFile = path.join(workDir, "joined.mp4");
    await execFileAsync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatFile], { timeout: 300_000 });
    const outputFile = path.join(EXPORT_DIR, `${job.id}.mp4`);
    if (includeSubtitles) {
      const cues = buildCues(clips, segmentTimings);
      if (cues.length) {
        const srt = path.join(workDir, "captions.srt"); writeSrt(cues, srt);
        await execFileAsync(ffmpeg, ["-y", "-i", concatFile, "-vf", subtitleFilter(srt), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputFile], { timeout: 300_000 });
      } else {
        await execFileAsync(ffmpeg, ["-y", "-i", concatFile, "-c", "copy", outputFile], { timeout: 300_000 });
      }
    } else {
      await execFileAsync(ffmpeg, ["-y", "-i", concatFile, "-c", "copy", outputFile], { timeout: 300_000 });
    }
    job.status = "done"; job.progress = includeSubtitles ? "完成（已烧录字幕）" : "完成"; job.output = path.relative(process.cwd(), outputFile);
  } catch (error) { job.status = "failed"; job.error = (error as Error).message; }
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId"); if (!jobId) return NextResponse.json({ error: "缺少 jobId" }, { status: 400 });
  const job = jobs.get(jobId); if (!job) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  return NextResponse.json({ id: job.id, status: job.status, progress: job.progress, output: job.output, error: job.error });
}
