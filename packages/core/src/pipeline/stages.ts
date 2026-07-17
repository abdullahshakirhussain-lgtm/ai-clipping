import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CommentaryLine, CommentaryMode, CommentaryRole, TranscriptSegment } from "@clipfactory/ai";
import { ClipStatus, PublishJobStatus, SourceVideoStatus } from "@clipfactory/db";
import {
  analyzeLoudness,
  type CaptionWord,
  type EditPlan,
  extractAudio,
  extractSmartThumbnail,
  findLoudnessPeaks,
  type FreezeInsert,
  insertFreezes,
  mixCommentary,
  mixSfx,
  planClipEdit,
  planReframe,
  probe,
  renderClip,
  resolveSfxFile,
  type SfxMix,
} from "@clipfactory/media";
import type { PublishPlatform } from "@clipfactory/publishers";
import { PublisherNotConfiguredError } from "@clipfactory/publishers";
import {
  buildAudioCandidates,
  mergeCandidates,
  scoreCandidate,
  selectDiverse,
  type ScoringWeights,
} from "../detection.js";
import type { PipelineContext } from "./context.js";

const clipKey = (clipId: string) => `clips/${clipId}/clip.mp4`;
const thumbKey = (clipId: string) => `clips/${clipId}/thumb.jpg`;
const sourceKey = (videoId: string) => `sources/${videoId}/source.mp4`;

