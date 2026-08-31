import { randomUUID } from "node:crypto";
import type { ImageProvider, LlmProvider } from "@clipfactory/ai";
import { DEFAULT_STYLE, styleAnchor, styledImagePrompt } from "@clipfactory/ai";
import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { ObjectStorage } from "@clipfactory/storage";
import type { ManualPlanDto, ManualPlanRequest } from "../contracts/manual.js";

/** Manual clip spec persisted on the SourceVideo (kind="manual"). */
export interface ManualSpec {
  manual: true;
  format: "video" | "cook" | "pov";
  title: string;
  description: string;
  hashtags: string[];
  aspect: "16:9" | "9:16";
  /** Ordered clip prompts the user copies to a gen platform. */
  clips: Array<{ prompt: string; seconds: number }>;
  /** Video only: the full narration → voiceover synthesized at assemble time. */
  narrationText?: string;
  /** Video/cook: storage key of the single character reference image. */
  characterRefKey?: string;
  /** Optional: multiple character reference image keys (unused by experiential POV). */
  characterRefKeys?: string[];
  /** POV only: the cinematic intro hook the Veo prompt renders + fades. */
  hook?: string;
  /** POV only: one-sentence summary shown for approval before the prompts. */
  logline?: string;
  /** POV only: short per-clip labels (what each beat shows), for the summary. */
  beatLabels?: string[];
  /** Storage keys of uploaded clips, index-aligned to `clips` (null = pending). */
  uploaded: Array<string | null>;
  category?: string;
  progress?: { stage: string; pct: number };
}

/**
 * Manual clip workflow: automate everything but the paid video generation. `plan`
 * writes the script + per-clip prompts (+ a character reference and voiceover for
 * Video) and persists them WITHOUT enqueuing — the SourceVideo waits for the user
 * to upload each clip (`addClip`); `assemble` then stitches them.
 */
