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
  }): Promise<{ sourceVideoId: string }> {
    const campaignId = input.campaignId ?? (await this.getOrCreateDefaultCampaignId());
    // Create the row first so the storage key can use its id.
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      originalFilename: input.filename,
      title: input.filename,
      status: "DOWNLOADING",
    });
    try {
      const meta = await probe(input.localPath);
      const key = `sources/${video.id}/source.mp4`;
      await this.storage.putFile(key, input.localPath, "video/mp4");
      await this.repos.sourceVideos.update(video.id, {
        status: "DOWNLOADED",
        storageKey: key,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        metadata: meta.raw as never,
        error: null,
      });
      await this.dispatcher.enqueue(
        "video.transcribe",
        { sourceVideoId: video.id },
        { jobId: video.id },
      );
      return { sourceVideoId: video.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repos.sourceVideos.update(video.id, { status: "FAILED", error: message });
      throw err;
    } finally {
      await fs.rm(input.localPath, { force: true }).catch(() => {});
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
