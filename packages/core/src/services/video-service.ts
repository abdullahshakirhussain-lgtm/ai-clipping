import { promises as fs } from "node:fs";
import type { Repositories, SourceVideoStatus } from "@clipfactory/db";
import { probe } from "@clipfactory/media";
import type { Dispatcher } from "@clipfactory/queue";
import type { ObjectStorage } from "@clipfactory/storage";
import type { SourceVideoDto, TranscriptSegmentDto } from "../contracts/index.js";
import { NotFoundError } from "../errors.js";
import { toSourceVideoDto } from "../mappers.js";

export interface SourceVideoDetail extends SourceVideoDto {
  transcript: { language: string; fullText: string; segments: TranscriptSegmentDto[] } | null;
}

/** Default project every direct upload lands in ("upload and go"). */
const DEFAULT_PROJECT_NAME = "My Uploads";

export class VideoService {
  constructor(
    private readonly repos: Repositories,
    private readonly storage: ObjectStorage,
    private readonly dispatcher: Dispatcher,
  ) {}

  async list(filter?: { campaignId?: string; status?: SourceVideoStatus }): Promise<SourceVideoDto[]> {
    const rows = await this.repos.sourceVideos.list(filter);
    return rows.map(toSourceVideoDto);
  }

  async get(id: string): Promise<SourceVideoDetail> {
    const v = await this.repos.sourceVideos.byId(id);
    if (!v) throw new NotFoundError("SourceVideo", id);
    return {
      ...toSourceVideoDto({ ...v, _count: { clips: v.clips.length } }),
      transcript: v.transcript
        ? {
            language: v.transcript.language,
            fullText: v.transcript.fullText,
            segments: (v.transcript.segments as unknown as TranscriptSegmentDto[]) ?? [],
          }
        : null,
    };
  }

  /**
   * Ingest a video the user uploaded directly (their own file). The file is
   * already saved to `localPath`; we probe it, push it to storage, and jump the
   * pipeline straight to transcription — skipping the yt-dlp download stage.
   */
  async ingestUpload(input: {
    localPath: string;
    filename: string;
    campaignId?: string;
    captionStyle?: string;
    captionPosition?: string;
    reframe?: boolean;
    autoEnhance?: boolean;
    subtitlesOnly?: boolean;
    category?: string;
  }): Promise<{ sourceVideoId: string }> {
    const campaignId = input.campaignId ?? (await this.getOrCreateDefaultCampaignId());
    // Create the row immediately so the video shows up in the queue at once.
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      originalFilename: input.filename,
      title: input.filename,
      status: "PENDING",
      captionStyle: input.captionStyle ?? "bold-center",
      captionPosition: input.captionPosition ?? "bottom",
      reframe: input.reframe ?? false,
      autoEnhance: input.autoEnhance ?? false,
      subtitlesOnly: input.subtitlesOnly ?? false,
      category: input.category?.trim() || null,
    });
    // Probing + copying a large file to storage can take tens of seconds — far
    // longer than a proxy will hold the request open (Railway closes long
    // uploads → HTTP 499). So respond NOW and finish the heavy work in the
    // background; the video's status advances as it processes.
    void this.finishIngest(video.id, input.localPath);
    return { sourceVideoId: video.id };
  }

  /** Background: probe the uploaded file, push it to storage, start the pipeline. */
  private async finishIngest(videoId: string, localPath: string): Promise<void> {
    try {
      await this.repos.sourceVideos.update(videoId, { status: "DOWNLOADING" });
      const meta = await probe(localPath);
      const key = `sources/${videoId}/source.mp4`;
      await this.storage.putFile(key, localPath, "video/mp4");
      await this.repos.sourceVideos.update(videoId, {
        status: "DOWNLOADED",
        storageKey: key,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        metadata: meta.raw as never,
        error: null,
      });
      await this.dispatcher.enqueue("video.transcribe", { sourceVideoId: videoId }, { jobId: videoId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repos.sourceVideos
        .update(videoId, { status: "FAILED", error: message })
        .catch(() => {});
    } finally {
      await fs.rm(localPath, { force: true }).catch(() => {});
    }
  }

  private async getOrCreateDefaultCampaignId(): Promise<string> {
    const campaigns = await this.repos.campaigns.list();
    const existing = campaigns.find((c) => c.name === DEFAULT_PROJECT_NAME);
    if (existing) return existing.id;
    const created = await this.repos.campaigns.create({
      name: DEFAULT_PROJECT_NAME,
      sourceVideoUrl: null,
      allowedPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
