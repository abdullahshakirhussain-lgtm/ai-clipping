import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
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

/**
 * Make clean studio TTS sound like a phone recording: band-limit it to the
 * classic 300-3400 Hz voice channel, squash the dynamics the way a phone line
 * does, and normalise. Without this a "recorded call" gives itself away
 * instantly — the voices are too full and too quiet-to-loud to be down a line.
 */
export async function applyPhoneFilter(inputPath: string, outPath: string): Promise<void> {
  await run(
    bin("ffmpeg"),
    [
      "-y",
      "-i", inputPath,
      "-af", "highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=4:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ac", "1",
      "-ar", "24000",
      outPath,
    ],
    { timeoutMs: 5 * 60 * 1000 },
  );
}

/**
 * Join narration chunks into one continuous track. Long-form narration has to be
 * synthesized in pieces (TTS providers cap input length), and the pieces are cut
 * at sentence boundaries, so a plain concatenation restores the original read.
 * Re-encoded rather than stream-copied: chunk files can differ in bitrate or
 * channel layout, which a copy-concat would splice into a corrupt stream.
 */
export async function concatAudio(files: string[], outPath: string, workDir: string): Promise<void> {
  if (files.length === 0) throw new Error("concatAudio: no files");
  if (files.length === 1) {
    await run(bin("ffmpeg"), ["-y", "-i", files[0]!, "-c:a", "libmp3lame", "-b:a", "160k", outPath], {
      cwd: workDir,
      timeoutMs: 5 * 60 * 1000,
    });
    return;
  }
  const args: string[] = ["-y"];
  for (const f of files) args.push("-i", f);
  const inputs = files.map((_, i) => `[${i}:a]`).join("");
  args.push(
    "-filter_complex", `${inputs}concat=n=${files.length}:v=0:a=1[a]`,
    "-map", "[a]",
    "-c:a", "libmp3lame", "-b:a", "160k",
    outPath,
  );
  await run(bin("ffmpeg"), args, { cwd: workDir, timeoutMs: 15 * 60 * 1000 });
}

/**
 * Turn a still into a silent video clip of a given length. The last-resort
 * substitute when one shot of an animation can't be generated: a beat that
 * holds its (already-approved) frame is far better than throwing away every
 * other paid clip in the video, and it keeps the beat's slot in the timeline so
 * nothing after it drifts out of sync with the narration.
 */
