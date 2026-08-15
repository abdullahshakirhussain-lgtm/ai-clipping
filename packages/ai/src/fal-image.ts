import type { ImageProvider } from "./types.js";

export interface FalImageOptions {
  apiKey: string;
  /** fal model id — default FLUX.1 [schnell]: fast, cheap (~$0.003/image), good. */
  model?: string;
  /**
   * A trained Flux LoRA to attach (the character LoRA for the Hero channel). When
   * set, the provider switches to the `fal-ai/flux-lora` endpoint and passes the
   * LoRA so the trained character renders identically every time.
   */
  loraUrl?: string;
  /** LoRA strength, 0..~1.5 (default 1). */
  loraScale?: number;
  /** Image-to-image denoise strength for refines: 1.0 = fully remake, 0.0 = keep
   *  the original untouched. Needs to be fairly HIGH (~0.75) or "add a detail" does
   *  nothing (flux just preserves the frame). Default 0.75. */
  imgToImgStrength?: number;
}

/** "1024x1536" → {width,height}; falls back to a ~1MP 9:16 portrait. */
function parseSize(size?: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return { width: 768, height: 1344 };
}

/**
 * fal.ai image generation. Two modes:
 *  - default: FLUX.1 [schnell] from a plain prompt (cheap illustrated styles).
 *  - LoRA (loraUrl set): the `fal-ai/flux-lora` endpoint with a trained character
 *    LoRA attached — the consistency lever for the Hero channel, where the same
 *    named human must look identical across every video. The trigger word lives in
 *    the prompt (built upstream); this just carries the LoRA.
 * The sync endpoint returns a hosted image URL, which we fetch to bytes.
 */
export class FalImageProvider implements ImageProvider {
  private readonly model: string;
  private readonly loraUrl?: string;
  private readonly loraScale: number;
  private readonly imgStrength: number;

  constructor(private readonly opts: FalImageOptions) {
    this.loraUrl = opts.loraUrl?.trim() || undefined;
    this.loraScale = opts.loraScale ?? 1;
    this.imgStrength = opts.imgToImgStrength ?? 0.75;
    // A LoRA requires the flux-lora endpoint; otherwise the plain schnell default.
    this.model = opts.model || (this.loraUrl ? "fal-ai/flux-lora" : "fal-ai/flux/schnell");
  }

  async generate(input: {
    prompt: string;
    size?: string;
    referenceImage?: Buffer;
  }): Promise<{ image: Buffer; ext: "png" }> {
    const { width, height } = parseSize(input.size);
    const loras = this.loraUrl ? { loras: [{ path: this.loraUrl, scale: this.loraScale }] } : {};

    // REFINE (image-to-image): keep THIS picture's composition and apply the
    // prompt's changes — for adding a small missing detail without re-rolling a
    // whole new image. Strength 0.55 leaves most of the frame intact. Any failure
    // falls back to a fresh text-to-image, so the worst case is the old behaviour.
    if (input.referenceImage) {
      try {
        return await this.post(`${this.model}/image-to-image`, {
          prompt: input.prompt,
          image_url: `data:image/png;base64,${input.referenceImage.toString("base64")}`,
          strength: this.imgStrength,
          image_size: { width, height },
          num_images: 1,
          output_format: "png",
          ...loras,
        });
      } catch (err) {
        console.warn(`[fal image] img2img refine failed, drawing fresh: ${String(err).slice(0, 200)}`);
      }
    }

    return this.post(this.model, {
      prompt: input.prompt,
      // fal bills FLUX at $/megapixel rounded up; a clean 9:16 portrait.
      image_size: { width, height },
      num_images: 1,
      output_format: "png",
      ...loras,
    });
  }

  /** POST a fal image request and fetch the resulting image to bytes. */
  private async post(model: string, body: Record<string, unknown>): Promise<{ image: Buffer; ext: "png" }> {
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`fal image failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { images?: Array<{ url?: string }> };
    const url = json.images?.[0]?.url;
    if (!url) throw new Error("fal image returned no image url");
    const img = await fetch(url);
    if (!img.ok) throw new Error(`fal image download failed (${img.status})`);
    return { image: Buffer.from(await img.arrayBuffer()), ext: "png" };
  }
}
