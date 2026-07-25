import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { CreateCookInput } from "../contracts/cook.js";

/** Cook spec persisted on the SourceVideo (kind=cook) and read by the generator. */
export interface CookSpec {
  dish: string;
  category?: string;
  aspectRatio: string;
  /** Ceiling on shots (= clips) — the planner uses as many as the recipe needs. */
  maxShots: number;
}

/**
 * Cook Studio: kicks off AI-generated "cook-in-the-wild" videos. Mirrors
 * StoryService — creates a SourceVideo (kind=cook) so the job shows in the Video
 * Queue and the finished video lands in the Library / Distribution like any clip.
 */
export class CookService {
  constructor(
    private readonly repos: Repositories,
    private readonly dispatcher: Dispatcher,
    private readonly maxShots: number,
  ) {}

  async create(input: CreateCookInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateCookCampaignId();
    const spec: CookSpec = {
      dish: input.dish.trim(),
      category: input.category?.trim() || undefined,
      aspectRatio: "9:16",
      maxShots: this.maxShots,
    };
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: input.dish.trim().slice(0, 120),
      status: "PENDING",
      kind: "cook",
      storySpec: spec as never,
      category: spec.category ?? null,
      // Generated video carries its own audio; the clip render path is skipped.
      commentaryMode: "off",
    });
    await this.dispatcher.enqueue("cook.generate", { sourceVideoId: video.id }, { jobId: video.id });
    return { sourceVideoId: video.id };
  }

  /** A dedicated campaign so cook videos group separately from uploads/stories. */
  private async getOrCreateCookCampaignId(): Promise<string> {
    const existing = await this.repos.campaigns.list();
    const found = existing.find((c) => c.name === "Cook Studio");
    if (found) return found.id;
    const created = await this.repos.campaigns.create({
      name: "Cook Studio",
      allowedPlatforms: ["YOUTUBE", "TIKTOK", "INSTAGRAM"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
