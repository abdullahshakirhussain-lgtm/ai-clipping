import type { Repositories } from "@clipfactory/db";
import type { LlmProvider } from "@clipfactory/ai";
import type { Dispatcher } from "@clipfactory/queue";
import type { CreateStoryInput } from "../contracts/story.js";

/** Spoken-word ceiling ≈ 2 minutes at ~150 wpm, with margin so the read lands under. */
/**
 * Slideshows are the LONG-FORM format: ~8 minutes, not a short. At ~150 wpm
 * that's ~1200 spoken words, so the band is 1050-1300 (roughly 7-8.7 minutes).
 *
 * The floor matters as much as the ceiling — the writer is otherwise told
 * shorter is better and will hand back a 40-second story. Narration this long
 * exceeds a single TTS request, so it is synthesized in sentence-aligned chunks
 * and joined (see narration.ts).
 */
const MAX_WORDS = 1300;
const MIN_WORDS = 1050;

/** Story spec persisted on the SourceVideo (kind=story) and read by the generator. */
export interface StorySpec {
  topic: string;
  style: string;
  voiceTier: string;
  narrator: string;
  /** Ceiling on beats — the writer uses as many as the story needs. */
  maxBeats: number;
  maxWords: number;
  /** Word FLOOR, so the narration clears the 60-second line. */
  minWords?: number;
  category?: string;
  captionStyle: string;
  captionPosition: "top" | "middle" | "bottom";
  music: string;
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
      maxBeats: this.maxBeats,
      maxWords: MAX_WORDS,
      minWords: MIN_WORDS,
      category: input.category?.trim() || undefined,
      captionStyle: input.captionStyle,
      captionPosition: input.captionPosition,
      music: input.music,
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
