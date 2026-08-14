import { randomUUID } from "node:crypto";
import type { ImageProvider, LlmProvider, LostPlan } from "@clipfactory/ai";
import { lostStillPrompt } from "@clipfactory/ai";
import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { ObjectStorage } from "@clipfactory/storage";
import type { CreateLostInput, LostPreviewDto, LostPlanRequest } from "../contracts/lost.js";

/** Lost Chronicles spec persisted on the SourceVideo (kind=lost) and read by the generator. */
export interface LostSpec {
  scene: string;
  /** Storage key of the APPROVED still — the exact frame the Veo job animates. */
  stillKey: string;
  stillPrompt: string;
  motionPrompt: string;
  aspectRatio: string;
  title?: string;
  description?: string;
  hashtags?: string[];
  category?: string;
}

/**
 * Lost Chronicles: calm anime Veo shorts, built around a COST GATE so no paid Veo
 * render is wasted. `plan` writes editable prompts (cheap text); `previewStill`
 * renders the anime still and stores it (cheap ~$0.04, iterate freely); `create`
 * enqueues the ONE Veo render of the approved still. Mirrors CookService.
 */
export class LostService {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmProvider,
    private readonly dispatcher: Dispatcher,
    /** For the cheap preview still (gpt-image / the normal image provider). */
    private readonly images: ImageProvider,
    /** Persist the approved still so the job animates the EXACT frame the user saw. */
    private readonly storage: ObjectStorage,
  ) {}

  /** Step 1: scene → editable still + motion prompts + caption (no spend but text). */
  async plan(input: LostPlanRequest): Promise<LostPlan> {
    return this.llm.planLostScene({ scene: input.scene.trim(), direction: input.direction?.trim() || undefined });
  }

  /** Step 2: render the anime still and store it. Cheap — call as many times as
   *  needed until the frame is perfect; each call is a fresh still. */
  async previewStill(stillPrompt: string): Promise<LostPreviewDto> {
    const { image } = await this.images.generate({
      prompt: lostStillPrompt(stillPrompt, "portrait"),
      size: "1024x1536",
    });
    const stillKey = `lost-still/${randomUUID()}.png`;
    await this.storage.putBuffer(stillKey, image, "image/png");
    return { stillKey, url: await this.storage.getUrl(stillKey) };
  }

  /** Step 3: enqueue the ONE Veo render of the approved still. */
  async create(input: CreateLostInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateCampaignId();
    const spec: LostSpec = {
      scene: input.scene.trim(),
      stillKey: input.stillKey,
      stillPrompt: input.stillPrompt,
      motionPrompt: input.motionPrompt,
      aspectRatio: "9:16",
      title: input.title?.trim() || undefined,
      description: input.description?.trim() || undefined,
      hashtags: input.hashtags,
      category: input.category?.trim() || undefined,
    };
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: (input.title?.trim() || input.scene.trim()).slice(0, 120),
      status: "PENDING",
      kind: "lost",
      storySpec: spec as never,
      category: spec.category ?? null,
      commentaryMode: "off",
    });
    await this.dispatcher.enqueue("lost.generate", { sourceVideoId: video.id }, { jobId: video.id });
    return { sourceVideoId: video.id };
  }

  private async getOrCreateCampaignId(): Promise<string> {
    const existing = await this.repos.campaigns.list();
    const found = existing.find((c) => c.name === "Lost Chronicles");
    if (found) return found.id;
    const created = await this.repos.campaigns.create({
      name: "Lost Chronicles",
      allowedPlatforms: ["YOUTUBE", "TIKTOK", "INSTAGRAM"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
