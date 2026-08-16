import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageProvider, LlmProvider, LostPlan } from "@clipfactory/ai";
import { lostStillPrompt, lostGptPrompt, LOST_RESTYLE_PROMPT } from "@clipfactory/ai";
import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { ObjectStorage } from "@clipfactory/storage";
import { LOST_SCENES, type CreateLostInput, type LostPreviewDto, type LostPlanRequest } from "../contracts/lost.js";

/** Reject if `p` hasn't settled in `ms` — a slow model call can't hang the
 *  interactive Suggest button past the proxy's cutoff. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function pickFallbackScenes(n: number): string[] {
  return [...LOST_SCENES].sort(() => Math.random() - 0.5).slice(0, n);
}

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
    /** Default still model (gpt-image) — used when the fal LoRA isn't configured. */
    private readonly images: ImageProvider,
    /** Persist the approved still so the job animates the EXACT frame the user saw. */
    private readonly storage: ObjectStorage,
    /** Preferred still model: a fal Flux STYLE-LoRA / anime checkpoint for the real
     *  Ghibli look (LOST_LORA_URL). null → falls back to `images` (gpt-image). */
    private readonly lostImages?: ImageProvider | null,
    /** Optional LoRA style trigger word, prepended to the prompt. */
    private readonly styleTrigger?: string,
    /** LIGHT img2img strength for the Ghibli restyle (~0.3): strong enough to add
     *  vibrant graphics, light enough to KEEP the people gpt-image drew. */
    private readonly restyleStrength = 0.3,
  ) {}

  /** Suggest peaceful lived-in community scenes (present-day off-grid AND peaceful
   *  past). Always returns something — model, else a canned set — under a deadline. */
  async suggestScenes(hint?: string): Promise<string[]> {
    try {
      const scenes = await withDeadline(this.llm.suggestLostScenes({ hint: hint?.trim() || undefined, count: 8 }), 18000);
      return scenes.length ? scenes : pickFallbackScenes(8);
    } catch {
      return pickFallbackScenes(8);
    }
  }

  /** Step 1: scene → editable still + motion prompts + caption (no spend but text). */
  async plan(input: LostPlanRequest): Promise<LostPlan> {
    return this.llm.planLostScene({ scene: input.scene.trim(), direction: input.direction?.trim() || undefined });
  }

  /** Step 2: render the anime still and store it. Cheap — call as many times as
   *  needed until the frame is perfect; each call is a fresh still. */
  async previewStill(stillPrompt: string): Promise<LostPreviewDto> {
    // STAGE 1 — gpt-image draws the PEOPLE + an accurate village, cool and uncrowded
    // (the Ghibli LoRA alone can't populate a scene; gpt-image can).
    const gpt = await this.images.generate({
      prompt: lostGptPrompt(stillPrompt, "portrait"),
      size: "1024x1536",
    });
    // STAGE 2 — a LIGHT (~0.3) GHIBSKY img2img restyle for the vibrant Ghibli
    // graphics, KEEPING the people and layout. Skipped (gpt still kept) when no fal
    // model is configured or on any error.
    let image = gpt.image;
    if (this.lostImages) {
      try {
        const trigger = this.styleTrigger?.trim() ? `${this.styleTrigger.trim()}, ` : "";
        const restyled = await this.lostImages.generate({
          prompt: trigger + LOST_RESTYLE_PROMPT,
          size: "1024x1536",
          referenceImage: gpt.image,
          strength: this.restyleStrength,
        });
        image = restyled.image;
      } catch {
        /* keep the gpt-image still */
      }
    }
    const stillKey = `lost-still/${randomUUID()}.png`;
    await this.storage.putBuffer(stillKey, image, "image/png");
    return { stillKey, url: await this.storage.getUrl(stillKey) };
  }

  /** REFINE: keep the current still and ADD a small detail (image-to-image) — so
   *  the user tweaks with a short note instead of rewriting the whole prompt and
   *  losing the composition. Returns a NEW still (key + url). */
  async refineStill(stillKey: string, stillPrompt: string, adjustment: string): Promise<LostPreviewDto> {
    const provider = this.lostImages ?? this.images;
    const trigger = this.styleTrigger?.trim() ? `${this.styleTrigger.trim()}, ` : "";
    // Load the approved still so we edit THAT frame forward, not a fresh one.
    const tmp = join(tmpdir(), `lost-refine-${randomUUID()}.png`);
    await this.storage.getToFile(stillKey, tmp);
    const referenceImage = await readFile(tmp);
    const scene = adjustment.trim() ? `${stillPrompt.trim()}. Also include: ${adjustment.trim()}` : stillPrompt.trim();
    const { image } = await provider.generate({
      prompt: trigger + lostStillPrompt(scene, "portrait"),
      size: "1024x1536",
      referenceImage,
    });
    const newKey = `lost-still/${randomUUID()}.png`;
    await this.storage.putBuffer(newKey, image, "image/png");
    return { stillKey: newKey, url: await this.storage.getUrl(newKey) };
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
