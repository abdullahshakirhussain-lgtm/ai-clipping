import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  /**
   * Normalized 0-1 horizontal focus (dominant face center) to crop around. When
   * set, the 9:16 crop shifts toward it so an off-center subject stays framed;
   * omitted → the default center crop.
   */
  focusX?: number;
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
  // Scale to cover 1080x1920, then crop. Default centers; with a focus point the
  // crop shifts horizontally to keep the subject framed. `iw` is the scaled width;
  // normalized position is preserved under scaling, so focusX*iw is the subject's x.
  const cropFilter =
    input.focusX !== undefined
      ? `crop=1080:1920:x=clip(${input.focusX.toFixed(4)}*iw-540\\,0\\,iw-1080):y=0`
      : "crop=1080:1920";
  vFilters.push("scale=1080:1920:force_original_aspect_ratio=increase", cropFilter);
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

/**
 * Extract up to `count` frames evenly spaced across [startSec, endSec], scaled to
 * `w`x`h`, as JPEGs in `outDir`. Returns the produced file paths. Used to sample a
 * clip for face detection (reframing).
 */
export async function extractFrames(
  inputPath: string,
  startSec: number,
  endSec: number,
  count: number,
  outDir: string,
  w = 320,
  h = 240,
): Promise<string[]> {
  const dur = Math.max(0.2, endSec - startSec);
  const fps = Math.max(0.1, count / dur);
  await run(
    bin("ffmpeg"),
    [
      "-y",
      "-ss", startSec.toFixed(3),
      "-i", inputPath,
      "-t", dur.toFixed(3),
      "-vf", `fps=${fps.toFixed(4)},scale=${w}:${h}`,
      "-frames:v", String(count),
      join(outDir, "f-%03d.jpg"),
    ],
    { timeoutMs: 60 * 1000 },
  );
  const files: string[] = [];
  for (let i = 1; i <= count; i++) {
    const p = join(outDir, `f-${String(i).padStart(3, "0")}.jpg`);
    if (await stat(p).then(() => true).catch(() => false)) files.push(p);
  }
  return files;
}

const SFX_DIR = fileURLToPath(new URL("../assets/sfx/", import.meta.url));

/** Resolve a sound name to its bundled asset path, or null if the file is absent. */
export interface FreezeInsert {
  /** Seconds into the input clip where the picture should hold. */
  atSec: number;
  durationSec: number;
}

export interface FreezePlan {
  /** Hold on the first frame for this long before the clip starts (cold open). */
  startPad: number;
  /** Cut points; `e: null` is the tail. `stop` holds the last frame after it. */
  segments: Array<{ s: number; e: number | null; stop: number }>;
  /**
   * Each insert's start in the OUTPUT timeline, aligned to the input order.
   * `null` means the insert was dropped (it couldn't be honoured without
   * producing a degenerate segment) — the caller must not place audio for it.
   */
  offsets: Array<number | null>;
}

/**
 * Works out how freezes reshape the timeline: which inserts are the cold open
 * and closing hold, where to cut for the mid ones, and where every line ends up
 * once the earlier freezes have pushed it later.
 *
 * Pure and exported so this (the part that's easy to get subtly wrong) can be
 * tested without invoking ffmpeg.
 */
