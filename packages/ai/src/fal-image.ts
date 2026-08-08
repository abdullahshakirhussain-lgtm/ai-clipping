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

  constructor(private readonly opts: FalImageOptions) {
    this.loraUrl = opts.loraUrl?.trim() || undefined;
    this.loraScale = opts.loraScale ?? 1;
    // A LoRA requires the flux-lora endpoint; otherwise the plain schnell default.
    this.model = opts.model || (this.loraUrl ? "fal-ai/flux-lora" : "fal-ai/flux/schnell");
  }

  async generate(input: { prompt: string; size?: string }): Promise<{ image: Buffer; ext: "png" }> {
    const { width, height } = parseSize(input.size);
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      // fal bills FLUX at $/megapixel rounded up; a clean 9:16 portrait.
      image_size: { width, height },
      num_images: 1,
      output_format: "png",
    };
    if (this.loraUrl) body.loras = [{ path: this.loraUrl, scale: this.loraScale }];

    const res = await fetch(`https://fal.run/${this.model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
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