export async function stillClip(imageFile: string, durationSec: number, outPath: string, workDir: string): Promise<void> {
  await run(
    bin("ffmpeg"),
    [
      "-y", "-threads", "1",
      "-loop", "1", "-i", imageFile,
      "-t", Math.max(0.2, durationSec).toFixed(3),
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=24",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      outPath,
    ],
    { cwd: workDir, timeoutMs: 5 * 60 * 1000 },
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

const MUSIC_DIR = fileURLToPath(new URL("../assets/music/", import.meta.url));

/**
 * Resolve a background-music track by mood (calm | tense | upbeat | epic). The
 * user drops royalty-free/CC0 mp3s into packages/media/assets/music/; missing →
 * null so the caller skips music cleanly (we can't bundle copyrighted tracks).
 */
export async function resolveMusicFile(mood: string): Promise<string | null> {
  if (!mood || mood === "none") return null;
  const p = join(MUSIC_DIR, `${mood}.mp3`);
  return (await stat(p).then(() => true).catch(() => false)) ? p : null;
}

/**
 * Lay a music bed UNDER an assembled video's narration: loop/trim the track to
 * the video's length, drop it to `gain` (~0.15 so speech stays on top), and mix.
 * Video is stream-copied (already encoded). Best-effort — the caller only calls
 * this when a track exists.
 */
export async function mixMusic(
  inputVideo: string,
  musicFile: string,
  outPath: string,
  workDir: string,
  opts?: { gain?: number },
): Promise<void> {
  const gain = opts?.gain ?? 0.15;
  const filter =
    `[1:a]aloop=loop=-1:size=2e9,volume=${gain.toFixed(2)}[bed];` +
    `[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]`;
  await run(
    bin("ffmpeg"),
    [
      "-y",
      "-i", inputVideo,
      "-i", musicFile,
      "-filter_complex", filter,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outPath,
    ],
    { cwd: workDir, timeoutMs: 3 * 60 * 1000 },
  );
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

export interface SlideshowSlide {
  /** Image filename (in workDir) shown for this slide. */
  imageFile: string;
  /** How long this image stays on screen (computed from the narration). */
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
 * Assemble a narrated slideshow over ONE continuous narration track: each image
 * is held for its computed on-screen duration and the images are concatenated
 * video-only (no per-image audio, no fades), then the single audio file is laid
 * over the whole thing and captions burned in one pass. Recording the narration
 * as one take — not beat by beat — is what removes the audible seam and the
 * fade-to-black between beats.
 */
export async function assembleSlideshow(input: {
  slides: SlideshowSlide[];
  audioFile: string;
  captionsFileName?: string;
  outPath: string;
  workDir: string;
  /** Output frame size. Defaults to 9:16 (1080x1920); pass 1920x1080 for long-form. */
  width?: number;
  height?: number;
  /**
   * Slow per-slide push-in (Ken Burns) so stills breathe like the reference
   * channels instead of sitting dead. Off keeps the cheaper static-card path.
   */
  kenBurns?: boolean;
}): Promise<void> {
  const { slides, workDir } = input;
  if (slides.length === 0) throw new Error("assembleSlideshow: no slides");
  const width = input.width ?? 1080;
  const height = input.height ?? 1920;
  const fps = 25;
  // COVER + CENTER-CROP (not pad): image models return off-aspect images
  // (gpt's 1024x1536 / 1536x1024); padding leaves bars. Scaling to cover and
  // cropping the overflow gives true full-bleed frames; prompts keep the subject
  // centered so the crop is safe.
  const coverCrop = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;

  if (input.kenBurns) {
    // Ken Burns: render each still to a short clip with a slow zoom, then concat.
    // Sequential + single-threaded, matching the static path's care for
    // constrained containers (firing N zoompans at once exhausts thread/PID
    // limits). Pre-cover-crop, then zoompan at the target size so there's no
    // per-frame rescale jitter. The zoom creeps ~6% over the slide's life.
    const segs: string[] = [];
    for (let i = 0; i < slides.length; i++) {
      const dur = Math.max(0.5, slides[i]!.durationSec);
      const frames = Math.max(2, Math.round(dur * fps));
      const step = (0.06 / frames).toFixed(6); // reach ~1.06x by the last frame
      const seg = `seg-${i}.mp4`;
      try {
        await run(
          bin("ffmpeg"),
          [
            // ONE looped input frame, output capped with -frames:v. Do NOT put
            // -t on the loop: zoompan's d=frames expands EACH input frame, so a
            // -t-fed stream of `frames` input frames would multiply to frames²
            // (a 2s clip balloons to ~100s). Capping output frames instead lets
            // the first frame's d-expansion satisfy the count before a second
            // input frame is ever pulled. Verified: dur*fps frames, exact length.
            "-y", "-threads", "1", "-loop", "1", "-i", slides[i]!.imageFile,
            "-vf",
            `${coverCrop},zoompan=z='min(zoom+${step}\\,1.06)':d=${frames}:` +
              `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps},format=yuv420p`,
            "-frames:v", String(frames),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-threads", "1", join(workDir, seg),
          ],
          { cwd: workDir, timeoutMs: 3 * 60 * 1000 },
        );
      } catch {
        // Any bad frame degrades to a still card of the right size, not a dead render.
        await run(
          bin("ffmpeg"),
          [
            "-y", "-threads", "1", "-f", "lavfi", "-t", dur.toFixed(3),
            "-i", `color=white:size=${width}x${height}:rate=${fps}`,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-threads", "1", join(workDir, seg),
          ],
          { cwd: workDir, timeoutMs: 60 * 1000 },
        );
      }
      segs.push(seg);
    }
    const lines = ["ffconcat version 1.0", ...segs.map((f) => `file '${f}'`)];
    const listName = "segs.txt";
    await writeFile(join(workDir, listName), lines.join("\n"), "utf8");
    const vf = ["format=yuv420p"];
    if (input.captionsFileName) vf.push(`subtitles=${input.captionsFileName}`);
    await run(
      bin("ffmpeg"),
      [
        "-y",
        "-f", "concat", "-safe", "0", "-i", listName,
        "-i", input.audioFile,
        "-filter_complex", `[0:v]${vf.join(",")}[vo]`,
        "-map", "[vo]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest", "-movflags", "+faststart",
        input.outPath,
      ],
      { cwd: workDir, timeoutMs: 12 * 60 * 1000 },
    );
    return;
  }

  // Static path. 1. Scale each image to a uniform card ONCE. Doing the scale
  //    here — not per output frame across a multi-minute video — is the bulk of
  //    the cost; uniform sizes then let us use the lightweight concat demuxer
  //    (one input, no N parallel looped decoders) instead of a heavy filter_complex.
  //    SEQUENTIAL + single-threaded: firing all N scales at once, each spawning
  //    encoder threads, exhausts thread/PID limits on constrained containers.
  const scaled: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    try {
      await run(
        bin("ffmpeg"),
        [
          "-y", "-threads", "1", "-i", slides[i]!.imageFile,
          "-vf", coverCrop,
          "-frames:v", "1", "-threads", "1", join(workDir, `slide-${i}.png`),
        ],
        { cwd: workDir, timeoutMs: 60 * 1000 },
      );
    } catch {
      // A corrupt/truncated image (bad download, broken fallback bytes) must
      // degrade to a blank card, not sink a finished narration + N good frames.
      await run(
        bin("ffmpeg"),
        [
          "-y", "-threads", "1", "-f", "lavfi", "-i", `color=white:size=${width}x${height}`,
          "-frames:v", "1", "-threads", "1", join(workDir, `slide-${i}.png`),
        ],
        { cwd: workDir, timeoutMs: 60 * 1000 },
      );
    }
    scaled.push(`slide-${i}.png`);
  }

  // 2. concat-demuxer playlist with per-slide durations. The last file is
  //    repeated because the demuxer only honours a duration when another entry
  //    follows it.
  const lines = ["ffconcat version 1.0"];
  scaled.forEach((f, i) => {
    lines.push(`file '${f}'`, `duration ${slides[i]!.durationSec.toFixed(3)}`);
  });
  lines.push(`file '${scaled[scaled.length - 1]!}'`);
  const listName = "slides.txt";
  await writeFile(join(workDir, listName), lines.join("\n"), "utf8");

  // 3. One encode: stills → constant fps → burned captions + the single audio.
  //    ultrafast + tune stillimage is ideal for a slideshow and far quicker than
  //    veryfast on limited CPU; static frames still compress tiny.
  const vf = [`fps=${fps}`, "format=yuv420p"];
  if (input.captionsFileName) vf.push(`subtitles=${input.captionsFileName}`);
  await run(
    bin("ffmpeg"),
    [
      "-y",
      "-f", "concat", "-safe", "0", "-i", listName,
      "-i", input.audioFile,
      "-filter_complex", `[0:v]${vf.join(",")}[vo]`,
      "-map", "[vo]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-shortest", "-movflags", "+faststart",
      input.outPath,
    ],
    { cwd: workDir, timeoutMs: 8 * 60 * 1000 },
  );
}

/**
 * Concatenate generated clips under ONE narration track — the animated-story
 * assembler.
 *
 * Differs from `assembleClips` in the two ways that matter: every clip's own
 * audio is DISCARDED (the video model always generates some, and here it would
 * fight the voice-over), and each clip is trimmed to the length of the narration
 * beat it illustrates, so picture and words stay together instead of drifting a
 * little further apart at every cut. Single re-encode with continuous
 * timestamps, same as the cook path, so the cuts stay clean.
 */
export async function assembleNarratedClips(input: {
  clips: Array<{ file: string; durationSec: number }>;
  audioFile: string;
  captionsFileName?: string;
  outPath: string;
  workDir: string;
}): Promise<void> {
  const { clips, workDir } = input;
  if (clips.length === 0) throw new Error("assembleNarratedClips: no clips");

  const args: string[] = ["-y"];
  for (const c of clips) args.push("-i", c.file);
  args.push("-i", input.audioFile);
  const audioIndex = clips.length;

  const parts: string[] = [];
  const labels: string[] = [];
  clips.forEach((c, i) => {
    const d = Math.max(0.2, c.durationSec).toFixed(3);
    // tpad → trim → reset PTS. Each segment must come out EXACTLY as long as the
    // narration beat it carries, in both directions:
    //   - clip longer than the beat  → trim cuts it back
    //   - clip SHORTER than the beat → tpad holds the last frame to fill the gap
    // Without the pad, a beat whose narration outruns its 8s clip would shorten
    // the picture while the voice keeps going, and every later beat would drift
    // further out of sync. A brief freeze is a far better failure than that.
    parts.push(
      `[${i}:v]tpad=stop_mode=clone:stop_duration=${d},trim=0:${d},setpts=PTS-STARTPTS,` +
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=24,format=yuv420p[v${i}]`,
    );
    labels.push(`[v${i}]`);
  });
  // Video only (v=1:a=0) — the clips' own audio never enters the graph.
  parts.push(`${labels.join("")}concat=n=${clips.length}:v=1:a=0[vcat]`);
  parts.push(
    input.captionsFileName ? `[vcat]subtitles=${input.captionsFileName}[vo]` : `[vcat]null[vo]`,
  );

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[vo]",
    "-map", `${audioIndex}:a`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-shortest", "-movflags", "+faststart",
    input.outPath,
  );
  await run(bin("ffmpeg"), args, { cwd: workDir, timeoutMs: 20 * 60 * 1000 });
}

/**
 * Concatenate real video clips (each ~8s, WITH its own native audio) into one
 * SEAMLESS hard-cut video — the cook-in-the-wild assembler. Every clip is
 * normalized to an identical 1080x1920 / 24fps stream (cover+crop) with even
 * loudness (loudnorm) and 48kHz audio, then joined with the concat FILTER (not
 * the demuxer + stream-copy) in a single re-encode. The filter path rewrites
 * timestamps continuously, so there is no black flash, PTS jump, or audio pop at
 * the cut boundaries — the sizzle/fire/ambient sound flows clip to clip.
 */
export async function assembleClips(input: {
  clips: string[];
  outPath: string;
  workDir: string;
}): Promise<void> {
  const { clips, workDir } = input;
  if (clips.length === 0) throw new Error("assembleClips: no clips");

  // Per-input: uniform video (cover-crop to 1080x1920, 24fps, yuv420p) + evened
  // audio. Then concat them all into one continuous v/a pair.
  const build = (audioFilter: string): string[] => {
    const args: string[] = ["-y"];
    for (const c of clips) args.push("-i", c);
    const parts: string[] = [];
    const labels: string[] = [];
    clips.forEach((_, i) => {
      parts.push(
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=24,format=yuv420p[v${i}]`,
      );
      parts.push(`[${i}:a]aresample=48000,${audioFilter}[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    });
    parts.push(`${labels.join("")}concat=n=${clips.length}:v=1:a=1[vo][ao]`);
    args.push(
      "-filter_complex", parts.join(";"),
      "-map", "[vo]", "-map", "[ao]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart",
      input.outPath,
    );
    return args;
  };

  try {
    // loudnorm is the correct tool — real EBU R128 matching, so a sizzle and a
    // river don't jump in level at the cut.
    await run(bin("ffmpeg"), build("loudnorm"), { cwd: workDir, timeoutMs: 12 * 60 * 1000 });
  } catch (err) {
    // ...but it emits NaN on a DIGITALLY SILENT track and takes the whole render
    // with it ("Input contains (near) NaN/+-Inf"). One near-silent clip out of
    // nine would otherwise throw away every paid clip in the video, so fall back
    // to dynaudnorm, which handles silence, rather than lose the render.
    if (String(err).includes("NaN") || String(err).includes("Error submitting audio frame")) {
      await run(bin("ffmpeg"), build("dynaudnorm"), { cwd: workDir, timeoutMs: 12 * 60 * 1000 });
      return;
    }
    throw err;
  }
}