export function planFreezes(durationSec: number, inserts: FreezeInsert[]): FreezePlan {
  const EPS = 0.05;
  // Anything at//past the end is a closing hold, not a split: cutting there would
  // ask ffmpeg for a zero-length (or out-of-range) segment, and concat with a
  // degenerate segment silently yields a broken clip — no freeze and dead audio,
  // with ffmpeg still exiting 0. `atSec` comes from an LLM + a duration estimate,
  // so it cannot be trusted to sit inside the file.
  const clamped = inserts.map((i, idx) => ({
    idx,
    durationSec: i.durationSec,
    atSec: Math.min(Math.max(i.atSec, 0), durationSec),
  }));
  const sorted = [...clamped].sort((a, b) => a.atSec - b.atSec);
  const intro = sorted.length > 0 && sorted[0]!.atSec <= EPS ? sorted[0]! : undefined;
  const last = sorted[sorted.length - 1];
  const outro = last && last !== intro && last.atSec >= durationSec - EPS ? last : undefined;

  // Only genuinely interior points may split the clip. A split at (or past) an
  // edge, or two splits within EPS of each other, would leave a zero-length
  // segment — which concat turns into a silently broken clip.
  const mids: typeof sorted = [];
  const dropped = new Set<number>();
  for (const i of sorted) {
    if (i === intro || i === outro) continue;
    if (i.atSec <= EPS || i.atSec >= durationSec - EPS) {
      dropped.add(i.idx);
      continue;
    }
    if (mids.length && i.atSec - mids[mids.length - 1]!.atSec < EPS) {
      dropped.add(i.idx);
      continue;
    }
    mids.push(i);
  }

  const startPad = intro?.durationSec ?? 0;
  const endPad = outro?.durationSec ?? 0;

  // One segment per mid insert (ending on its freeze) plus the tail segment.
  const segments: FreezePlan["segments"] = [];
  let prev = 0;
  for (const m of mids) {
    segments.push({ s: prev, e: m.atSec, stop: m.durationSec });
    prev = m.atSec;
  }
  segments.push({ s: prev, e: null, stop: endPad });

  const startOf = new Map<number, number>();
  if (intro) startOf.set(intro.idx, 0);
  let midAcc = 0;
  for (const m of mids) {
    startOf.set(m.idx, startPad + m.atSec + midAcc);
    midAcc += m.durationSec;
  }
  if (outro) startOf.set(outro.idx, startPad + durationSec + midAcc);

  return {
    startPad,
    segments,
    offsets: inserts.map((_, idx) => (dropped.has(idx) ? null : (startOf.get(idx) ?? null))),
  };
}

/**
 * Freeze-frame commentary beats: at each insert the picture holds on that frame
 * (audio silent) for `durationSec`, then the clip resumes — so nothing in the
 * original ever gets talked over. An insert at 0 holds the first frame (cold
 * open); one at the end holds the last (closing take).
 *
 * concat can't stream-copy, so this re-encodes — which is why `burnAssFileName`
 * is applied in the same pass: burning the commentary text costs nothing extra.
 *
 * Returns each insert's start time in the OUTPUT timeline, in the same order as
 * `inserts`, so the caller knows where to place the voice.
 */
export async function insertFreezes(
  inputPath: string,
  outPath: string,
  inserts: FreezeInsert[],
  workDir: string,
  burnAssFileName?: string,
): Promise<Array<number | null>> {
  if (inserts.length === 0) throw new Error("insertFreezes: no inserts");
  const { durationSec } = await probe(inputPath);
  const { startPad, segments, offsets } = planFreezes(durationSec, inserts);

  const chains: string[] = [];
  const concatIn: string[] = [];
  segments.forEach((seg, i) => {
    const range =
      seg.e === null ? `start=${seg.s.toFixed(3)}` : `start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)}`;
    const v = [`trim=${range}`, "setpts=PTS-STARTPTS"];
    const a = [`atrim=${range}`, "asetpts=PTS-STARTPTS"];
    if (i === 0 && startPad > 0) {
      // Cold open: hold the first frame, with matching silence before the audio.
      const ms = Math.round(startPad * 1000);
      v.push(`tpad=start_mode=clone:start_duration=${startPad.toFixed(3)}`);
      a.push(`adelay=${ms}|${ms}`);
    }
    if (seg.stop > 0) {
      v.push(`tpad=stop_mode=clone:stop_duration=${seg.stop.toFixed(3)}`);
      a.push(`apad=pad_dur=${seg.stop.toFixed(3)}`);
    }
    chains.push(`[0:v]${v.join(",")}[v${i}]`);
    chains.push(`[0:a]${a.join(",")}[a${i}]`);
    concatIn.push(`[v${i}][a${i}]`);
  });

  let filter = `${chains.join(";")};${concatIn.join("")}concat=n=${segments.length}:v=1:a=1[vc][a]`;
  if (burnAssFileName) filter += `;[vc]subtitles=${burnAssFileName}[vout]`;

  await run(
    bin("ffmpeg"),
    [
      "-y", "-i", inputPath,
      "-filter_complex", filter,
      "-map", burnAssFileName ? "[vout]" : "[vc]",
      "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outPath,
    ],
    { cwd: workDir, timeoutMs: 5 * 60 * 1000 },
  );

  return offsets;
}

