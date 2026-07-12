import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { CampaignDto, CreateCampaignInput, UpdateCampaignInput } from "../contracts/index.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { toCampaignDto } from "../mappers.js";

export class CampaignService {
  constructor(
    private readonly repos: Repositories,
    private readonly dispatcher: Dispatcher,
  ) {}

  async list(): Promise<CampaignDto[]> {
    const rows = await this.repos.campaigns.list();
    return rows.map(toCampaignDto);
  }

  async get(id: string): Promise<CampaignDto> {
    const row = await this.repos.campaigns.byId(id);
    if (!row) throw new NotFoundError("Campaign", id);
    return toCampaignDto(row);
  }

  async create(input: CreateCampaignInput): Promise<CampaignDto> {
    const campaign = await this.repos.campaigns.create({
      name: input.name,
      sourceVideoUrl: input.sourceVideoUrl,
      sourcePlatform: input.sourcePlatform,
      allowedPlatforms: input.allowedPlatforms,
      rules: (input.rules ?? undefined) as never,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      status: input.ingestNow ? "ACTIVE" : "DRAFT",
    });

    if (input.ingestNow) {
      await this.ingest(campaign.id);
      const fresh = await this.repos.campaigns.byId(campaign.id);
      return toCampaignDto(fresh!);
    }
    return toCampaignDto(campaign);
  }

  async update(id: string, input: UpdateCampaignInput): Promise<CampaignDto> {
    await this.get(id);
    const updated = await this.repos.campaigns.update(id, {
      name: input.name,
      status: input.status,
      allowedPlatforms: input.allowedPlatforms,
      rules: (input.rules ?? undefined) as never,
      expiresAt:
        input.expiresAt === undefined ? undefined : input.expiresAt ? new Date(input.expiresAt) : null,
    });
    return toCampaignDto(updated);
  }

  /** Kicks off the URL/yt-dlp intake pipeline for the campaign's source video. */
  async ingest(campaignId: string): Promise<{ sourceVideoId: string }> {
    const campaign = await this.repos.campaigns.byId(campaignId);
    if (!campaign) throw new NotFoundError("Campaign", campaignId);
    if (!campaign.sourceVideoUrl) {
      throw new ValidationError(
        "This project has no source URL. Upload a file to /videos/upload instead.",
      );
    }

    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: campaign.sourceVideoUrl,
      status: "PENDING",
    });
    if (campaign.status === "DRAFT") {
      await this.repos.campaigns.update(campaignId, { status: "ACTIVE" });
    }
    await this.dispatcher.enqueue("video.download", { sourceVideoId: video.id }, { jobId: video.id });
    return { sourceVideoId: video.id };
  }
}
