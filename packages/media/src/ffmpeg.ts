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
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts?.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    // Guard against a hung process (e.g. libass/fontconfig stalls) blocking the
    // whole in-process pipeline: kill and fail fast so the job dead-letters.
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
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
  /**
   * Optional jump-cut plan: CLIP-RELATIVE keep spans (0 = clip start). Frames /
   * audio outside these spans are dropped and the stream re-timed, removing dead
   * air. When omitted (or a single full-window span) the clip renders unchanged.
   */
  selectSpans?: Array<{ s: number; e: number }>;
  workDir: string;
}

/** Cut a window, remove dead air, fill to 9:16 (1080x1920), optionally burn captions. */
export async function renderClip(input: RenderClipInput): Promise<void> {
  const duration = input.endSec - input.startSec;

  // A jump-cut plan is "real" only if it actually drops something; a single span
  // covering (almost) the whole window is a no-op we skip to avoid a needless filter.
  const spans = input.selectSpans ?? [];
  const dropsSomething =
    spans.length > 1 || (spans.length === 1 && spans[0]!.e - spans[0]!.s < duration - 0.15);

  const vFilters: string[] = [];
  const aFilters: string[] = [];
  if (dropsSomething) {
    const between = spans.map((sp) => `between(t,${sp.s.toFixed(3)},${sp.e.toFixed(3)})`).join("+");
    vFilters.push(`select='${between}'`, "setpts=N/FRAME_RATE/TB");
    aFilters.push(`aselect='${between}'`, "asetpts=N/SR/TB");
  }
  // Scale to cover 1080x1920 then centre-crop — works for any source aspect ratio.
  vFilters.push("scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920");
  if (input.captionsFileName) vFilters.push(`subtitles=${input.captionsFileName}`);

  const args = [
    "-y",
    "-ss", input.startSec.toFixed(3),
    "-i", input.inputPath,
    "-t", duration.toFixed(3),
    "-vf", vFilters.join(","),
  ];
  if (aFilters.length) args.push("-af", aFilters.join(","));
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    input.outPath,
  );

  await run(bin("ffmpeg"), args, { cwd: input.workDir, timeoutMs: 4 * 60 * 1000 });
}

/**
 * Extract a compact mono 16 kHz MP3 audio track for speech-to-text. Strips the
 * (large) video stream so the file fits transcription-API size limits — a video
 * can be hundreds of MB while its speech audio is only a few. ~32 kbps mono is
 * plenty for Whisper and keeps ~1h40m under the common 25 MB cap.
 */
export async function extractAudio(inputPath: string, outPath: string): Promise<void> {
  await run(
    bin("ffmpeg"),
    [
      "-y",
      "-i", inputPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "libmp3lame",
      "-b:a", "32k",
      outPath,
    ],
    { timeoutMs: 8 * 60 * 1000 },
  );
}

export interface LoudnessTimeline {
  /** Normalized 0-1 loudness, one sample per second of source. */
  energy: number[];
  durationSec: number;
}

export interface LoudnessPeak {
  atSec: number;
  /** Normalized 0-1 energy at the peak. */
  energy: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/**
 * Momentary-loudness envelope via ffmpeg's `ebur128` filter, bucketed to one
 * normalized energy value (0-1) per second. Used to (a) find non-speech
 * highlight moments — laughs, hype, action spikes — and (b) score a clip's
 * opening energy. Degrades to an empty timeline on any failure, so callers can
 * treat "no audio signal" as simply skipping the audio path.
 */
export async function analyzeLoudness(inputPath: string): Promise<LoudnessTimeline> {
  let stderr = "";
  try {
    const res = await run(
      bin("ffmpeg"),
      ["-nostats", "-hide_banner", "-i", inputPath, "-filter_complex", "ebur128=metadata=1", "-f", "null", "-"],
      { timeoutMs: 8 * 60 * 1000 },
    );
    stderr = res.stderr;
  } catch (err) {
    // ebur128 can exit non-zero on odd audio; salvage whatever it printed.
    stderr = err instanceof Error ? err.message : "";
  }
  // Lines look like: [Parsed_ebur128_0 @ ..] t: 1.2  TARGET:-23 LUFS  M: -20.6 S:...
  const perSecondMax = new Map<number, number>();
  const re = /t:\s*([0-9]+(?:\.[0-9]+)?)\s+.*?M:\s*(-?[0-9]+(?:\.[0-9]+)?|-?inf|nan)/g;
  let match: RegExpExecArray | null;
  let maxT = 0;
  while ((match = re.exec(stderr))) {
    const t = Number(match[1]);
    const raw = match[2]!;
    const lufs = raw === "-inf" || raw === "nan" ? -70 : Number(raw);
    const sec = Math.floor(t);
    const prev = perSecondMax.get(sec);
    if (prev === undefined || lufs > prev) perSecondMax.set(sec, lufs);
    if (t > maxT) maxT = t;
  }
  const seconds = Math.max(0, Math.ceil(maxT));
  const energy: number[] = [];
  for (let s = 0; s < seconds; s++) {
    const lufs = perSecondMax.get(s) ?? -70;
    // Map momentary LUFS (~ -40 quiet .. -8 loud) into 0-1.
    energy.push(clamp01((lufs + 40) / 32));
  }
  return { energy, durationSec: seconds };
}

/**
 * Local maxima in the energy timeline that stand out above the track's own
 * baseline (mean + k·stddev), spaced at least `minGapSec` apart. These are
 * candidate highlight centers for non-speech moments.
 */
export function findLoudnessPeaks(
  timeline: LoudnessTimeline,
  opts?: { minGapSec?: number; k?: number; max?: number },
): LoudnessPeak[] {
  const { energy } = timeline;
  if (energy.length < 5) return [];
  const minGap = opts?.minGapSec ?? 20;
  const k = opts?.k ?? 1.0;
  const mean = energy.reduce((a, b) => a + b, 0) / energy.length;
  const variance = energy.reduce((a, b) => a + (b - mean) ** 2, 0) / energy.length;
  const std = Math.sqrt(variance);
  const threshold = mean + k * std;
  const peaks: LoudnessPeak[] = [];
  for (let i = 1; i < energy.length - 1; i++) {
    const e = energy[i]!;
    if (e >= threshold && e >= energy[i - 1]! && e >= energy[i + 1]!) {
      peaks.push({ atSec: i, energy: e });
    }
  }
  // Strongest first, then greedily drop peaks too close to a stronger one.
  peaks.sort((a, b) => b.energy - a.energy);
  const kept: LoudnessPeak[] = [];
  for (const p of peaks) {
    if (kept.every((q) => Math.abs(q.atSec - p.atSec) >= minGap)) kept.push(p);
    if (opts?.max && kept.length >= opts.max) break;
  }
  return kept.sort((a, b) => a.atSec - b.atSec);
}

/** Extract a 9:16 JPEG thumbnail at `atSec` (relative to clip file start). */
export async function extractThumbnail(inputPath: string, outPath: string, atSec = 0.5): Promise<void> {
  await run(
    bin("ffmpeg"),
    [
      "-y",
      "-ss", atSec.toFixed(2),
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale=540:960",
      outPath,
    ],
    { timeoutMs: 60 * 1000 },
  );
}
