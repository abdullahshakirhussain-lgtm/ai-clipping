import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { TranscriptSegment } from "@clipfactory/ai";
import { ClipStatus, PublishJobStatus, SourceVideoStatus } from "@clipfactory/db";
import {
  analyzeLoudness,
  type CaptionWord,
  extractAudio,
  extractThumbnail,
  findLoudnessPeaks,
  planClipEdit,
  renderClip,
} from "@clipfactory/media";
import type { PublishPlatform } from "@clipfactory/publishers";
import { PublisherNotConfiguredError } from "@clipfactory/publishers";
import { buildAudioCandidates, mergeCandidates, scoreCandidate } from "../detection.js";
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

    // Score every candidate with the transparent model, keep those above the
    // floor, best-first, up to the cap. Clip count now varies with content.
    const scored = merged
      .map((candidate) => ({ candidate, score: scoreCandidate({ candidate, segments, energy }) }))
      .filter((x) => x.candidate.endSec - x.candidate.startSec >= det.minDurationSec)
      .filter((x) => x.score.overallScore >= det.minScore)
      .sort((a, b) => b.score.overallScore - a.score.overallScore)
      .slice(0, det.maxClips);

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
        captionStyle: "bold-center",
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
      hookText: clip.detectionReason ?? undefined,
    });
    let captionsFileName: string | undefined;
    if (plan.ass.trim()) {
      await fs.writeFile(join(workDir, assName), plan.ass, "utf8");
      captionsFileName = assName;
    }

    const baseArgs = {
      inputPath: localSource,
      outPath,
      startSec: clip.startSec,
      endSec: clip.endSec,
      workDir,
    };
    // Progressive fallback so a caption/filter hiccup never loses the clip:
    // full (cuts + captions) → cuts only → plain window.
    try {
      await renderClip({ ...baseArgs, selectSpans: plan.selectSpans, captionsFileName });
    } catch (err) {
      ctx.logger.error({ clipId, err: String(err) }, "full render failed; retrying cuts-only");
      try {
        await renderClip({ ...baseArgs, selectSpans: plan.selectSpans });
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
    await extractThumbnail(outPath, thumbPath, 0.5);

    await ctx.storage.putFile(clipKey(clipId), outPath, "video/mp4");
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
    await Promise.allSettled([fs.rm(outPath, { force: true }), fs.rm(thumbPath, { force: true })]);
  }
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