export class ManualService {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmProvider,
    private readonly dispatcher: Dispatcher,
    private readonly images: ImageProvider,
    private readonly storage: ObjectStorage,
    private readonly animMaxShots: number,
    private readonly cookMaxShots: number,
  ) {}

  async plan(input: ManualPlanRequest): Promise<ManualPlanDto> {
    const campaignId = await this.getOrCreateCampaignId();
    const spec =
      input.format === "video"
        ? await this.planVideo(input)
        : input.format === "pov"
          ? await this.planPov(input)
          : await this.planCook(input);

    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: (spec.title || input.topic).slice(0, 120),
      // status PENDING but NOT enqueued — it waits for the user to upload clips.
      status: "PENDING",
      kind: "manual",
      storySpec: spec as never,
      category: spec.category ?? null,
      commentaryMode: "off",
    });

    return this.toDto(video.id, spec);
  }

  /** Video: script → anim shots → clip prompts + character ref + narration text. */
  private async planVideo(input: ManualPlanRequest): Promise<ManualSpec> {
    const maxShots = input.length === "long" ? Math.min(this.animMaxShots, 16) : 6;
    const aspect: "16:9" | "9:16" = input.length === "long" ? "16:9" : "9:16";
    const style = DEFAULT_STYLE;
    const story = await this.llm.writeStory({
      topic: input.topic.trim(),
      direction: input.direction?.trim() || undefined,
      style,
      maxBeats: maxShots,
      minBeats: maxShots,
      maxWords: maxShots * 15,
      minWords: maxShots * 13,
      narrator: "storyteller",
    });
    const { cast, shots } = await this.llm.planAnimationShots({
      setting: story.setting,
      style,
      beats: story.beats.map((b) => ({ text: b.text, imagePrompt: b.imagePrompt })),
    });

    // One character reference image the user uploads to the gen platform so the
    // same figure carries across every clip (the whole "single reference" trick).
    let characterRefKey: string | undefined;
    try {
      const { image } = await this.images.generate({
        prompt: styledImagePrompt(
          `${cast}. Full-body character reference, standing, neutral plain background`,
          style,
          story.setting,
          aspect === "16:9" ? "landscape" : "portrait",
        ),
        size: aspect === "16:9" ? "1536x1024" : "1024x1536",
      });
      characterRefKey = `manual-ref/${randomUUID()}.png`;
      await this.storage.putBuffer(characterRefKey, image, "image/png");
    } catch {
      /* the reference is a convenience — a failure just omits it */
    }

    const clips = shots.slice(0, maxShots).map((s) => ({
      prompt: `${cast}. Scene: ${story.setting}. ${s.imagePrompt}. Motion over ~8 seconds: ${s.motionPrompt}. Keep the character identical to the reference image; no on-screen text.`,
      seconds: 8,
    }));

    return {
      manual: true,
      format: "video",
      title: story.title,
      description: story.description,
      hashtags: story.hashtags,
      aspect,
      clips,
      narrationText: shots.slice(0, maxShots).map((s) => s.text).join(" "),
      characterRefKey,
      uploaded: clips.map(() => null),
      category: input.category?.trim() || undefined,
    };
  }

  /** Cook: the shot planner → per-shot video prompts. Native clip audio, no VO. */
  private async planCook(input: ManualPlanRequest): Promise<ManualSpec> {
    const maxShots = input.length === "long" ? this.cookMaxShots : Math.min(4, this.cookMaxShots);
    const plan = await this.llm.planCookShots({ dish: input.topic.trim(), maxShots, aspectRatio: "9:16" });
    const clips = plan.shots.slice(0, maxShots).map((s) => ({ prompt: s.prompt, seconds: 8 }));
    return {
      manual: true,
      format: "cook",
      title: plan.title,
      description: plan.description,
      hashtags: plan.hashtags,
      aspect: "9:16",
      clips,
      uploaded: clips.map(() => null),
      category: input.category?.trim() || undefined,
    };
  }

  /**
   * Experiential POV short: a realistic, immersive "you are here" vibe piece in
   * ONE place (a rainy cabin morning, a quiet bookshop at closing). 9:16, native
   * clip audio (no voiceover, no music), NO on-screen text — the atmosphere is the
   * whole product. No character reference: the setting is held via the scene lock
   * + last-frame chaining on the gen platform, not a trademark figure.
   */
  private async planPov(input: ManualPlanRequest): Promise<ManualSpec> {
    const maxShots = 8;
    const anchor = styleAnchor("pov-real");
    const plan = await this.llm.planPovShort({
      topic: input.topic.trim(),
      direction: input.direction?.trim() || undefined,
      maxShots,
    });
    // A plan with no beats can't be uploaded/assembled — fail loudly so the client
    // shows an error to retry, rather than persisting a broken 0-clip plan.
    if (plan.shots.length === 0) {
      throw new Error("The POV planner returned no beats — try again or adjust the scene/description.");
    }

    // The immutable scene lock, prepended byte-identical to every clip so the
    // separately-generated clips share one place/light/atmosphere/outfit.
    const bible = plan.sceneBible.trim();
    const clips = plan.shots.slice(0, maxShots).map((s, i) => {
      // Spatial link to the previous beat so the clips read as one continuous stay
      // in the same place, each picking up where the last left off.
      const prev = i > 0 ? plan.shots[i - 1] : null;
      const continues = prev
        ? `CONTINUES the same unbroken moment in the same place — you have just come from "${prev.scene}"; same light, same weather, no jump in time.`
        : "";
      const prompt = [
        `First-person POV. ${plan.logline || `A calm moment in ${input.topic.trim()}.`}`,
        bible ? `LOCKED SCENE (identical every clip): ${bible}` : "",
        continues,
        `THIS BEAT — ${s.scene}.`,
        `Motion over ~8 seconds: ${s.motion}.`,
        `The camera stays STRICTLY first-person the entire clip — your own eyes looking forward; it NEVER pulls back, orbits, or cuts to a third-person/outside view, and your torso, head or full body are never shown (only forearms/hands from the lower edge).`,
        `Ambient sound: ${s.audio}. Native sound only — no music, no voices.`,
        `No on-screen text, no subtitles, no captions, no watermark.`,
        `Style: ${anchor}`,
        `Vertical 9:16 portrait.`,
      ].filter(Boolean).join(" ");
      return { prompt, seconds: 8 };
    });

    return {
      manual: true,
      format: "pov",
      title: plan.title,
      description: plan.description,
      hashtags: plan.hashtags,
      aspect: "9:16",
      clips,
      logline: plan.logline || undefined,
      beatLabels: plan.shots.slice(0, maxShots).map((s) => s.scene),
      uploaded: clips.map(() => null),
      category: input.category?.trim() || undefined,
    };
  }

  /** Reload the plan for the step-through UI. */
  async status(sourceVideoId: string): Promise<ManualPlanDto> {
    const video = await this.repos.sourceVideos.byId(sourceVideoId);
    if (!video) throw new Error("manual video not found");
    return this.toDto(sourceVideoId, video.storySpec as unknown as ManualSpec);
  }

  /** Store one uploaded clip at its index; returns the updated upload state. */
  async addClip(sourceVideoId: string, index: number, localPath: string): Promise<{ uploaded: Array<string | null>; total: number; complete: boolean }> {
    const video = await this.repos.sourceVideos.byId(sourceVideoId);
    if (!video) throw new Error("manual video not found");
    const spec = video.storySpec as unknown as ManualSpec;
    if (index < 0 || index >= spec.clips.length) throw new Error("clip index out of range");
    const key = `manual-clip/${sourceVideoId}/${index}.mp4`;
    await this.storage.putFile(key, localPath, "video/mp4");
    const uploaded = [...spec.uploaded];
    uploaded[index] = key;
    await this.repos.sourceVideos.update(sourceVideoId, { storySpec: { ...spec, uploaded } as never });
    return { uploaded, total: spec.clips.length, complete: uploaded.every(Boolean) };
  }

  /** Kick off the assembly job once every clip is uploaded. */
  async assemble(sourceVideoId: string): Promise<{ sourceVideoId: string }> {
    const video = await this.repos.sourceVideos.byId(sourceVideoId);
    if (!video) throw new Error("manual video not found");
    const spec = video.storySpec as unknown as ManualSpec;
    if (!spec.uploaded.every(Boolean)) throw new Error("upload every clip before assembling");
    await this.dispatcher.enqueue("manual.assemble", { sourceVideoId }, { jobId: sourceVideoId });
    return { sourceVideoId };
  }

  private async toDto(sourceVideoId: string, spec: ManualSpec): Promise<ManualPlanDto> {
    // POV carries multiple canonical refs; video/cook carry a single one. Normalise
    // to a URL list, with characterRefUrl kept as the first for back-compat.
    const keys = spec.characterRefKeys ?? (spec.characterRefKey ? [spec.characterRefKey] : []);
    const characterRefUrls = await Promise.all(keys.map((k) => this.storage.getUrl(k)));
    return {
      sourceVideoId,
      format: spec.format,
      title: spec.title,
      aspect: spec.aspect,
      clips: spec.clips,
      characterRefUrl: characterRefUrls[0] ?? null,
      characterRefUrls,
      hook: spec.hook ?? null,
      logline: spec.logline ?? null,
      beatLabels: spec.beatLabels ?? [],
      uploaded: spec.uploaded,
    };
  }

  private async getOrCreateCampaignId(): Promise<string> {
    const existing = await this.repos.campaigns.list();
    const found = existing.find((c) => c.name === "Manual Studio");
    if (found) return found.id;
    const created = await this.repos.campaigns.create({
      name: "Manual Studio",
      allowedPlatforms: ["YOUTUBE", "TIKTOK", "INSTAGRAM"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