export interface CommentaryMix {
  /** Start time in the already-frozen clip's timeline. */
  atSec: number;
  file: string;
  gain?: number;
}

/**
 * Lays the commentary voice into the freezes. `insertFreezes` already made the
 * room (silence under each hold), so this just delays each line into place and
 * mixes — the video is stream-copied because the freeze pass did the encoding.
 */
export async function mixCommentary(
  inputClip: string,
  outPath: string,
  lines: CommentaryMix[],
  workDir: string,
): Promise<void> {
  if (lines.length === 0) throw new Error("mixCommentary: no lines");
  const chains: string[] = [];
  const labels: string[] = [];
  lines.forEach((l, i) => {
    const ms = Math.max(0, Math.round(l.atSec * 1000));
    const gain = l.gain ?? 1;
    chains.push(`[${i + 1}:a]adelay=${ms}|${ms},volume=${gain.toFixed(2)}[c${i}]`);
    labels.push(`[c${i}]`);
  });
  const filter = `${chains.join(";")};[0:a]${labels.join("")}amix=inputs=${lines.length + 1}:normalize=0:duration=first[a]`;

  const args = ["-y", "-i", inputClip];
  for (const l of lines) args.push("-i", l.file);
  args.push(
    "-filter_complex", filter,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  );
  await run(bin("ffmpeg"), args, { cwd: workDir, timeoutMs: 3 * 60 * 1000 });
}

export async function resolveSfxFile(name: string): Promise<string | null> {
  const p = join(SFX_DIR, `${name}.mp3`);
  return (await stat(p).then(() => true).catch(() => false)) ? p : null;
}

export interface SfxMix {
  /** Clip-time (post-cut) seconds to play the effect at. */
  atSec: number;
  /** Absolute path to the sfx audio file. */
  file: string;
  /** Volume scale (default 0.7 so it sits under the speech). */
  gain?: number;
}

/**
 * Mix short sound effects into a rendered clip's audio at the given clip-times.
 * Video is stream-copied (no re-encode) so it's fast. Throws if `sfx` is empty.
 */
export async function mixSfx(
  inputClip: string,
  outPath: string,
  sfx: SfxMix[],
  workDir: string,
): Promise<void> {
  if (sfx.length === 0) throw new Error("mixSfx: no cues");
  const chains: string[] = [];
  const labels: string[] = [];
  sfx.forEach((s, i) => {
    const ms = Math.max(0, Math.round(s.atSec * 1000));
    const gain = s.gain ?? 0.7;
    // input i+1 (0 is the clip); delay to the moment on both channels, scale volume.
    chains.push(`[${i + 1}:a]adelay=${ms}|${ms},volume=${gain.toFixed(2)}[s${i}]`);
    labels.push(`[s${i}]`);
  });
  const filter = `${chains.join(";")};[0:a]${labels.join("")}amix=inputs=${sfx.length + 1}:normalize=0:duration=first[a]`;

  const args = ["-y", "-i", inputClip];
  for (const s of sfx) args.push("-i", s.file);
  args.push(
    "-filter_complex", filter,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  );
  await run(bin("ffmpeg"), args, { cwd: workDir, timeoutMs: 2 * 60 * 1000 });
}

/**
 * Pick a representative cover frame with ffmpeg's `thumbnail` filter (the most
 * salient frame across a batch) instead of a fixed timestamp — avoids blank,
 * transitional, or mid-blink covers. Falls back to a fixed grab on any issue.
 */
