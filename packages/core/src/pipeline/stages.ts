import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  narratorInstruction,
  solidPng,
  styledImagePrompt,
  type CommentaryLine,
  type CommentaryMode,
  type CommentaryRole,
  type TranscriptSegment,
} from "@clipfactory/ai";
import { ClipStatus, PublishJobStatus, SourceVideoStatus } from "@clipfactory/db";
import {
  analyzeLoudness,
  applyPhoneFilter,
  assembleClips,
  assembleNarratedClips,
  assembleSlideshow,
  buildAss,
  type CaptionWord,
  type EditPlan,
  extractAudio,
  extractFrames,
  extractSmartThumbnail,
  mixMusic,
  resolveMusicFile,
  findLoudnessPeaks,
  type FreezeInsert,
  insertFreezes,
  mixCommentary,
  mixSfx,
  planClipEdit,
  planReframe,
  probe,
  stillClip,
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
import { synthesizeNarration } from "../narration.js";
import { planImageCadence, planStoryTiming } from "../story-timing.js";
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
    await deriveVideoContext(ctx, sourceVideoId, localSource, workDir, transcript.text);
    await ctx.repos.sourceVideos.update(sourceVideoId, { status: SourceVideoStatus.TRANSCRIBED });
    await ctx.dispatcher.enqueue("clip.detect", { sourceVideoId }, { jobId: sourceVideoId });
  } catch (err) {
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

/**
 * Vision context: sample up to 12 frames across the video and have the LLM read
 * the on-screen text (watermarks, captions, usernames, title cards) to learn
 * who/what the video is about — the transcript alone rarely names the speaker.
 * Batched with early stop inside the provider, so obvious videos cost one call.
 * Best-effort: failure logs and moves on, it never fails the video.
 */
async function deriveVideoContext(
  ctx: PipelineContext,
  sourceVideoId: string,
  localSource: string,
  workDir: string,
  transcriptText: string,
): Promise<void> {
  if (!ctx.config.visionContext) return;
  try {
    const video = await ctx.repos.sourceVideos.byId(sourceVideoId);
    const { durationSec } = await probe(localSource);
    if (durationSec <= 0) return;
    const framesDir = join(workDir, "ctx-frames");
    await fs.mkdir(framesDir, { recursive: true });
    // 854x480, not the face-detect default 320x240 — on-screen text must be legible.
    const framePaths = await extractFrames(localSource, 0, durationSec, 12, framesDir, 854, 480);
    if (framePaths.length === 0) return;
    const frames = await Promise.all(framePaths.map((p) => fs.readFile(p)));
    const autoContext = await ctx.llm.describeVideoContext({
      frames,
      title: video?.title ?? null,
      transcriptSample: transcriptText.slice(0, 800),
    });
    if (autoContext.trim()) {
      await ctx.repos.sourceVideos.update(sourceVideoId, { autoContext: autoContext.trim() });
      ctx.logger.info({ sourceVideoId, chars: autoContext.length }, "vision context derived");
    }
  } catch (err) {
    ctx.logger.warn({ sourceVideoId, reason: String(err) }, "vision context failed — continuing without it");
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
 * Removes ElevenLabs-v3 audio tags ("[shouts]", "[bored sigh]") from a line so
 * a provider that doesn't perform them (OpenAI, mock) doesn't read them aloud.
 * The edl always keeps the tagged original — stripping is synthesis-time only,
 * so switching providers never loses the performance markup.
 */
export function stripAudioTags(text: string): string {
  return text.replace(/\[[^\]]{1,30}\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Where a react freeze should land in SOURCE time. A reaction must come AFTER
 * the beat it reacts to, or the freeze interrupts before the viewer hears the
 * payoff (the "reacts before it happens" bug). We snap the react's clip-relative
 * atSec to the END of the transcript segment it falls in, so the pause lands
 * once the line has finished. Falls back to the raw moment when no segment
 * matches (e.g. a react over non-speech). All times clamped to the clip window.
 */
export function reactFreezeSourceSec(
  segments: Array<{ start: number; end: number }>,
  clipStartSec: number,
  clipEndSec: number,
  reactAtSec: number,
): number {
  const src = clipStartSec + Math.max(0, reactAtSec);
  const hit = segments.find((s) => src >= s.start && src <= s.end);
  const at = hit ? hit.end : src;
  return Math.min(Math.max(at, clipStartSec), clipEndSec);
}

/**
 * Combined video context for prompts: the uploader's own words first (they're
 * authoritative), then whatever vision read off the screen. Undefined when
 * neither exists so prompts can omit the block entirely.
 */
export function assembleContext(
  userContext: string | null | undefined,
  autoContext: string | null | undefined,
): string | undefined {
  const parts = [userContext?.trim(), autoContext?.trim()].filter((s): s is string => !!s);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

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
    voiceTier: string;
    category: string | null;
    detectionReason: string | null;
    edl: unknown;
    sourceVideo: {
      context: string | null;
      autoContext: string | null;
      transcript: { segments: unknown } | null;
    };
  },
  plan: EditPlan,
  clipPath: string,
  workDir: string,
): Promise<string | null> {
  if (clip.commentaryMode === "off") return null;

  // Voice tier is per clip: standard for everything, premium (ElevenLabs v3)
  // only where the user explicitly upgraded — that's the cost control.
  const tts = ctx.ttsFor(clip.voiceTier);

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
          voiceTags: tts.speaksTags === true,
          context: assembleContext(clip.sourceVideo.context, clip.sourceVideo.autoContext),
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
          : // Snap the react to AFTER the beat it reacts to, then map into post-cut time.
            plan.mapSourceTime(reactFreezeSourceSec(segments, clip.startSec, clip.endSec, line.atSec));
    if (mapped === null) continue; // reacted to a moment the jump-cuts removed
    const atClip = Math.min(Math.max(mapped, 0), realDuration);

    // Persona sets the character; the line's own delivery (written by the LLM
    // alongside the text) sets THIS read. Identical instructions on every line
    // is exactly what "same pitch throughout" sounded like.
    const character = `Character: ${persona ?? DEFAULT_PERSONA}`;
    // Tag-speaking providers (ElevenLabs v3) perform the "[shouts]" markup;
    // everyone else gets it stripped so it isn't read aloud. Covers hand-edited
    // scripts and provider switches either direction — the edl keeps the tags.
    const speakable = tts.speaksTags ? line.text : stripAudioTags(line.text);
    if (!speakable) continue; // a tags-only line has nothing to say without them
    const { audio, ext } = await tts.synthesize({
      text: speakable,
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

interface StorySpec {
  topic: string;
  style: string;
  voiceTier: string;
  narrator?: string;
  maxBeats: number;
  maxWords?: number;
  minWords?: number;
  category?: string;
  captionStyle?: string;
  captionPosition?: "top" | "middle" | "bottom";
  music?: string;
}

/**
 * Story Studio: generate a narrated slideshow from a topic. Writes the script,
 * records the narration as ONE continuous take, draws an image per beat, times
 * the images + captions against that audio (exact word timings when available),
 * assembles a seamless slideshow, and lands it as a ready-to-review Clip.
 */
export async function runStoryGenerate(ctx: PipelineContext, sourceVideoId: string): Promise<void> {
  const moved = await ctx.repos.sourceVideos.transition(
    sourceVideoId,
    [SourceVideoStatus.PENDING],
    SourceVideoStatus.DETECTING,
  );
  if (!moved) return;

  const video = await ctx.repos.sourceVideos.byId(sourceVideoId);
  if (!video) return;
  const spec = (video.storySpec as StorySpec | null) ?? null;
  if (!spec?.topic) {
    await failVideo(ctx, sourceVideoId, new Error("story video has no spec"));
    return;
  }

  const workDir = join(ctx.workRoot, sourceVideoId);
  // Progress is written into storySpec so the Video Queue can show a bar; we hold
  // the spec in memory and rewrite it (JSON) at each stage. It doubles as the
  // cancellation checkpoint: if the video was terminated from the queue (status
  // flipped off DETECTING), bail before the next stage instead of spending more
  // API calls. Called between every image, so a cancel lands within one frame.
  const setProgress = async (stage: string, pct: number, extra?: Record<string, unknown>) => {
    const cur = await ctx.repos.sourceVideos.byId(sourceVideoId);
    if (!cur || cur.status !== SourceVideoStatus.DETECTING) throw new StoryCancelledError();
    await ctx.repos.sourceVideos.update(sourceVideoId, {
      storySpec: { ...spec, ...extra, progress: { stage, pct } } as never,
    });
  };
  try {
    await fs.mkdir(workDir, { recursive: true });

    // 1. Script → beats. This is the whole product; everything else is assembly.
    await setProgress("Writing the script", 10);
    const tts = ctx.ttsFor(spec.voiceTier);
    const story = await ctx.llm.writeStory({
      topic: spec.topic,
      style: spec.style,
      maxBeats: spec.maxBeats,
      maxWords: spec.maxWords ?? 1300,
      // Floor, so the narration reaches long-form length. Defaulted for specs
      // written before the field existed (read back out of the DB as-is).
      minWords: spec.minWords ?? 1050,
      narrator: spec.narrator,
      voiceTags: tts.speaksTags === true,
    });
    if (story.beats.length === 0) {
      await failVideo(ctx, sourceVideoId, new Error("story writer returned no beats"));
      return;
    }
    // Persist the script immediately so it's viewable even while images render.
    await setProgress("Recording the narration", 25, {
      script: story.script,
      beats: story.beats,
    });

    // 2a. Record the WHOLE narration as one continuous track (no per-beat seams).
    //     Synthesized in sentence-aligned chunks and joined: long-form scripts
    //     run to thousands of words, past what a single TTS request accepts
    //     (gpt-4o-mini-tts caps at 2000 input tokens), so one call would be
    //     rejected outright on anything long.
    const narrator = spec.narrator ?? "storyteller";
    const fullText = story.beats.map((b) => b.text).join("\n\n");
    const speakable = tts.speaksTags ? fullText : stripAudioTags(fullText);
    const voice = await synthesizeNarration({
      tts,
      text: speakable,
      instructions: narratorInstruction(narrator),
      workDir,
      onChunk: async (doneChunks, total) => {
        if (total > 1) await setProgress(`Recording the narration (${doneChunks}/${total})`, 25);
      },
    });
    const audioFile = voice.audioFile;
    const totalDur = voice.durationSec > 0 ? voice.durationSec : Math.max(4, story.beats.length * 3);

    // 2b. Decide the IMAGE CADENCE before drawing anything. A beat is a whole
    //     sentence and can hold the screen 6-8s — long enough for a short to
    //     feel static. Beats that run long are split into several stills of the
    //     same moment, so the narration stays natural sentences while the
    //     picture changes roughly every STORY_IMAGE_SECONDS.
    const beatDurations = planStoryTiming(
      story.beats.map((b) => ({ text: stripAudioTags(b.text) })),
      totalDur,
      voice.words,
    ).slideDurations;
    const cadence = planImageCadence(beatDurations, ctx.config.story.imageSeconds, ctx.config.story.maxImages);

    // One cheap LLM call expands only the beats that need extra frames.
    const needsSplit = cadence.filter((s) => s.subIndex === 0 && s.subCount > 1);
    let expanded = new Map<number, string[]>();
    if (needsSplit.length > 0) {
      try {
        const lists = await ctx.llm.expandImagePrompts({
          setting: story.setting,
          beats: needsSplit.map((s) => ({
            text: stripAudioTags(story.beats[s.beatIndex]!.text),
            imagePrompt: story.beats[s.beatIndex]!.imagePrompt,
            count: s.subCount,
          })),
        });
        expanded = new Map(needsSplit.map((s, i) => [s.beatIndex, lists[i] ?? []]));
      } catch (err) {
        // Not fatal: every slide falls back to its beat's original prompt, which
        // just means repeated frames rather than a failed video.
        ctx.logger.warn({ sourceVideoId, reason: String(err) }, "image-prompt expansion failed; reusing beat prompts");
      }
    }

    const slidePrompts = cadence.map((s) => {
      const beat = story.beats[s.beatIndex]!;
      return expanded.get(s.beatIndex)?.[s.subIndex] ?? beat.imagePrompt;
    });

    // 2c. Draw them, with bounded concurrency (progress per image).
    await setProgress("Drawing the images", 30);
    let done = 0;
    const images = await mapWithConcurrency(slidePrompts, 3, async (prompt, i) => {
      const imgFile = join(workDir, `img-${i}.png`);
      try {
        const { image } = await ctx.images.generate({ prompt: styledImagePrompt(prompt, spec.style, story.setting) });
        await fs.writeFile(imgFile, image);
      } catch (err) {
        // Grim beat prompts (corpses, dictators, plagues — normal for the
        // history/true-crime niches) can trip the provider's moderation. Second
        // chance: an empty establishing shot of the story's WORLD — no people,
        // no beat specifics — still on-topic via the setting, instead of a
        // jarring blank card.
        ctx.logger.warn({ sourceVideoId, beat: i, reason: String(err) }, "image gen failed; retrying with a neutral scene");
        try {
          const neutral = styledImagePrompt(
            "a wide establishing scene of the story's world, no people",
            spec.style,
            story.setting,
          );
          const { image } = await ctx.images.generate({ prompt: neutral });
          await fs.writeFile(imgFile, image);
        } catch (err2) {
          ctx.logger.warn({ sourceVideoId, beat: i, reason: String(err2) }, "image gen failed twice; using plain card");
          await fs.writeFile(imgFile, plainCardPng());
        }
      }
      done++;
      await setProgress(`Drawing the images (${done}/${slidePrompts.length})`, 30 + Math.round((done / slidePrompts.length) * 55));
      return imgFile;
    });

    // 3. Captions stay per-BEAT (whole sentences), while the slides follow the
    //    finer image cadence — the two are timed against the same narration, so
    //    they stay in sync even though there are more images than beats.
    await setProgress("Putting it together", 90);
    const captionBeats = story.beats.map((b) => ({ text: stripAudioTags(b.text) }));
    const { captionSegments } = planStoryTiming(captionBeats, totalDur, voice.words);
    const slides = images.map((imageFile, i) => ({ imageFile, durationSec: cadence[i]!.durationSec }));
    const assName = `${sourceVideoId}.ass`;
    const ass = buildAss(captionSegments, 0, totalDur, spec.captionStyle ?? video.captionStyle, 3, spec.captionPosition);
    if (ass.trim()) await fs.writeFile(join(workDir, assName), ass, "utf8");

    let outPath = join(workDir, "story.mp4");
    await assembleSlideshow({
      slides,
      audioFile,
      captionsFileName: ass.trim() ? assName : undefined,
      outPath,
      workDir,
    });

    // 3b. Optional background-music bed (skips cleanly if no track is present).
    const musicFile = spec.music ? await resolveMusicFile(spec.music) : null;
    if (musicFile) {
      const withMusic = join(workDir, "story-music.mp4");
      await mixMusic(outPath, musicFile, withMusic, workDir);
      outPath = withMusic;
      ctx.logger.info({ sourceVideoId, mood: spec.music }, "music bed mixed in");
    } else if (spec.music && spec.music !== "none") {
      ctx.logger.info({ sourceVideoId, mood: spec.music }, "no music track found; skipping bed");
    }

    // 4. Store + create a ready-to-review Clip with the LLM's metadata.
    const thumbPath = join(workDir, "thumb.jpg");
    await extractSmartThumbnail(outPath, thumbPath);

    const [clip] = await ctx.repos.clips.createMany([
      {
        sourceVideoId,
        campaignId: video.campaignId,
        startSec: 0,
        endSec: totalDur,
        // APPROVED, not READY_FOR_REVIEW: generated stories are the user's own
        // content (nothing to vet), and distribution only routes APPROVED clips —
        // a review status here made story clips silently un-queueable.
        status: ClipStatus.APPROVED,
        detectionReason: story.title,
        detectionSource: "story",
        captionStyle: video.captionStyle,
        captionPosition: video.captionPosition,
        commentaryMode: "off",
        category: video.category,
        hookScore: 80,
        viralScore: 80,
        overallScore: 80,
        scoreBreakdown: { notes: ["story-generated"] } as never,
      },
    ]);
    await ctx.storage.putFile(clipKey(clip!.id), outPath, "video/mp4");
    await ctx.storage.putFile(thumbKey(clip!.id), thumbPath, "image/jpeg");
    await ctx.repos.clips.update(clip!.id, {
      storageKey: clipKey(clip!.id),
      thumbnailKey: thumbKey(clip!.id),
      error: null,
    });
    await ctx.repos.clips.upsertEnhancement(clip!.id, {
      title: story.title,
      description: story.description,
      hashtags: story.hashtags,
      hooks: { variants: [story.title], selectedIndex: 0 } as never,
      qualityScore: 80,
      viralScore: 80,
      estimatedEngagement: 80,
      model: "story",
    });

    await ctx.repos.sourceVideos.update(sourceVideoId, {
      status: SourceVideoStatus.PROCESSED,
      storySpec: { ...spec, script: story.script, beats: story.beats, progress: { stage: "Done", pct: 100 } } as never,
    });
    ctx.logger.info(
      { sourceVideoId, beats: story.beats.length, durationSec: Number(totalDur.toFixed(1)) },
      "story video generated",
    );
  } catch (err) {
    if (err instanceof StoryCancelledError) {
      // Terminated from the queue: it's already FAILED with the "Cancelled"
      // message — don't overwrite it, just stop.
      ctx.logger.info({ sourceVideoId }, "story generation cancelled");
      return;
    }
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

interface CookSpec {
  dish: string;
  category?: string;
  aspectRatio?: string;
  maxShots?: number;
  /** The APPROVED shot prompts from the review step; the job renders these as-is. */
  shots?: Array<{ prompt: string; imagePrompt?: string }>;
  title?: string;
  description?: string;
  hashtags?: string[];
}

/**
 * Cook Studio: generate a "cook-in-the-wild" ASMR video. An LLM plans an
 * exhaustive, continuity-locked shot list (every physical aspect pinned so the
 * video model can't invent inconsistencies between cuts), each shot is rendered
 * as a real ~8s clip WITH native audio by the video model, and the clips are
 * hard-cut together — no narration, no captions. Lands as a ready-to-distribute
 * Clip like a story, so Queue / Library / Distribution are reused.
 */
export async function runCookGenerate(ctx: PipelineContext, sourceVideoId: string): Promise<void> {
  const moved = await ctx.repos.sourceVideos.transition(
    sourceVideoId,
    [SourceVideoStatus.PENDING],
    SourceVideoStatus.DETECTING,
  );
  if (!moved) return;

  const video = await ctx.repos.sourceVideos.byId(sourceVideoId);
  if (!video) return;
  const spec = (video.storySpec as CookSpec | null) ?? null;
  if (!spec?.dish) {
    await failVideo(ctx, sourceVideoId, new Error("cook video has no spec"));
    return;
  }

  const workDir = join(ctx.workRoot, sourceVideoId);
  // Same progress-in-storySpec + cancellation-checkpoint pattern as stories: a
  // terminate from the queue (status flipped off DETECTING) bails before the
  // next expensive video call.
  const setProgress = async (stage: string, pct: number, extra?: Record<string, unknown>) => {
    const cur = await ctx.repos.sourceVideos.byId(sourceVideoId);
    if (!cur || cur.status !== SourceVideoStatus.DETECTING) throw new StoryCancelledError();
    await ctx.repos.sourceVideos.update(sourceVideoId, {
      storySpec: { ...spec, ...extra, progress: { stage, pct } } as never,
    });
  };
  try {
    await fs.mkdir(workDir, { recursive: true });

    // 1. Use the APPROVED shots from the review step. Fall back to planning only
    //    if a caller enqueued without them (the create form always plans first).
    let shots = (spec.shots ?? []).filter((s) => s?.prompt?.trim());
    let title = spec.title;
    let description = spec.description ?? "";
    let hashtags = spec.hashtags ?? [];
    if (shots.length === 0) {
      await setProgress("Planning the shots", 8);
      const plan = await ctx.llm.planCookShots({ dish: spec.dish, maxShots: spec.maxShots ?? 6, aspectRatio: spec.aspectRatio });
      shots = plan.shots;
      title = title ?? plan.title;
      description = description || plan.description;
      hashtags = hashtags.length ? hashtags : plan.hashtags;
    }
    if (shots.length === 0) {
      await failVideo(ctx, sourceVideoId, new Error("cook: no shots to render"));
      return;
    }
    title = title ?? spec.dish;
    await setProgress("Generating the clips", 15);

    // 2. Render each shot as a real clip (native audio). Concurrency 2: video gen
    //    is slow + expensive. A shot that fails is dropped, not fatal — cut the
    //    rest together rather than losing the whole (paid) video.
    // 2a. A still for each shot, drawn SEQUENTIALLY so each one can be an edit
    //     of the previous frame. That chain is what holds the stone, the fire,
    //     the props and the hands identical across cuts — a text prompt asks the
    //     model to imagine the scene again every time, and it obliges.
    //     A still is ~$0.04 against ~$0.80 for the clip it seeds, so this is the
    //     cheap end to be picky at.
    const seeds: Array<Buffer | null> = shots.map(() => null);
    if (ctx.sceneImages) {
      let prev: Buffer | null = null;
      for (let i = 0; i < shots.length; i++) {
        const imagePrompt = shots[i]!.imagePrompt?.trim();
        if (!imagePrompt) continue;
        try {
          const { image } = await ctx.sceneImages.generate({
            prompt: imagePrompt,
            ...(prev ? { referenceImage: prev } : {}),
          });
          seeds[i] = image;
          prev = image;
          await setProgress(`Drawing the scenes (${i + 1}/${shots.length})`, 15 + Math.round(((i + 1) / shots.length) * 15));
        } catch (err) {
          // A missing still is not fatal: that shot falls back to text-to-video.
          ctx.logger.warn({ sourceVideoId, shot: i, reason: String(err) }, "cook scene image failed; text-to-video for this shot");
        }
      }
    }

    let done = 0;
    // Keep the FIRST provider error: when every shot fails it's almost always
    // one systemic cause (billing not enabled on the Google project, a renamed
    // preview model, a rejected parameter), and burying it in a warn log left
    // the user staring at a generic "video generation failed" with nothing to
    // act on.
    let firstError: string | null = null;
    const clipFiles = await mapWithConcurrency(shots, 2, async (shot, i) => {
      try {
        const seed = seeds[i];
        const { video: bytes } = await ctx.video.generate({
          prompt: shot.prompt,
          aspectRatio: spec.aspectRatio,
          ...(seed ? { image: { png: seed } } : {}),
        });
        const f = join(workDir, `shot-${i}.mp4`);
        await fs.writeFile(f, bytes);
        done++;
        await setProgress(
          `Generating the clips (${done}/${shots.length})`,
          30 + Math.round((done / shots.length) * 55),
        );
        return f;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        firstError ??= reason;
        ctx.logger.warn({ sourceVideoId, shot: i, reason }, "cook shot failed; dropping it");
        return null;
      }
    });
    const clips = clipFiles.filter((f): f is string => !!f);
    if (clips.length === 0) {
      await failVideo(
        ctx,
        sourceVideoId,
        new Error(`cook: all ${shots.length} shots failed. First error — ${firstError ?? "unknown"}`),
      );
      return;
    }

    // 3. Hard-cut the clips together, keeping each clip's native audio.
    await setProgress("Putting it together", 90);
    const outPath = join(workDir, "cook.mp4");
    await assembleClips({ clips, outPath, workDir });

    // 4. Store + create a ready-to-distribute Clip with the planner's metadata.
    const thumbPath = join(workDir, "thumb.jpg");
    await extractSmartThumbnail(outPath, thumbPath);
    const probed = await probe(outPath);
    const totalDur = probed.durationSec > 0 ? probed.durationSec : clips.length * 8;

    const [clip] = await ctx.repos.clips.createMany([
      {
        sourceVideoId,
        campaignId: video.campaignId,
        startSec: 0,
        endSec: totalDur,
        // APPROVED like story clips — the user's own content, distribution routes
        // only APPROVED clips.
        status: ClipStatus.APPROVED,
        detectionReason: title,
        detectionSource: "cook",
        captionStyle: video.captionStyle,
        captionPosition: video.captionPosition,
        commentaryMode: "off",
        category: video.category,
        hookScore: 80,
        viralScore: 80,
        overallScore: 80,
        scoreBreakdown: { notes: ["cook-generated"] } as never,
      },
    ]);
    await ctx.storage.putFile(clipKey(clip!.id), outPath, "video/mp4");
    await ctx.storage.putFile(thumbKey(clip!.id), thumbPath, "image/jpeg");
    await ctx.repos.clips.update(clip!.id, {
      storageKey: clipKey(clip!.id),
      thumbnailKey: thumbKey(clip!.id),
      error: null,
    });
    await ctx.repos.clips.upsertEnhancement(clip!.id, {
      title,
      description,
      hashtags,
      hooks: { variants: [title], selectedIndex: 0 } as never,
      qualityScore: 80,
      viralScore: 80,
      estimatedEngagement: 80,
      model: "cook",
    });

    await ctx.repos.sourceVideos.update(sourceVideoId, {
      status: SourceVideoStatus.PROCESSED,
      storySpec: { ...spec, progress: { stage: "Done", pct: 100 } } as never,
    });
    ctx.logger.info(
      { sourceVideoId, shots: clips.length, durationSec: Number(totalDur.toFixed(1)) },
      "cook video generated",
    );
  } catch (err) {
    if (err instanceof StoryCancelledError) {
      ctx.logger.info({ sourceVideoId }, "cook generation cancelled");
      return;
    }
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

interface CallSpecShape {
  title?: string;
  description?: string;
  hashtags?: string[];
  premise?: string;
  characters?: Array<{ name: string; voice: string; accent?: string; gender?: string; age?: string; personality?: string }>;
  durationSeconds?: number;
  imagePrompts?: string[];
  /** The APPROVED brief from the review step; sent to the audio model as-is. */
  brief?: string;
  category?: string;
  captionStyle?: string;
  captionPosition?: "top" | "middle" | "bottom";
}

/**
 * Call Studio: a fictional recorded phone call. The approved brief goes to the
 * audio provider, which improvises the dialogue and performs it as two voices;
 * the result is band-limited to sound like a real line, given a few stills and
 * burned-in captions (the genre is watched muted), and lands as a Clip like any
 * other. Nothing is re-planned here — the brief the user vetted is what ships.
 */
export async function runCallGenerate(ctx: PipelineContext, sourceVideoId: string): Promise<void> {
  const moved = await ctx.repos.sourceVideos.transition(
    sourceVideoId,
    [SourceVideoStatus.PENDING],
    SourceVideoStatus.DETECTING,
  );
  if (!moved) return;

  const video = await ctx.repos.sourceVideos.byId(sourceVideoId);
  if (!video) return;
  const spec = (video.storySpec as CallSpecShape | null) ?? null;
  if (!spec?.brief || (spec.characters ?? []).length < 2) {
    await failVideo(ctx, sourceVideoId, new Error("call video has no approved brief with 2 speakers"));
    return;
  }

  const workDir = join(ctx.workRoot, sourceVideoId);
  const setProgress = async (stage: string, pct: number, extra?: Record<string, unknown>) => {
    const cur = await ctx.repos.sourceVideos.byId(sourceVideoId);
    if (!cur || cur.status !== SourceVideoStatus.DETECTING) throw new StoryCancelledError();
    await ctx.repos.sourceVideos.update(sourceVideoId, {
      storySpec: { ...spec, ...extra, progress: { stage, pct } } as never,
    });
  };
  try {
    await fs.mkdir(workDir, { recursive: true });

    // 1. The call itself: dialogue improvised from the approved brief, then
    //    performed. This is the whole product; everything below is assembly.
    await setProgress("Making the call", 15);
    const targetSeconds = spec.durationSeconds ?? 45;
    const call = await ctx.callAudio.generate({
      brief: spec.brief,
      speakers: (spec.characters ?? []).slice(0, 2).map((c) => ({
        name: c.name,
        voice: c.voice,
        direction: [c.accent, c.gender, c.age, c.personality].filter(Boolean).join(", "),
      })),
      targetSeconds,
    });
    const rawAudio = join(workDir, `call-raw.${call.ext}`);
    await fs.writeFile(rawAudio, call.audio);
    // Persist the transcript as soon as it exists — it's viewable even if the
    // render below fails, and it's the record of what was actually said.
    await setProgress("Cleaning up the line", 45, { transcript: call.transcript });

    // 2. Phone-line treatment. If ffmpeg's filter chain is unhappy, ship the
    //    clean audio rather than lose a paid call.
    let audioFile = join(workDir, "call.wav");
    try {
      await applyPhoneFilter(rawAudio, audioFile);
    } catch (err) {
      ctx.logger.warn({ sourceVideoId, reason: String(err) }, "phone filter failed; using the clean audio");
      audioFile = rawAudio;
    }
    const probed = await probe(audioFile);
    const totalDur = probed.durationSec > 0 ? probed.durationSec : targetSeconds;

    // 3. Stills. A call is audio-led, so a handful of images is all it needs —
    //    they hold the screen while the captions carry the dialogue.
    await setProgress("Drawing the scene", 60);
    const prompts = (spec.imagePrompts ?? []).filter(Boolean).slice(0, 4);
    const imagePrompts = prompts.length > 0 ? prompts : ["two people on a phone call, simple scene"];
    const images = await mapWithConcurrency(imagePrompts, 2, async (prompt, i) => {
      const imgFile = join(workDir, `img-${i}.png`);
      try {
        const { image } = await ctx.images.generate({ prompt: styledImagePrompt(prompt, "stick-scene", spec.premise ?? "") });
        await fs.writeFile(imgFile, image);
      } catch (err) {
        ctx.logger.warn({ sourceVideoId, image: i, reason: String(err) }, "call image failed; using plain card");
        await fs.writeFile(imgFile, plainCardPng());
      }
      return imgFile;
    });

    // 4. Captions from the dialogue lines, spread across the measured duration.
    //    The lines are known exactly, so this needs no transcription pass —
    //    captions match what was said instead of what a recogniser heard.
    await setProgress("Putting it together", 80);
    const captionBeats = call.lines.map((l) => ({ text: l.text }));
    const { captionSegments } = planStoryTiming(captionBeats, totalDur);
    // Images share the screen time evenly — they're wallpaper, not beats.
    const per = totalDur / images.length;
    const slides = images.map((imageFile) => ({ imageFile, durationSec: per }));
    const assName = `${sourceVideoId}.ass`;
    const ass = buildAss(
      captionSegments,
      0,
      totalDur,
      spec.captionStyle ?? video.captionStyle,
      3,
      spec.captionPosition ?? (video.captionPosition as "top" | "middle" | "bottom" | undefined),
    );
    if (ass.trim()) await fs.writeFile(join(workDir, assName), ass, "utf8");

    const outPath = join(workDir, "call.mp4");
    await assembleSlideshow({
      slides,
      audioFile,
      captionsFileName: ass.trim() ? assName : undefined,
      outPath,
      workDir,
    });

    // 5. Store + create a ready-to-distribute Clip.
    const thumbPath = join(workDir, "thumb.jpg");
    await extractSmartThumbnail(outPath, thumbPath);
    const title = spec.title || spec.premise || "Call";

    const [clip] = await ctx.repos.clips.createMany([
      {
        sourceVideoId,
        campaignId: video.campaignId,
        startSec: 0,
        endSec: totalDur,
        status: ClipStatus.APPROVED,
        detectionReason: title,
        detectionSource: "call",
        captionStyle: video.captionStyle,
        captionPosition: video.captionPosition,
        commentaryMode: "off",
        category: video.category,
        hookScore: 80,
        viralScore: 80,
        overallScore: 80,
        scoreBreakdown: { notes: ["call-generated"] } as never,
      },
    ]);
    await ctx.storage.putFile(clipKey(clip!.id), outPath, "video/mp4");
    await ctx.storage.putFile(thumbKey(clip!.id), thumbPath, "image/jpeg");
    await ctx.repos.clips.update(clip!.id, {
      storageKey: clipKey(clip!.id),
      thumbnailKey: thumbKey(clip!.id),
      error: null,
    });
    await ctx.repos.clips.upsertEnhancement(clip!.id, {
      title,
      description: spec.description ?? "",
      hashtags: spec.hashtags ?? [],
      hooks: { variants: [title], selectedIndex: 0 } as never,
      qualityScore: 80,
      viralScore: 80,
      estimatedEngagement: 80,
      model: "call",
    });

    await ctx.repos.sourceVideos.update(sourceVideoId, {
      status: SourceVideoStatus.PROCESSED,
      storySpec: { ...spec, transcript: call.transcript, progress: { stage: "Done", pct: 100 } } as never,
    });
    ctx.logger.info(
      { sourceVideoId, lines: call.lines.length, durationSec: Number(totalDur.toFixed(1)) },
      "call video generated",
    );
  } catch (err) {
    if (err instanceof StoryCancelledError) {
      ctx.logger.info({ sourceVideoId }, "call generation cancelled");
      return;
    }
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

interface AnimSpecShape {
  topic?: string;
  style?: string;
  narrator?: string;
  voiceTier?: string;
  music?: string;
  setting?: string;
  cast?: string;
  shots?: Array<{ text: string; imagePrompt: string; motionPrompt: string }>;
  title?: string;
  description?: string;
  hashtags?: string[];
  captionStyle?: string;
  captionPosition?: "top" | "middle" | "bottom";
}

/**
 * Animated stick short: every narrated beat becomes a real generated clip, so
 * the figures move instead of a still holding the screen for four seconds.
 *
 * The shape that makes it hold together: a STILL is drawn for each beat first
 * (cheap, in the locked stick style) and handed to the video model as the first
 * frame, which is what stops the characters redesigning themselves every clip.
 * Each clip is then trimmed to its beat's measured narration, and the video
 * model's own audio is discarded in favour of the single TTS take.
 */
export async function runAnimGenerate(ctx: PipelineContext, sourceVideoId: string): Promise<void> {
  const moved = await ctx.repos.sourceVideos.transition(
    sourceVideoId,
    [SourceVideoStatus.PENDING],
    SourceVideoStatus.DETECTING,
  );
  if (!moved) return;

  const video = await ctx.repos.sourceVideos.byId(sourceVideoId);
  if (!video) return;
  const spec = (video.storySpec as AnimSpecShape | null) ?? null;
  const shots = (spec?.shots ?? []).filter((s) => s?.text?.trim() && s?.motionPrompt?.trim());
  if (!spec || shots.length === 0) {
    await failVideo(ctx, sourceVideoId, new Error("anim video has no approved shots"));
    return;
  }

  const workDir = join(ctx.workRoot, sourceVideoId);
  const setProgress = async (stage: string, pct: number, extra?: Record<string, unknown>) => {
    const cur = await ctx.repos.sourceVideos.byId(sourceVideoId);
    if (!cur || cur.status !== SourceVideoStatus.DETECTING) throw new StoryCancelledError();
    await ctx.repos.sourceVideos.update(sourceVideoId, {
      storySpec: { ...spec, ...extra, progress: { stage, pct } } as never,
    });
  };
  try {
    await fs.mkdir(workDir, { recursive: true });
    const style = spec.style ?? "stick-scene";
    const setting = spec.setting ?? "";
    const cast = spec.cast ?? "";

    // 1. One continuous narration take (no per-beat seams), same as stories.
    await setProgress("Recording the narration", 8);
    const tts = ctx.ttsFor(spec.voiceTier ?? "standard");
    const narrator = spec.narrator ?? "storyteller";
    const fullText = shots.map((s) => s.text).join("\n\n");
    const voice = await tts.synthesize({
      text: tts.speaksTags ? fullText : stripAudioTags(fullText),
      instructions: narratorInstruction(narrator),
    });
    const audioFile = join(workDir, `narration.${voice.ext}`);
    await fs.writeFile(audioFile, voice.audio);
    const probedAudio = await probe(audioFile);
    const totalDur = probedAudio.durationSec > 0 ? probedAudio.durationSec : shots.length * 8;

    // 2. Per-beat durations: each clip is trimmed to the narration it carries,
    //    so the picture never drifts away from the words.
    const captionBeats = shots.map((s) => ({ text: stripAudioTags(s.text) }));
    const { slideDurations, captionSegments } = planStoryTiming(captionBeats, totalDur, voice.words);

    // 3. First-frame stills, drawn sequentially and chained: each one is an edit
    //    of the previous frame where the provider supports it, which is what
    //    keeps the same stick figures across independent clips.
    await setProgress("Drawing the frames", 15);
    const seeds: Array<Buffer | null> = shots.map(() => null);
    let prev: Buffer | null = null;
    for (let i = 0; i < shots.length; i++) {
      try {
        const { image } = await ctx.images.generate({
          prompt: styledImagePrompt(shots[i]!.imagePrompt, style, setting),
          ...(prev ? { referenceImage: prev } : {}),
        });
        seeds[i] = image;
        prev = image;
      } catch (err) {
        ctx.logger.warn({ sourceVideoId, shot: i, reason: String(err) }, "anim frame failed; animating from text alone");
      }
      await setProgress(`Drawing the frames (${i + 1}/${shots.length})`, 15 + Math.round(((i + 1) / shots.length) * 15));
    }

    // The first drawn frame is the closest thing we have to a character sheet:
    // it shows the cast in the style every later clip has to match.
    const castSheet = seeds[0];

    // 4. Animate. Concurrency 2 — generation is slow and paid.
    await setProgress("Animating", 30);
    let done = 0;
    let firstError: string | null = null;
    const rendered = await mapWithConcurrency(shots, 2, async (shot, i) => {
      try {
        const seed = seeds[i];
        const f = join(workDir, `shot-${i}.mp4`);
        // The cast sheet rides along with the motion so the labels the planner
        // used ("the tall figure in the brown coat") resolve to the same people
        // the seed frame drew.
        const { video: bytes } = await ctx.animVideo.generate({
          prompt: [
            `Simple 2D stick-figure animation. ${setting}`.trim(),
            cast ? `CAST (unchanged in every shot):\n${cast}` : "",
            `ACTION: ${shot.motionPrompt}`,
            "One continuous shot, no cuts, no camera change, no new characters, no on-screen text.",
          ]
            .filter(Boolean)
            .join("\n"),
          aspectRatio: "9:16",
          ...(seed ? { image: { png: seed } } : {}),
          // The opening frame doubles as a CHARACTER SHEET for every later clip:
          // an asset reference the model consults for the whole shot, not just
          // frame one. Strictly stronger than the first-frame seed alone, and
          // free to attempt — Veo 3.1 Lite rejects the field and the provider
          // sheds it, so this only takes effect on Fast/Standard.
          ...(castSheet && i > 0 ? { referenceImages: [castSheet] } : {}),
          // The default bars human faces — fatal when the cast IS the subject.
          negativePrompt: "on-screen text, subtitles, watermark, logo, photorealistic, blurry, low quality",
        });
        await fs.writeFile(f, bytes);
        done++;
        await setProgress(`Animating (${done}/${shots.length})`, 30 + Math.round((done / shots.length) * 50));
        return f;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        firstError ??= reason;
        ctx.logger.warn({ sourceVideoId, shot: i, reason }, "anim shot failed");
        // Every beat needs a clip: a hole would desync everything after it from
        // the narration. Rather than throw away the other (paid) clips, hold
        // this beat's already-approved frame as a still. Safety filters fire on
        // one shot's wording, not the whole video, so losing all nine because
        // shot two mentioned a real name is the wrong trade.
        const seed = seeds[i];
        if (seed) {
          try {
            const stillPath = join(workDir, `shot-${i}.mp4`);
            const framePath = join(workDir, `frame-${i}.png`);
            await fs.writeFile(framePath, seed);
            await stillClip(framePath, Math.max(1, slideDurations[i] ?? 8), stillPath, workDir);
            ctx.logger.info({ sourceVideoId, shot: i }, "anim shot substituted with its still frame");
            return stillPath;
          } catch (err2) {
            ctx.logger.warn({ sourceVideoId, shot: i, reason: String(err2) }, "still-frame substitute also failed");
          }
        }
        return null;
      }
    });

    // Only fatal if a beat has neither a clip nor a frame to hold.
    const missing = rendered.findIndex((f) => !f);
    if (missing >= 0) {
      await failVideo(
        ctx,
        sourceVideoId,
        new Error(`anim: shot ${missing + 1}/${shots.length} failed. First error — ${firstError ?? "unknown"}`),
      );
      return;
    }

    // 5. Cut them together under the one narration, captions burned in.
    await setProgress("Putting it together", 85);
    const assName = `${sourceVideoId}.ass`;
    const ass = buildAss(
      captionSegments,
      0,
      totalDur,
      spec.captionStyle ?? video.captionStyle,
      3,
      spec.captionPosition ?? (video.captionPosition as "top" | "middle" | "bottom" | undefined),
    );
    if (ass.trim()) await fs.writeFile(join(workDir, assName), ass, "utf8");

    let outPath = join(workDir, "anim.mp4");
    await assembleNarratedClips({
      clips: rendered.map((f, i) => ({ file: f!, durationSec: slideDurations[i]! })),
      audioFile,
      captionsFileName: ass.trim() ? assName : undefined,
      outPath,
      workDir,
    });

    // 5b. Optional music bed under the narration (skips cleanly with no track).
    const musicFile = spec.music ? await resolveMusicFile(spec.music) : null;
    if (musicFile) {
      const withMusic = join(workDir, "anim-music.mp4");
      await mixMusic(outPath, musicFile, withMusic, workDir);
      outPath = withMusic;
      ctx.logger.info({ sourceVideoId, mood: spec.music }, "music bed mixed in");
    }

    // 6. Store + create a ready-to-distribute Clip.
    const thumbPath = join(workDir, "thumb.jpg");
    await extractSmartThumbnail(outPath, thumbPath);
    const title = spec.title || spec.topic || "Animated short";

    const [clip] = await ctx.repos.clips.createMany([
      {
        sourceVideoId,
        campaignId: video.campaignId,
        startSec: 0,
        endSec: totalDur,
        status: ClipStatus.APPROVED,
        detectionReason: title,
        detectionSource: "anim",
        captionStyle: video.captionStyle,
        captionPosition: video.captionPosition,
        commentaryMode: "off",
        category: video.category,
        hookScore: 80,
        viralScore: 80,
        overallScore: 80,
        scoreBreakdown: { notes: ["anim-generated"] } as never,
      },
    ]);
    await ctx.storage.putFile(clipKey(clip!.id), outPath, "video/mp4");
    await ctx.storage.putFile(thumbKey(clip!.id), thumbPath, "image/jpeg");
    await ctx.repos.clips.update(clip!.id, {
      storageKey: clipKey(clip!.id),
      thumbnailKey: thumbKey(clip!.id),
      error: null,
    });
    await ctx.repos.clips.upsertEnhancement(clip!.id, {
      title,
      description: spec.description ?? "",
      hashtags: spec.hashtags ?? [],
      hooks: { variants: [title], selectedIndex: 0 } as never,
      qualityScore: 80,
      viralScore: 80,
      estimatedEngagement: 80,
      model: "anim",
    });

    await ctx.repos.sourceVideos.update(sourceVideoId, {
      status: SourceVideoStatus.PROCESSED,
      storySpec: { ...spec, script: fullText, progress: { stage: "Done", pct: 100 } } as never,
    });
    ctx.logger.info(
      { sourceVideoId, shots: shots.length, durationSec: Number(totalDur.toFixed(1)) },
      "animated video generated",
    );
  } catch (err) {
    if (err instanceof StoryCancelledError) {
      ctx.logger.info({ sourceVideoId }, "anim generation cancelled");
      return;
    }
    await failVideo(ctx, sourceVideoId, err);
    throw err;
  }
}

/** Thrown when a story job notices it was terminated from the queue. */
class StoryCancelledError extends Error {}

/** Run an async mapper over items with bounded concurrency, preserving order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * A blank white PNG card — fallback when image generation fails for a beat.
 * Built with the real PNG encoder (proper CRCs + deflate): the previous
 * hand-crafted base64 bytes had a truncated IDAT, and ffmpeg failing to decode
 * the fallback card killed the entire assembly ("IEND without all image").
 * 90x160 is exact 9:16, so the cover+crop prescale scales it with no cropping.
 */
function plainCardPng(): Buffer {
  return solidPng(90, 160, [255, 255, 255]);
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
      context: assembleContext(clip.sourceVideo.context, clip.sourceVideo.autoContext),
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