/** Downloads the source video, probes it, stores it, then queues transcription. */
export async function runDownload(ctx: PipelineContext, sourceVideoId: string): Promise<void> {
  const moved = await ctx.repos.sourceVideos.transition(
    sourceVideoId,
    [SourceVideoStatus.PENDING, SourceVideoStatus.FAILED],
    SourceVideoStatus.DOWNLOADING,
  );
  if (!moved) {
    ctx.logger.info({ sourceVideoId }, "download skipped (not pending)");
    return;
  }
  const video = await ctx.repos.sourceVideos.byId(sourceVideoId);
  if (!video) return;

  if (!video.originalUrl) {
    // Uploaded sources have no URL and skip this stage entirely; if we somehow
    // land here without one, fail loudly rather than call the downloader with null.
    await failVideo(ctx, sourceVideoId, new Error("source has no originalUrl to download"));
    return;
  }

  const workDir = join(ctx.workRoot, sourceVideoId);
  try {
    const result = await ctx.downloader.download(video.originalUrl, workDir);
    await ctx.storage.putFile(sourceKey(sourceVideoId), result.filePath, "video/mp4");
    await ctx.repos.sourceVideos.update(sourceVideoId, {
      status: SourceVideoStatus.DOWNLOADED,
      storageKey: sourceKey(sourceVideoId),
      title: result.title,
      durationSec: result.durationSec,
      width: result.width,
      height: result.height,
      metadata: result.metadata as never,
      error: null,
    });
    await ctx.dispatcher.enqueue("video.transcribe", { sourceVideoId }, { jobId: sourceVideoId });
  } catch (err) {
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

/** Transcribes the stored source video and queues highlight detection. */
export async function runTranscribe(ctx: PipelineContext, sourceVideoId: string): Promise<void> {
  const moved = await ctx.repos.sourceVideos.transition(
    sourceVideoId,
    [SourceVideoStatus.DOWNLOADED],
    SourceVideoStatus.TRANSCRIBING,
  );
  if (!moved) return;

  const workDir = join(ctx.workRoot, sourceVideoId);
  const localSource = join(workDir, "source.mp4");
  try {
    await fs.mkdir(workDir, { recursive: true });
    if (!(await exists(localSource))) {
      await ctx.storage.getToFile(sourceKey(sourceVideoId), localSource);
    }
    // Transcribe an audio-only track, not the full video: transcription APIs cap
    // upload size (Groq = 25 MB) and only need the speech.
    const audioPath = join(workDir, "audio.mp3");
    await extractAudio(localSource, audioPath);
    const transcript = await ctx.transcription.transcribe(audioPath);
    await ctx.repos.sourceVideos.upsertTranscript(sourceVideoId, {
      language: transcript.language,
      fullText: transcript.text,
      segments: transcript.segments as never,
      provider: transcript.provider,
    });
    await ctx.repos.sourceVideos.update(sourceVideoId, { status: SourceVideoStatus.TRANSCRIBED });
    await ctx.dispatcher.enqueue("clip.detect", { sourceVideoId }, { jobId: sourceVideoId });
  } catch (err) {
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

/** Runs highlight detection and creates candidate clips, one render job each. */
export async function runDetect(ctx: PipelineContext, sourceVideoId: string): Promise<void> {
  const moved = await ctx.repos.sourceVideos.transition(
    sourceVideoId,
    [SourceVideoStatus.TRANSCRIBED],
    SourceVideoStatus.DETECTING,
  );
  if (!moved) return;

  const video = await ctx.repos.sourceVideos.byId(sourceVideoId);
  if (!video || !video.transcript) {
    await failVideo(ctx, sourceVideoId, new Error("missing transcript"));
    return;
  }
  try {
    const det = ctx.config.detection;
    const segments = video.transcript.segments as unknown as TranscriptSegment[];

    // Repost mode: no clipping — the whole video becomes one output that still
    // gets captions/framing/SFX per the upload toggles. Useful for adding
    // subtitles to an already-short video.
    if (video.subtitlesOnly) {
      const fullDuration = video.durationSec ?? segments[segments.length - 1]?.end ?? 0;
      if (fullDuration <= 0) {
        // Without a duration we'd create a zero-length clip that fails to render
        // with an opaque ffmpeg error — fail loudly here instead.
        await failVideo(ctx, sourceVideoId, new Error("cannot determine video duration for subtitles-only render"));
        return;
      }
      const created = await ctx.repos.clips.createMany([
        {
          sourceVideoId,
          campaignId: video.campaignId,
          startSec: 0,
          endSec: fullDuration,
          status: ClipStatus.RENDERING,
          detectionReason: "Full video — subtitles only",
          detectionSource: "subtitles-only",
          captionStyle: video.captionStyle,
          captionPosition: video.captionPosition,
          reframe: video.reframe,
          autoEnhance: video.autoEnhance,
          untouched: video.untouched,
          commentaryMode: video.commentaryMode,
          category: video.category,
          hookScore: 100,
          viralScore: 100,
          overallScore: 100,
          scoreBreakdown: { notes: ["subtitles-only"] } as never,
        },
      ]);
      await ctx.repos.sourceVideos.update(sourceVideoId, { status: SourceVideoStatus.PROCESSED });
      for (const clip of created) {
        await ctx.dispatcher.enqueue("clip.render", { clipId: clip.id }, { jobId: clip.id });
      }
      ctx.logger.info({ sourceVideoId }, "subtitles-only: rendered whole video as one clip");
      return;
    }
    const durationSec = video.durationSec ?? segments[segments.length - 1]?.end ?? 0;
    const bounds = { minDurationSec: det.minDurationSec, maxDurationSec: det.maxDurationSec };

    // Best-effort audio-energy pass powers both the non-speech (audio) detector
    // and the "opening energy / pacing" measured scoring signals. Never fatal —
    // detection degrades to transcript-only if ffmpeg/ebur128 fails.
    let energy: number[] = [];
    let peaks: number[] = [];
    if (det.audioPeaks) {
      try {
        const workDir = join(ctx.workRoot, sourceVideoId);
        const localSource = join(workDir, "source.mp4");
        await fs.mkdir(workDir, { recursive: true });
        if (!(await exists(localSource))) {
          await ctx.storage.getToFile(sourceKey(sourceVideoId), localSource);
        }
        const timeline = await analyzeLoudness(localSource);
        energy = timeline.energy;
        peaks = findLoudnessPeaks(timeline, {
          minGapSec: det.minDurationSec,
          max: det.maxClips * 2,
        }).map((p) => p.atSec);
      } catch (err) {
        ctx.logger.warn(
          { sourceVideoId, err: String(err) },
          "audio analysis failed; transcript-only detection",
        );
      }
    }

    // Hybrid detection: LLM transcript hooks + audio-energy peaks, merged.
    const llmCandidates = await ctx.llm.detectHighlights({
      segments,
      durationSec,
      minDurationSec: det.minDurationSec,
      maxDurationSec: det.maxDurationSec,
      chunkMinutes: det.chunkMinutes,
      audioPeaks: peaks,
    });
    const audioCandidates = buildAudioCandidates(peaks, llmCandidates, bounds, durationSec);
    const merged = mergeCandidates([...llmCandidates, ...audioCandidates], bounds);

    // Use learned weights if the outcome-calibration has run, else defaults.
    const calib = await ctx.repos.calibration.get();
    const weights = (calib?.weights as ScoringWeights | null) ?? undefined;

    // Score every candidate with the transparent model, keep those above the
    // floor, best-first. Clip count now varies with content.
    const scoredAll = merged
      .map((candidate) => ({ candidate, score: scoreCandidate({ candidate, segments, energy, weights }) }))
      .filter((x) => x.candidate.endSec - x.candidate.startSec >= det.minDurationSec)
      .filter((x) => x.score.overallScore >= det.minScore)
      .sort((a, b) => b.score.overallScore - a.score.overallScore);

    // Self-critique: shortlist a bit more than we need, then let the LLM cut the
    // ones that don't stand alone or don't pay off. Never drop everything.
    const shortlist = scoredAll.slice(0, Math.min(scoredAll.length, det.maxClips * 2, 40));
    let survivors = shortlist;
    if (shortlist.length > det.maxClips) {
      try {
        const keep = await ctx.llm.refineHighlights({
          clips: shortlist.map((s, i) => ({
            index: i,
            hook: s.candidate.hook,
            durationSec: s.candidate.endSec - s.candidate.startSec,
            transcript: segments
              .filter((sg) => sg.end > s.candidate.startSec && sg.start < s.candidate.endSec)
              .map((sg) => sg.text)
              .join(" ")
              .trim(),
          })),
        });
        const keepSet = new Set(keep);
        const filtered = shortlist.filter((_, i) => keepSet.has(i));
        if (filtered.length > 0) survivors = filtered;
      } catch (err) {
        ctx.logger.warn({ sourceVideoId, err: String(err) }, "self-critique failed; skipping");
      }
    }

    // Diversity-aware final selection so the batch spreads across topics.
    const scored = selectDiverse(survivors, det.maxClips);

    const created = await ctx.repos.clips.createMany(
      scored.map(({ candidate, score }) => ({
        sourceVideoId,
        campaignId: video.campaignId,
        startSec: candidate.startSec,
        endSec: candidate.endSec,
        status: ClipStatus.RENDERING,
        // Store the punchy hook line: it seeds the on-screen hook overlay, the
        // enhance step, and the grid's fallback title.
        detectionReason: candidate.hook || candidate.reason,
        detectionSource: candidate.source,
        captionStyle: video.captionStyle,
        captionPosition: video.captionPosition,
        reframe: video.reframe,
        autoEnhance: video.autoEnhance,
        untouched: video.untouched,
        commentaryMode: video.commentaryMode,
        category: video.category,
        hookScore: score.hookScore,
        viralScore: score.viralScore,
        overallScore: score.overallScore,
        scoreBreakdown: score as never,
      })),
    );
    await ctx.repos.sourceVideos.update(sourceVideoId, { status: SourceVideoStatus.PROCESSED });
    for (const clip of created) {
      await ctx.dispatcher.enqueue("clip.render", { clipId: clip.id }, { jobId: clip.id });
    }
    ctx.logger.info(
      { sourceVideoId, clips: created.length, candidates: merged.length },
      "detected candidate clips",
    );
  } catch (err) {
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

/** Cuts, 9:16-crops and captions a clip, stores it, then queues enhancement. */
export async function runRender(ctx: PipelineContext, clipId: string): Promise<void> {
  const clip = await ctx.repos.clips.byId(clipId);
  if (!clip) return;
  if (clip.status !== ClipStatus.RENDERING) {
    const moved = await ctx.repos.clips.transition(
      clipId,
      [ClipStatus.CANDIDATE, ClipStatus.FAILED, ClipStatus.READY_FOR_REVIEW],
      ClipStatus.RENDERING,
    );
    if (!moved) {
      ctx.logger.info({ clipId }, "render skipped");
      return;
    }
  }

  const workDir = join(ctx.workRoot, clip.sourceVideoId);
  const localSource = join(workDir, "source.mp4");
  const outPath = join(workDir, `${clipId}.mp4`);
  const thumbPath = join(workDir, `${clipId}.jpg`);
  const assName = `${clipId}.ass`;
  try {
    await fs.mkdir(workDir, { recursive: true });
    if (!(await exists(localSource))) {
      await ctx.storage.getToFile(sourceKey(clip.sourceVideoId), localSource);
    }
    const segments = (clip.sourceVideo.transcript?.segments as unknown as TranscriptSegment[]) ?? [];
    // Collect word timestamps inside the window for jump-cuts + karaoke captions.
    const words: CaptionWord[] = [];
    for (const s of segments) {
      if (s.end <= clip.startSec || s.start >= clip.endSec || !s.words) continue;
      for (const w of s.words) words.push({ start: w.start, end: w.end, word: w.word });
    }

    // Plan the edit: trim leading filler, cut internal dead air, karaoke captions,
    // and a first-frame hook banner (the stored hook line).
    const plan = planClipEdit({
      words,
      clipStart: clip.startSec,
      clipEnd: clip.endSec,
      styleName: clip.captionStyle,
      position: clip.captionPosition as "top" | "middle" | "bottom",
      hookText: clip.detectionReason ?? undefined,
      // Untouched renders skip the cuts, so the captions must be timed on the
      // uncut timeline — otherwise they'd drift against the video.
      noCuts: clip.untouched,
    });
    let captionsFileName: string | undefined;
    if (plan.ass.trim()) {
      await fs.writeFile(join(workDir, assName), plan.ass, "utf8");
      captionsFileName = assName;
    }

    // Untouched (repost) mode: render the window as-is with captions only — no
    // dead-air jump-cuts, no reframe, no SFX.
    const selectSpans = clip.untouched ? undefined : plan.selectSpans;

    // Opt-in subject-aware reframing: find the dominant face and crop toward it.
    // Best-effort — any failure/no-face leaves focusX undefined → center crop.
    let focusX: number | undefined;
    if (clip.reframe && !clip.untouched) {
      const rf = await planReframe({
        inputPath: localSource,
        startSec: clip.startSec,
        endSec: clip.endSec,
        workDir,
      });
      if (rf) {
        focusX = rf.focusX;
        ctx.logger.info({ clipId, focusX: Number(rf.focusX.toFixed(3)), samples: rf.samples }, "reframed to subject");
      }
    }

    const baseArgs = {
      inputPath: localSource,
      outPath,
      startSec: clip.startSec,
      endSec: clip.endSec,
      focusX,
      workDir,
    };
    // Progressive fallback so a caption/filter hiccup never loses the clip:
    // full (cuts + captions) → cuts only → plain window.
    try {
      await renderClip({ ...baseArgs, selectSpans, captionsFileName });
    } catch (err) {
      ctx.logger.error({ clipId, err: String(err) }, "full render failed; retrying cuts-only");
      try {
        await renderClip({ ...baseArgs, selectSpans });
      } catch (err2) {
        ctx.logger.error({ clipId, err: String(err2) }, "cuts render failed; rendering plain window");
        await renderClip(baseArgs);
      }
    }
    if (plan.removedSec > 0.2) {
      ctx.logger.info(
        { clipId, removedSec: Number(plan.removedSec.toFixed(1)), keptSec: Number(plan.clipDurationSec.toFixed(1)) },
        "jump-cut dead air removed",
      );
    }

    // Opt-in auto sound-effects, applied SPARSELY. Best-effort — any failure
    // leaves the un-enhanced clip untouched.
    let finalClip = outPath;
    if (clip.autoEnhance && !clip.untouched) {
      try {
        const enhanced = await applyAutoSfx(ctx, clip, plan, outPath, workDir);
        if (enhanced) finalClip = enhanced;
      } catch (err) {
        ctx.logger.warn(
          { clipId },
          `auto-sfx failed; using un-enhanced clip — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Opt-in commentary voice-over (freeze-frame). After SFX so their cues stay
    // on their moments. Best-effort — a failure leaves the clip without a track.
    if (clip.commentaryMode !== "off") {
      try {
        const narrated = await applyCommentary(ctx, clip, plan, finalClip, workDir);
        if (narrated) finalClip = narrated;
      } catch (err) {
        // Put the reason in the MESSAGE, not a structured field: log viewers
        // collapse fields, and this failing invisibly cost several debugging
        // rounds. ffmpeg's stderr rides along inside err.message (see run()).
        const reason = err instanceof Error ? err.message : String(err);
        ctx.logger.warn({ clipId }, `commentary failed; using clip without it — ${reason}`);
      }
    }

    await extractSmartThumbnail(finalClip, thumbPath);

    await ctx.storage.putFile(clipKey(clipId), finalClip, "video/mp4");
    await ctx.storage.putFile(thumbKey(clipId), thumbPath, "image/jpeg");
    await ctx.repos.clips.update(clipId, {
      status: ClipStatus.ENHANCING,
      storageKey: clipKey(clipId),
      thumbnailKey: thumbKey(clipId),
      error: null,
    });
    await ctx.dispatcher.enqueue("clip.enhance", { clipId }, { jobId: clipId });
  } catch (err) {
    await failClip(ctx, clipId, err);
    throw err;
  } finally {
    await Promise.allSettled([
      fs.rm(outPath, { force: true }),
      fs.rm(thumbPath, { force: true }),
      fs.rm(join(workDir, `${clipId}-sfx.mp4`), { force: true }),
    ]);
  }
}

/**
 * Plan + mix sparse sound effects into a rendered clip. Enforces tightness in
 * code (cap 2, ≥4s apart), maps cue times through the jump-cut plan, and skips
 * any cue whose asset file is missing (e.g. an unprovided faaaaa.mp3). Returns
 * the enhanced clip path, or null when nothing was applied.
 */
async function applyAutoSfx(
  ctx: PipelineContext,
  clip: { id: string; startSec: number; endSec: number; sourceVideo: { transcript: { segments: unknown } | null } },
  plan: EditPlan,
  clipPath: string,
  workDir: string,
): Promise<string | null> {
  const segments = (clip.sourceVideo.transcript?.segments as unknown as TranscriptSegment[]) ?? [];
  const lines = segments
    .filter((s) => s.end > clip.startSec && s.start < clip.endSec)
    .map((s) => `[${(s.start - clip.startSec).toFixed(1)}-${(s.end - clip.startSec).toFixed(1)}] ${s.text}`)
    .join("\n");
  if (!lines.trim()) return null;

  const cues = await ctx.llm.planEnhancements({
    transcript: lines,
    durationSec: clip.endSec - clip.startSec,
    maxCues: 2,
  });
  if (cues.length === 0) return null;

  const chosen: SfxMix[] = [];
  const usedTimes: number[] = [];
  for (const cue of cues) {
    if (chosen.length >= 2) break;
    const clipT = plan.mapSourceTime(clip.startSec + cue.atSec);
    if (clipT === null) continue; // moment was cut out
    if (usedTimes.some((t) => Math.abs(t - clipT) < 4)) continue; // keep them spaced
    const file = await resolveSfxFile(cue.sound);
    if (!file) {
      ctx.logger.info({ clipId: clip.id, sound: cue.sound }, "sfx asset missing; cue skipped");
      continue;
    }
    chosen.push({ atSec: clipT, file });
    usedTimes.push(clipT);
  }
  if (chosen.length === 0) return null;

  const out = join(workDir, `${clip.id}-sfx.mp4`);
  await mixSfx(clipPath, out, chosen, workDir);
  await ctx.repos.clips.update(clip.id, { edl: { sfx: cues } as never });
  ctx.logger.info({ clipId: clip.id, cues: chosen.length }, "auto-sfx applied");
  return out;
}

/**
 * Delivery steering for the voice — the main lever (with the script prompt) that
 * keeps the read from sounding like a narrator bot. OpenAI honours this;
 * ElevenLabs ignores it and takes its tone from the voice itself.
 *
 * What sells "human" is imperfection: an audible breath before speaking, uneven
 * pacing, and a beat before the payoff. Perfectly smooth and evenly-paced is the
 * thing people clock as AI. This is the knob to turn if the read feels off —
 * OpenAI reads it as free-form direction, so it's safe to rewrite.
 */
/**
 * Silence held around each spoken line inside its freeze. The voice's offset is
 * computed arithmetically while ffmpeg snaps video to frame boundaries and audio
 * to samples, so the real freeze edges drift from the maths by up to a frame and
 * the error accumulates across segments. This headroom keeps the line safely
 * inside its own freeze instead of spilling onto the moving video.
 */
const FREEZE_LEAD_IN = 0.15;
const FREEZE_TAIL = 0.25;

/**
 * Fallback per-role directions, used only when a line carries no `delivery` of
 * its own (pre-M3 scripts, or a hand-edited line with the direction cleared).
 * New scripts are directed line-by-line by the LLM that wrote them.
 */
const VOICE_INSTRUCTIONS: Record<CommentaryRole, string> = {
  intro: [
    "Voice: like you're pulling a friend over to watch something dumb.",
    "Delivery: a small audible breath, then in — never announcer-bright.",
    "Pacing: uneven. Throw away the setup, lean hard on the last few words.",
    "Emotion: amused, conspiratorial, already enjoying what's coming.",
  ].join("\n"),
  react: [
    "Voice: reacting in real time — it just slipped out.",
    "Delivery: quick breath in, then let it spike. Raising your voice is allowed.",
    "Pacing: fast off the top, a beat before the last word lands.",
    "Emotion: genuine disbelief or mockery, not narration.",
  ].join("\n"),
  outro: [
    "Voice: the verdict. Slow, dry, a little contemptuous.",
    "Delivery: a small exhale first. Say it once, land it, stop.",
    "Pacing: deliberate, with a held beat before the final word.",
    "Emotion: certainty — you watched the whole thing and you're done with it.",
  ].join("\n"),
};

/**
 * Baseline voice character prepended to every line's per-line direction. A
 * category persona (from the registry) replaces the default description so the
 * read matches the channel's character, not a generic one.
 */
const DEFAULT_PERSONA =
  "The friend on the couch who can't help talking back at the screen — quick, sarcastic, zero reverence.";

/** Mix level per LLM-tagged intensity: shouted lines punch, asides sit back. */
export const INTENSITY_GAIN: Record<string, number> = { quiet: 0.8, normal: 1.0, loud: 1.35 };

/**
 * Freeze-frame commentary: writes a take, voices it, holds the picture for each
 * line so nothing gets talked over, and mixes the audio in.
 *
 * Runs AFTER auto-SFX on purpose: the freezes shift the timeline, and SFX cues
 * are placed against the pre-freeze one — baking them in first keeps them on
 * their moments. Best-effort; commentary failing never costs us the clip.
 */
async function applyCommentary(
  ctx: PipelineContext,
  clip: {
    id: string;
    startSec: number;
    endSec: number;
    commentaryMode: string;
    category: string | null;
    detectionReason: string | null;
    edl: unknown;
    sourceVideo: { transcript: { segments: unknown } | null };
  },
  plan: EditPlan,
  clipPath: string,
  workDir: string,
): Promise<string | null> {
  if (clip.commentaryMode === "off") return null;

  const segments = (clip.sourceVideo.transcript?.segments as unknown as TranscriptSegment[]) ?? [];
  const transcript = segments
    .filter((s) => s.end > clip.startSec && s.start < clip.endSec)
    .map((s) => `[${(s.start - clip.startSec).toFixed(1)}-${(s.end - clip.startSec).toFixed(1)}] ${s.text}`)
    .join("\n");
  if (!transcript.trim()) return null;

  // Category persona is looked up by name at render time, so editing it on the
  // registry changes the character of every subsequent render — no denorm.
  const personaRow = clip.category ? await ctx.repos.categories.byName(clip.category) : null;
  const persona = personaRow?.persona?.trim() || undefined;

  // A hand-edited script wins: re-generating here would silently discard the
  // user's rewrite on every re-render, which is the whole point of editing.
  const edl = (clip.edl as { commentary?: CommentaryLine[]; commentaryEdited?: boolean } | null) ?? {};
  const script =
    edl.commentaryEdited && edl.commentary?.length
      ? edl.commentary
      : await ctx.llm.planCommentary({
          transcript,
          durationSec: clip.endSec - clip.startSec,
          mode: clip.commentaryMode as Exclude<CommentaryMode, "off">,
          category: clip.category ?? undefined,
          hook: clip.detectionReason ?? undefined,
          persona,
        });
  if (script.length === 0) return null;

  // Time everything against the REAL rendered file, not plan.clipDurationSec.
  // The planner's length is an estimate of the jump-cut result; the encoder's
  // actual output can differ, and an insert past the true end makes ffmpeg build
  // an empty segment — which concat turns into a clip with no freeze and no
  // audio, while still exiting 0.
  const { durationSec: realDuration } = await probe(clipPath);
  if (realDuration <= 0) return null;

  // Voice each line and measure it — the freeze has to be exactly as long as the
  // audio, so durations come from the synthesized file, not an estimate.
  const inserts: FreezeInsert[] = [];
  const files: string[] = [];
  const kept: CommentaryLine[] = [];
  for (const [i, line] of script.entries()) {
    const mapped =
      line.role === "intro"
        ? 0
        : line.role === "outro"
          ? realDuration
          : plan.mapSourceTime(clip.startSec + line.atSec);
    if (mapped === null) continue; // reacted to a moment the jump-cuts removed
    const atClip = Math.min(Math.max(mapped, 0), realDuration);

    // Persona sets the character; the line's own delivery (written by the LLM
    // alongside the text) sets THIS read. Identical instructions on every line
    // is exactly what "same pitch throughout" sounded like.
    const character = `Character: ${persona ?? DEFAULT_PERSONA}`;
    const { audio, ext } = await ctx.tts.synthesize({
      text: line.text,
      instructions: `${character}\n${line.delivery?.trim() || VOICE_INSTRUCTIONS[line.role]}`,
    });
    const file = join(workDir, `${clip.id}-vo-${i}.${ext}`);
    await fs.writeFile(file, audio);
    const { durationSec } = await probe(file);
    if (durationSec <= 0) continue;

    // Hold a beat longer than the line. The voice's position is computed
    // arithmetically while ffmpeg snaps video to frames and audio to samples, so
    // each segment drifts by up to a frame and the error accumulates — without
    // headroom the tail of a line spills onto the moving video. The padding also
    // just sounds better: a beat before it speaks and after it lands.
    inserts.push({ atSec: atClip, durationSec: FREEZE_LEAD_IN + durationSec + FREEZE_TAIL });
    files.push(file);
    kept.push(line);
  }
  if (inserts.length === 0) return null;

  const frozen = join(workDir, `${clip.id}-freeze.mp4`);
  const offsets = await insertFreezes(clipPath, frozen, inserts, workDir);

  // A null offset means the planner refused that insert (it would have produced a
  // degenerate segment); mixing its audio anyway would drop the line at 0s over
  // the opening. Keep only the lines that actually got a freeze.
  // Start each line just inside its freeze, not on the edge (see FREEZE_LEAD_IN).
  const mix = offsets
    .map((atSec, i) =>
      atSec === null
        ? null
        : {
            atSec: atSec + FREEZE_LEAD_IN,
            file: files[i]!,
            // Dynamics: shouted lines punch above the mix, muttered asides sit back.
            gain: INTENSITY_GAIN[kept[i]!.intensity ?? "normal"] ?? 1,
          },
    )
    .filter((m): m is { atSec: number; file: string; gain: number } => m !== null);
  if (mix.length === 0) return null;
  const spoken = kept.filter((_, i) => offsets[i] !== null);

  const out = join(workDir, `${clip.id}-vo.mp4`);
  await mixCommentary(frozen, out, mix, workDir);

  // Merge into the edl rather than overwrite — auto-SFX wrote its cues there.
  // For a hand-edited script keep the user's lines exactly as written: recording
  // only what was "spoken" would quietly delete any line the planner dropped, so
  // their own text would vanish from the editor.
  const current = (await ctx.repos.clips.byId(clip.id))?.edl as Record<string, unknown> | null;
  await ctx.repos.clips.update(clip.id, {
    edl: { ...(current ?? {}), ...(edl.commentaryEdited ? {} : { commentary: spoken }) } as never,
  });
  ctx.logger.info(
    { clipId: clip.id, lines: spoken.length, dropped: kept.length - spoken.length, mode: clip.commentaryMode },
    "commentary track added",
  );
  return out;
}

/** Generates metadata + scores, then moves the clip to READY_FOR_REVIEW. */
export async function runEnhance(ctx: PipelineContext, clipId: string): Promise<void> {
  const clip = await ctx.repos.clips.byId(clipId);
  if (!clip) return;
  if (clip.status !== ClipStatus.ENHANCING) {
    const moved = await ctx.repos.clips.transition(
      clipId,
      [ClipStatus.READY_FOR_REVIEW, ClipStatus.RENDERING],
      ClipStatus.ENHANCING,
    );
    if (!moved) return;
  }

  try {
    const segments = (clip.sourceVideo.transcript?.segments as unknown as TranscriptSegment[]) ?? [];
    const excerpt = segments
      .filter((s) => s.end > clip.startSec && s.start < clip.endSec)
      .map((s) => s.text)
      .join(" ")
      .trim();
    const hook = clip.detectionReason ?? excerpt.slice(0, 80);
    const result = await ctx.llm.enhanceClip({
      transcriptExcerpt: excerpt || hook,
      hook,
      topic: "general",
      durationSec: clip.endSec - clip.startSec,
      platformHints: clip.campaign.allowedPlatforms,
    });
    // Scores were computed at detection time and live on the Clip; mirror them
    // into the enhancement row so existing readers keep working.
    await ctx.repos.clips.upsertEnhancement(clipId, {
      title: result.title,
      description: result.description,
      hashtags: result.hashtags,
      hooks: { variants: result.hookVariants, selectedIndex: 0 } as never,
      qualityScore: clip.overallScore,
      viralScore: clip.viralScore,
      estimatedEngagement: clip.overallScore / 10,
      model: result.model,
    });
    // Auto-approve: clips land straight in the grid (kept=true) for bulk culling
    // rather than a one-at-a-time manual gate.
    await ctx.repos.clips.update(clipId, { status: ClipStatus.APPROVED, error: null });
    ctx.logger.info({ clipId }, "clip enhanced and auto-approved");
  } catch (err) {
    await failClip(ctx, clipId, err);
    throw err;
  }
}

/** Publishes a clip to one platform account with attempt logging + retries. */
export async function runPublish(ctx: PipelineContext, publishJobId: string): Promise<void> {
  const moved = await ctx.repos.publish.transition(
    publishJobId,
    [PublishJobStatus.QUEUED, PublishJobStatus.SCHEDULED],
    PublishJobStatus.RUNNING,
  );
  if (!moved) {
    ctx.logger.info({ publishJobId }, "publish skipped (not queued)");
    return;
  }
  const job = await ctx.repos.publish.byId(publishJobId);
  if (!job) return;

  const attemptNo = job.attempts + 1;
  await ctx.repos.publish.update(publishJobId, { attempts: attemptNo });

  const workDir = join(ctx.workRoot, "publish", publishJobId);
  const localClip = join(workDir, "clip.mp4");
  try {
    await fs.mkdir(workDir, { recursive: true });
    if (!job.clip.storageKey) throw new Error("clip has no rendered file");
    await ctx.storage.getToFile(job.clip.storageKey, localClip);
    const videoUrl = await ctx.storage.getUrl(job.clip.storageKey);
    const publisher = ctx.publisherFor(job.socialAccount.platform as PublishPlatform);
    const enh = job.clip.enhancement;

    const result = await publisher.publish({
      account: {
        id: job.socialAccount.id,
        platform: job.socialAccount.platform as PublishPlatform,
        handle: job.socialAccount.handle,
        credentials: (job.socialAccount.credentials as Record<string, unknown> | null) ?? null,
      },
      videoFilePath: localClip,
      videoUrl,
      title: enh?.title ?? "Clip",
      description: enh?.description ?? "",
      hashtags: enh?.hashtags ?? [],
    });

    await ctx.repos.publish.addAttempt(publishJobId, { success: true, response: result.raw as never });
    await ctx.repos.publish.update(publishJobId, {
      status: PublishJobStatus.PUBLISHED,
      externalPostId: result.externalPostId,
      externalUrl: result.externalUrl,
      publishedAt: new Date(),
      lastError: null,
    });
    await ctx.repos.clips.update(job.clipId, { status: ClipStatus.PUBLISHED });
    ctx.logger.info({ publishJobId, platform: job.socialAccount.platform }, "published");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.repos.publish.addAttempt(publishJobId, {
      success: false,
      response: { error: message } as never,
    });

    const notConfigured = err instanceof PublisherNotConfiguredError;
    const canRetry = !notConfigured && attemptNo < job.maxAttempts;
    if (canRetry) {
      await ctx.repos.publish.update(publishJobId, { status: PublishJobStatus.QUEUED, lastError: message });
      await ctx.dispatcher.enqueue(
        "publish.execute",
        { publishJobId },
        { delayMs: 5000 * 2 ** (attemptNo - 1) },
      );
    } else {
      await ctx.repos.publish.update(publishJobId, { status: PublishJobStatus.FAILED, lastError: message });
      await ctx.repos.clips.update(job.clipId, { status: ClipStatus.FAILED, error: message });
    }
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function failVideo(ctx: PipelineContext, id: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  ctx.logger.error({ sourceVideoId: id, err: message }, "video stage failed");
  await ctx.repos.sourceVideos.update(id, { status: SourceVideoStatus.FAILED, error: message });
}

async function failClip(ctx: PipelineContext, id: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  ctx.logger.error({ clipId: id, err: message }, "clip stage failed");
  await ctx.repos.clips.update(id, { status: ClipStatus.FAILED, error: message });
}
