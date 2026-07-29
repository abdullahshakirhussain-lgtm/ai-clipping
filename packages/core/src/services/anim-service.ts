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
  music: string;
  setting: string;
  cast: string;
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
    // Two constraints at once:
    //   - Each beat must fit ONE clip, so ~14-16 spoken words per 6s beat at
    //     ~150wpm keeps the narration and the clip boundaries aligned. A beat
    //     that overruns its clip freezes on the last frame (see the pad in
    //     assembleNarratedClips), which is exactly the static look we're fixing.
    //   - The finished video is trimmed to the NARRATION's length, not to
    //     clips x 6s. So the word floor is what actually decides runtime: at 12
    //     beats that's 168-198 words, about 67-79 seconds, past the 60s line.
    // minBeats is set to the full count because one beat == one paid clip; a
    // short spine would silently cut both the runtime and the shot list.
    const story = await this.llm.writeStory({
      topic: topic.trim(),
      style: chosenStyle,
      maxBeats: this.maxShots,
      minBeats: this.maxShots,
      // 13-15 words per beat at ~150wpm is 5.2-6.0s — deliberately UNDER the 6s
      // clip so a beat doesn't outrun its footage. When it does, the assembler
      // holds the last frame to keep sync, and a frozen tail on every beat is
      // precisely the static look this is meant to fix.
      maxWords: this.maxShots * 15,
      minWords: this.maxShots * 13,
      narrator: "storyteller",
    });
    const { cast, shots } = await this.llm.planAnimationShots({
      setting: story.setting,
      style: chosenStyle,
      beats: story.beats.map((b) => ({ text: b.text, imagePrompt: b.imagePrompt })),
    });
    return {
      title: story.title,
      description: story.description,
      hashtags: story.hashtags,
      setting: story.setting,
      cast,
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
      music: input.music || "none",
      setting: input.setting ?? "",
      cast: input.cast ?? "",
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
