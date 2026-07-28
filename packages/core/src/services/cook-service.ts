import type { CookPlan, LlmProvider } from "@clipfactory/ai";
import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { CreateCookInput } from "../contracts/cook.js";

/** Cook spec persisted on the SourceVideo (kind=cook) and read by the generator. */
export interface CookSpec {
  dish: string;
  category?: string;
  aspectRatio: string;
  /** The APPROVED (possibly user-edited) shot prompts — the job renders these as-is. */
  shots: Array<{ prompt: string; imagePrompt?: string }>;
  title?: string;
  description?: string;
  hashtags?: string[];
}

/**
 * Cook Studio: AI cook-in-the-wild videos, two-step so the user reviews the
 * prompts before any pricey video call. `plan` writes the shot prompts (cheap
 * LLM); `create` renders the approved prompts (expensive video). Mirrors
 * StoryService for the create → SourceVideo → job → Clip machinery.
 */
export class CookService {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmProvider,
    private readonly dispatcher: Dispatcher,
    private readonly maxShots: number,
  ) {}

  /** Step 1: plan editable shot prompts from a dish (no video spend yet). */
  async plan(dish: string): Promise<CookPlan> {
    return this.llm.planCookShots({ dish: dish.trim(), maxShots: this.maxShots, aspectRatio: "9:16" });
  }

  /** Step 2: render the video from the approved (possibly edited) shots. */
  async create(input: CreateCookInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateCookCampaignId();
    const spec: CookSpec = {
      dish: input.dish.trim(),
      category: input.category?.trim() || undefined,
      aspectRatio: "9:16",
      shots: input.shots.map((s) => ({ prompt: s.prompt, imagePrompt: s.imagePrompt })),
      title: input.title?.trim() || undefined,
      description: input.description?.trim() || undefined,
      hashtags: input.hashtags,
    };
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: (input.title?.trim() || input.dish.trim()).slice(0, 120),
      status: "PENDING",
      kind: "cook",
      storySpec: spec as never,
      category: spec.category ?? null,
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
