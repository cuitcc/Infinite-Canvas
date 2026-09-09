import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { getMediaById, getTimeline, getNodeData, EXPORT_DIR, newId, nowTs } from "@/lib/db";
import { buildSubtitleAss, parseDialogueLines, SUBTITLE_FONT_DIR } from "@/lib/subtitles";

const execFileAsync = promisify(execFile);

function resolveFfmpeg(): string {
  if (process.env.FFMPEG_BINARY_PATH && existsSync(process.env.FFMPEG_BINARY_PATH)) {
    return process.env.FFMPEG_BINARY_PATH;
  }
  const local = path.join(process.cwd(), "bin", "ffmpeg");
  if (existsSync(local)) return local;
  const npmBinary = path.join(process.cwd(), "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg");
  if (existsSync(npmBinary)) return npmBinary;
  return "ffmpeg";
}

interface ExportJob {
  id: string;
  status: "running" | "done" | "failed";
  progress: string;
  output?: string;
  error?: string;
  createdAt: number;
}

const jobs = new Map<string, ExportJob>();

export async function POST(req: NextRequest) {
  try {
    const { projectId, burnSubtitles } = await req.json() as { projectId: string; burnSubtitles?: boolean };
    const clips = getTimeline(projectId);
    if (clips.length === 0) {
      return NextResponse.json({ error: "时间线为空,请先添加视频片段" }, { status: 400 });
    }

    const mediaRecords = clips.map((c) => getMediaById(c.mediaId)).filter((m): m is NonNullable<typeof m> => Boolean(m));
    if (mediaRecords.length !== clips.length) {
      return NextResponse.json({ error: "部分片段媒体缺失,请重新生成" }, { status: 400 });
    }

    const jobId = newId();
    const job: ExportJob = { id: jobId, status: "running", progress: "准备中", createdAt: nowTs() };
    jobs.set(jobId, job);

    void runExport(job, clips, mediaRecords, burnSubtitles !== false);

    return NextResponse.json({ ok: true, jobId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

async function runExport(job: ExportJob, clips: Array<{ trimIn: number; trimOut: number | null; audioMediaId?: string; nodeId: string }>, media: Array<{ id: string; localPath?: string; mimeType?: string }>, burnSubtitles: boolean) {
  const ffmpeg = resolveFfmpeg();
  const workDir = path.join(EXPORT_DIR, job.id);
  mkdirSync(workDir, { recursive: true });

  try {
    const segFiles: string[] = [];
    for (let i = 0; i < media.length; i++) {
      job.progress = `转码片段 ${i + 1}/${media.length}`;
      const src = path.join(process.cwd(), media[i].localPath!);
      const seg = path.join(workDir, `seg-${String(i).padStart(3, "0")}.mp4`);
      const trimIn = Math.max(0, clips[i].trimIn || 0);
      const trimOut = clips[i].trimOut;

      const audioMediaId = clips[i].audioMediaId;
      const audioRecord = audioMediaId ? getMediaById(audioMediaId) : undefined;
      const hasAudio = Boolean(audioRecord?.localPath);

      // 烧录字幕:台词来自视频节点 data.dialogue(=分镜分配表逐字合同,即实际生成的人声)。
      // 行内时序按字数比例近似(模型直生人声无时间戳);输出侧 -ss 时间戳从 0 起,offset 传 0
      let subtitleFilter: string | null = null;
      if (burnSubtitles) {
        const nodeData = getNodeData(clips[i].nodeId);
        const lines = parseDialogueLines(nodeData?.dialogue as string | undefined);
        const trimmed = trimOut != null && trimOut > trimIn;
        const effDuration = trimmed ? trimOut! - trimIn : Number(nodeData?.seconds) || 0;
        if (lines.length && effDuration > 0.5) {
          const assFile = path.join(workDir, `sub-${String(i).padStart(3, "0")}.ass`);
          writeFileSync(assFile, buildSubtitleAss(lines, effDuration, 0));
          subtitleFilter = `subtitles=${assFile}:fontsdir=${SUBTITLE_FONT_DIR}`;
        }
      }

      const args: string[] = ["-y", "-i", src];
      if (hasAudio) {
        args.push("-i", path.join(process.cwd(), audioRecord!.localPath!));
      }
      if (trimIn > 0) args.push("-ss", String(trimIn));
      if (trimOut != null && trimOut > trimIn) args.push("-t", String(trimOut - trimIn));
      if (hasAudio) {
        args.push("-shortest", "-map", "0:v:0", "-map", "1:a:0");
      }
      const vf = subtitleFilter
        ? `scale=1152:768:force_original_aspect_ratio=decrease,pad=1152:768:(ow-iw)/2:(oh-ih)/2,${subtitleFilter}`
        : "scale=1152:768:force_original_aspect_ratio=decrease,pad=1152:768:(ow-iw)/2:(oh-ih)/2";
      args.push(
        "-vf", vf,
        "-r", "24",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-video_track_timescale", "600",
        seg,
      );
      await execFileAsync(ffmpeg, args, { timeout: 300_000 });
      segFiles.push(seg);
    }

    job.progress = "拼接成片";
    const listFile = path.join(workDir, "concat.txt");
    writeFileSync(listFile, segFiles.map((f) => `file '${f}'`).join("\n"));
    const outputFile = path.join(EXPORT_DIR, `${job.id}.mp4`);
    await execFileAsync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outputFile], { timeout: 300_000 });

    job.status = "done";
    job.progress = "完成";
    job.output = path.relative(process.cwd(), outputFile);
  } catch (error) {
    job.status = "failed";
    job.error = (error as Error).message;
  }
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "缺少 jobId" }, { status: 400 });
  const job = jobs.get(jobId);
  if (!job) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  return NextResponse.json({ id: job.id, status: job.status, progress: job.progress, output: job.output, error: job.error });
}
