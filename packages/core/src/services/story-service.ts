import type { Repositories } from "@clipfactory/db";
import type { LlmProvider } from "@clipfactory/ai";
import type { Dispatcher } from "@clipfactory/queue";
import type { CreateStoryInput } from "../contracts/story.js";

/** Story spec persisted on the SourceVideo (kind=story) and read by the generator. */
export interface StorySpec {
  topic: string;
  style: string;
  voiceTier: string;
  narrator: string;
  targetBeats: number;
  category?: string;
  captionStyle: string;
  captionPosition: "top" | "middle" | "bottom";
  music: string;
  motion: boolean;
}

/**
 * Story Studio: kicks off AI-generated narrated slideshow videos. Creates a
 * SourceVideo (kind=story) so the job shows in the Video Queue and the finished
 * video lands in the Library like any clip.
 */
export class StoryService {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmProvider,
    private readonly dispatcher: Dispatcher,
    private readonly maxBeats: number,
  ) {}

  async suggestTopics(category?: string): Promise<string[]> {
    return this.llm.suggestStoryTopics({ category, count: 8 });
  }

  async create(input: CreateStoryInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateStoryCampaignId();
    const spec: StorySpec = {
      topic: input.topic.trim(),
      style: input.style,
      voiceTier: input.voiceTier,
      narrator: input.narrator,
      targetBeats: Math.min(input.targetBeats, this.maxBeats),
      category: input.category?.trim() || undefined,
      captionStyle: input.captionStyle,
      captionPosition: input.captionPosition,
      music: input.music,
      motion: input.motion,
    };
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: input.topic.trim().slice(0, 120),
      status: "PENDING",
      kind: "story",
      storySpec: spec as never,
      category: spec.category ?? null,
      // Stories carry their own captions/voice; the clip render path is skipped.
      commentaryMode: "off",
    });
    await this.dispatcher.enqueue("story.generate", { sourceVideoId: video.id }, { jobId: video.id });
    return { sourceVideoId: video.id };
  }

  /** A dedicated campaign so generated videos group separately from uploads. */
  private async getOrCreateStoryCampaignId(): Promise<string> {
    const existing = await this.repos.campaigns.list();
    const found = existing.find((c) => c.name === "Story Studio");
    if (found) return found.id;
    const created = await this.repos.campaigns.create({
      name: "Story Studio",
      allowedPlatforms: ["YOUTUBE", "TIKTOK", "INSTAGRAM"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
