import type { Repositories } from "@clipfactory/db";
import type { LlmProvider } from "@clipfactory/ai";
import type { Dispatcher } from "@clipfactory/queue";
import type { CreateStoryInput } from "../contracts/story.js";

/**
 * Everything that differs between a long-form 16:9 explainer and a vertical
 * Short. `length` is the single knob the user picks; these are the derived shape.
 *
 * LONG is the ~8-minute format: at ~150 wpm that's ~1200 words (band 1050-1300).
 * Each beat becomes ONE distinct illustration, so ~50 beats ≈ a new picture every
 * ~10s — matching the reference channels. Narration this long exceeds a single
 * TTS request, so it's synthesized in sentence-aligned chunks and joined
 * (narration.ts). SHORT is a 9:16 clip of ~70-90s (150-220 words, ~14 beats),
 * comfortably over the 60s monetization line.
 *
 * The word FLOOR matters as much as the ceiling: the writer is otherwise told
 * shorter is better and hands back a stub.
 */
export type StoryLength = "long" | "short";

export interface LengthPreset {
  aspect: "16:9" | "9:16";
  /** OpenAI image size matching the aspect (landscape 3:2 vs portrait 2:3). */
  imageSize: string;
  maxBeats: number;
  minWords: number;
  maxWords: number;
}

/** `long`'s maxBeats is filled from the env cap at construction (see below). */
export function lengthPreset(length: StoryLength, longMaxBeats: number): LengthPreset {
  // SHORT is the default we publish. The band is relaxed upward (200-360 words,
  // ~90s-2.5min) so a story can run as long as a COMPLETE telling needs rather
  // than being cut short — a solid finished story beats a tight stub.
  return length === "short"
    ? { aspect: "9:16", imageSize: "1024x1536", maxBeats: 24, minWords: 200, maxWords: 360 }
    : { aspect: "16:9", imageSize: "1536x1024", maxBeats: longMaxBeats, minWords: 1050, maxWords: 1300 };
}

/** Story spec persisted on the SourceVideo (kind=story) and read by the generator. */
export interface StorySpec {
  topic: string;
  /** "scenario" (immersive explainer, default) or "story" (dramatic true story). */
  mode: "scenario" | "story";
  length: StoryLength;
  /** "16:9" (long) or "9:16" (short) — drives image, assembly and caption canvas. */
  aspect: "16:9" | "9:16";
  /** OpenAI image size matching the aspect. */
  imageSize: string;
  style: string;
  narrator: string;
  /** Ceiling on beats — the writer uses as many as the story needs. */
  maxBeats: number;
  maxWords: number;
  /** Word FLOOR, so the narration clears the 60-second line. */
  minWords?: number;
  category?: string;
  captionStyle: string;
  captionPosition: "top" | "middle" | "bottom";
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
    // Pass the recently-used topics so the model doesn't keep proposing the same
    // handful — the repetition the user hit came from sending no history at all.
    const recent = await this.repos.sourceVideos.list();
    const avoid = recent
      .filter((v) => v.kind === "story")
      .map((v) => v.title)
      .filter((t): t is string => !!t)
      .slice(0, 20);
    return this.llm.suggestStoryTopics({ category, count: 8, avoid });
  }

  async create(input: CreateStoryInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateStoryCampaignId();
    const preset = lengthPreset(input.length, this.maxBeats);
    const spec: StorySpec = {
      topic: input.topic.trim(),
      mode: input.mode,
      length: input.length,
      aspect: preset.aspect,
      imageSize: preset.imageSize,
      style: input.style,
      narrator: input.narrator,
      maxBeats: preset.maxBeats,
      maxWords: preset.maxWords,
      minWords: preset.minWords,
      category: input.category?.trim() || undefined,
      captionStyle: input.captionStyle,
      captionPosition: input.captionPosition,
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
