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
  /** Video/pov: storage key of the character reference image. */
  characterRefKey?: string;
  /** POV only: the cinematic intro hook the Veo prompt renders + fades. */
  hook?: string;
  /** POV only: one-sentence summary shown for approval before the prompts. */
  logline?: string;
  /** POV only: short per-clip labels (what each beat shows), for the summary. */
  beatLabels?: string[];
  /** POV only: the informative overlay lines (also asked for on-screen in Veo). */
  facts?: string[];
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
   * POV short: "you wake up in <place/time>". Trademark first-person stick-figure
   * look, 9:16, native clip audio (NO voiceover). The place/date and the facts are
   * rendered ON SCREEN BY VEO — a cinematic intro title that fades out, and brief
   * fading captions — so nothing is burned in post.
   */
  private async planPov(input: ManualPlanRequest): Promise<ManualSpec> {
    // A POV short is a minute-plus journey: 8s per clip → 12 clips ≈ 96s.
    const maxShots = 12;
    const style = "stick-fpv";
    const anchor = styleAnchor(style);
    const plan = await this.llm.planPovShort({
      topic: input.topic.trim(),
      direction: input.direction?.trim() || undefined,
      maxShots,
    });

    const hookParts = [plan.place, plan.date, plan.timeOfDay].map((s) => s.trim()).filter(Boolean);
    const hook = hookParts.join(" · ");

    // The immutable world lock, prepended byte-identical to every clip so the 12
    // separately-generated clips share one weather/time/light/outfit. Continuity
    // across cuts lives here — the strongest lever when clips are made apart.
    const bible = plan.worldBible.trim();
    const clips = plan.shots.slice(0, maxShots).map((s, i) => {
      // On-screen text is rendered by the video model, then removed — like a film's
      // establishing card. The opening beat carries the place/date title; later
      // beats carry one short informative caption each.
      const onScreen =
        i === 0
          ? `ON-SCREEN TEXT: as the shot opens, an elegant cinematic title fades in — "${plan.place}"${plan.date ? `, and below it "${plan.date}${plan.timeOfDay ? ` · ${plan.timeOfDay}` : ""}"` : ""} — held briefly like a film's establishing title card, then gently DISSOLVES AWAY before the shot ends. No other text.`
          : plan.facts[i - 1]
            ? `ON-SCREEN TEXT: a small clean caption fades in reading "${plan.facts[i - 1]}", holds about two seconds, then fades out. No other text.`
            : `No on-screen text, no subtitles, no watermark.`;
      const prompt = [
        `First-person POV. You are ${plan.role || "an ordinary person"} in ${plan.place}.`,
        bible ? `LOCKED WORLD (identical every clip): ${bible}` : "",
        `THIS BEAT — ${s.scene}.`,
        `Motion over ~8 seconds: ${s.motion}.`,
        `Ambient sound: ${s.audio}.`,
        onScreen,
        `Style: ${anchor}`,
        `Vertical 9:16 portrait.`,
      ].filter(Boolean).join(" ");
      return { prompt, seconds: 8 };
    });

    // A reference for the trademark hands so they read the same across clips.
    let characterRefKey: string | undefined;
    try {
      const { image } = await this.images.generate({
        prompt: styledImagePrompt(
          "your own two flat cartoon stick-figure hands held up in front of you, palms toward the camera",
          style,
          `${plan.place}. ${plan.shots[0]?.scene ?? ""}`,
          "portrait",
        ),
        size: "1024x1536",
      });
      characterRefKey = `manual-ref/${randomUUID()}.png`;
      await this.storage.putBuffer(characterRefKey, image, "image/png");
    } catch {
      /* the reference is a convenience — a failure just omits it */
    }

    return {
      manual: true,
      format: "pov",
      title: plan.title,
      description: plan.description,
      hashtags: plan.hashtags,
      aspect: "9:16",
      clips,
      characterRefKey,
      hook: hook || undefined,
      logline: plan.logline || undefined,
      beatLabels: plan.shots.slice(0, maxShots).map((s) => s.scene),
      facts: plan.facts,
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
    return {
      sourceVideoId,
      format: spec.format,
      title: spec.title,
      aspect: spec.aspect,
      clips: spec.clips,
      characterRefUrl: spec.characterRefKey ? await this.storage.getUrl(spec.characterRefKey) : null,
      hook: spec.hook ?? null,
      logline: spec.logline ?? null,
      beatLabels: spec.beatLabels ?? [],
      facts: spec.facts ?? [],
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
