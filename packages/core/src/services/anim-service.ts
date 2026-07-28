import { DEFAULT_STYLE, type AnimPlan, type LlmProvider } from "@clipfactory/ai";
import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { CreateAnimInput } from "../contracts/anim.js";

/** Anim spec persisted on the SourceVideo (kind=anim) and read by the generator. */
export interface AnimSpec {
  topic: string;
  style: string;
  narrator: string;
  voiceTier: string;
  setting: string;
  /** The APPROVED shots — rendered as-is, never re-planned. */
  shots: Array<{ text: string; imagePrompt: string; motionPrompt: string }>;
  title?: string;
  description?: string;
  hashtags?: string[];
  category?: string;
  captionStyle?: string;
  captionPosition?: "top" | "middle" | "bottom";
  script?: string;
}

/**
 * Animated stick shorts: one generated video clip per narrated beat, so the
 * figures actually move instead of a still holding the screen. Two-step like
 * Cook and Call — `plan` writes the story and the shot list (cheap text),
 * `create` renders the approved shots (~$0.40 a clip on Veo 3.1 Lite).
 */
export class AnimService {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmProvider,
    private readonly dispatcher: Dispatcher,
    /** Clips per video; each is ~8s, so this sets the runtime. */
    private readonly maxShots: number,
  ) {}

  /** Step 1: topic → story → per-beat first-frame + motion prompts. No video spend. */
  async plan(topic: string, style?: string): Promise<AnimPlan> {
    const chosenStyle = style || DEFAULT_STYLE;
    // Beats must each fit ONE ~8s clip, so the writer gets a tight word budget:
    // ~20 spoken words per beat at ~150wpm. That is what makes the narration and
    // the clip boundaries line up instead of drifting apart.
    const story = await this.llm.writeStory({
      topic: topic.trim(),
      style: chosenStyle,
      maxBeats: this.maxShots,
      maxWords: this.maxShots * 20,
      narrator: "storyteller",
    });
    const shots = await this.llm.planAnimationShots({
      setting: story.setting,
      style: chosenStyle,
      beats: story.beats.map((b) => ({ text: b.text, imagePrompt: b.imagePrompt })),
    });
    return {
      title: story.title,
      description: story.description,
      hashtags: story.hashtags,
      setting: story.setting,
      shots: shots.slice(0, this.maxShots),
    };
  }

  /** Step 2: render the video from the approved shots. */
  async create(input: CreateAnimInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateAnimCampaignId();
    const spec: AnimSpec = {
      topic: input.topic.trim(),
      style: input.style || DEFAULT_STYLE,
      narrator: input.narrator || "storyteller",
      voiceTier: input.voiceTier || "standard",
      setting: input.setting ?? "",
      shots: input.shots.map((s) => ({
        text: s.text,
        imagePrompt: s.imagePrompt,
        motionPrompt: s.motionPrompt,
      })),
      title: input.title?.trim() || undefined,
      description: input.description?.trim() || undefined,
      hashtags: input.hashtags,
      category: input.category?.trim() || undefined,
      captionStyle: input.captionStyle,
      captionPosition: input.captionPosition,
    };
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: (spec.title || spec.topic).slice(0, 120),
      status: "PENDING",
      kind: "anim",
      storySpec: spec as never,
      category: spec.category ?? null,
      commentaryMode: "off",
      ...(spec.captionStyle ? { captionStyle: spec.captionStyle } : {}),
      ...(spec.captionPosition ? { captionPosition: spec.captionPosition } : {}),
    });
    await this.dispatcher.enqueue("anim.generate", { sourceVideoId: video.id }, { jobId: video.id });
    return { sourceVideoId: video.id };
  }

  private async getOrCreateAnimCampaignId(): Promise<string> {
    const existing = await this.repos.campaigns.list();
    const found = existing.find((c) => c.name === "Animation Studio");
    if (found) return found.id;
    const created = await this.repos.campaigns.create({
      name: "Animation Studio",
      allowedPlatforms: ["YOUTUBE", "TIKTOK", "INSTAGRAM"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