export async function extractSmartThumbnail(inputPath: string, outPath: string): Promise<void> {
  try {
    await run(
      bin("ffmpeg"),
      ["-y", "-i", inputPath, "-vf", "thumbnail=n=300,scale=540:960", "-frames:v", "1", outPath],
      { timeoutMs: 90 * 1000 },
    );
    const st = await stat(outPath).catch(() => null);
    if (st && st.size > 0) return;
  } catch {
    /* fall through to the fixed-timestamp grab */
  }
  await extractThumbnail(inputPath, outPath, 0.5);
}

// ── Story Studio slideshow ───────────────────────────────────────────────────

export interface SlideshowBeat {
  /** Image filename (in workDir) shown for this beat. */
  imageFile: string;
  /** Narration audio filename (in workDir) for this beat. */
  audioFile: string;
  /** How long this beat lasts — the measured audio duration. */
  durationSec: number;
}

export interface CaptionTimingBeat {
  text: string;
  durationSec: number;
}

/**
 * Turn per-beat narration into caption segments with word timings, by spreading
 * each beat's words evenly across its measured duration. `buildAss` then chunks
 * them into short on-screen groups. Pure + deterministic so it can be tested
 * without ffmpeg. Returns segments in absolute (whole-video) time.
 */
export function planCaptionTiming(
  beats: CaptionTimingBeat[],
): Array<{ start: number; end: number; text: string; words: Array<{ start: number; end: number; word: string }> }> {
  const segments = [];
  let offset = 0;
  for (const beat of beats) {
    const dur = Math.max(0.1, beat.durationSec);
    const words = beat.text.split(/\s+/).filter(Boolean);
    const end = offset + dur;
    if (words.length > 0) {
      const per = dur / words.length;
      const timed = words.map((word, i) => ({
        start: offset + i * per,
        end: offset + (i + 1) * per,
        word,
      }));
      segments.push({ start: offset, end, text: words.join(" "), words: timed });
    }
    offset = end;
  }
  return segments;
}

/**
 * Assemble a narrated slideshow: each beat's image is held for its narration's
 * length (perfect sync, since the duration IS the measured audio), padded to
 * 1080x1920, concatenated with its audio, and the burned captions laid over the
 * whole thing in one pass. Images are static (reliable) — motion is a later polish.
 */
export async function assembleSlideshow(input: {
  beats: SlideshowBeat[];
  captionsFileName?: string;
  outPath: string;
  workDir: string;
}): Promise<void> {
  const { beats } = input;
  if (beats.length === 0) throw new Error("assembleSlideshow: no beats");

  const args: string[] = ["-y"];
  for (const b of beats) args.push("-loop", "1", "-t", b.durationSec.toFixed(3), "-i", b.imageFile);
  for (const b of beats) args.push("-i", b.audioFile);

  const n = beats.length;
  const chains: string[] = [];
  const concatIn: string[] = [];
  beats.forEach((b, i) => {
    // Fit the image inside 9:16 on a white card (doodles shouldn't be cropped).
    chains.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:-1:-1:color=white,setsar=1,fps=30,format=yuv420p[v${i}]`,
    );
    // Match audio length to the image hold exactly (pad then trim).
    chains.push(`[${n + i}:a]aresample=44100,apad,atrim=duration=${b.durationSec.toFixed(3)},asetpts=N/SR/TB[a${i}]`);
    concatIn.push(`[v${i}][a${i}]`);
  });
  chains.push(`${concatIn.join("")}concat=n=${n}:v=1:a=1[cv][ca]`);
  let vLabel = "[cv]";
  if (input.captionsFileName) {
    chains.push(`[cv]subtitles=${input.captionsFileName}[outv]`);
    vLabel = "[outv]";
  }

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", vLabel, "-map", "[ca]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    input.outPath,
  );

  await run(bin("ffmpeg"), args, { cwd: input.workDir, timeoutMs: 6 * 60 * 1000 });
}
