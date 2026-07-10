import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import ffmpegPath from "ffmpeg-static";

// ffprobe-static ships no type declarations; load it via require so the untyped
// import doesn't break consumers that compile this file transitively.
const require = createRequire(import.meta.url);
const ffprobe = require("ffprobe-static") as { path: string };

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  raw: Record<string, unknown>;
}

function bin(name: "ffmpeg" | "ffprobe"): string {
  const p = name === "ffmpeg" ? ffmpegPath : ffprobe.path;
  if (!p) throw new Error(`${name} binary not found (ffmpeg-static/ffprobe-static)`);
  return p as string;
}

function run(
  command: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts?.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(bin("ffprobe"), [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  return {
    durationSec: Number(data.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    raw: data as Record<string, unknown>,
  };
}

/** Generates a test source video (pattern + tone) — used by the mock download driver. */
export async function synthesizeTestVideo(outPath: string, durationSec: number): Promise<void> {
  await run(bin("ffmpeg"), [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outPath,
  ]);
}

export interface RenderClipInput {
  inputPath: string;
  outPath: string;
  startSec: number;
  endSec: number;
  /**
   * Filename of an .ass captions file that lives in `workDir`. Referenced
   * relatively (ffmpeg runs with cwd=workDir) to dodge Windows drive-letter
   * escaping in the subtitles filter.
   */
  captionsFileName?: string;
  workDir: string;
}

/** Cut a window, crop to 9:16 (1080x1920), optionally burn captions. */
export async function renderClip(input: RenderClipInput): Promise<void> {
  const duration = input.endSec - input.startSec;
  const filters = ["crop=ih*9/16:ih", "scale=1080:1920"];
  if (input.captionsFileName) filters.push(`subtitles=${input.captionsFileName}`);
  await run(
    bin("ffmpeg"),
    [
      "-y",
      "-ss", input.startSec.toFixed(3),
      "-i", input.inputPath,
      "-t", duration.toFixed(3),
      "-vf", filters.join(","),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      input.outPath,
    ],
    { cwd: input.workDir },
  );
}

/**
 * Extract a compact mono 16 kHz MP3 audio track for speech-to-text. Strips the
 * (large) video stream so the file fits transcription-API size limits — a video
 * can be hundreds of MB while its speech audio is only a few. ~32 kbps mono is
 * plenty for Whisper and keeps ~1h40m under the common 25 MB cap.
 */
export async function extractAudio(inputPath: string, outPath: string): Promise<void> {
  await run(bin("ffmpeg"), [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libmp3lame",
    "-b:a", "32k",
    outPath,
  ]);
}

/** Extract a 9:16 JPEG thumbnail at `atSec` (relative to clip file start). */
export async function extractThumbnail(inputPath: string, outPath: string, atSec = 0.5): Promise<void> {
  await run(bin("ffmpeg"), [
    "-y",
    "-ss", atSec.toFixed(2),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=540:960",
    outPath,
  ]);
}
