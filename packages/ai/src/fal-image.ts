import type { ImageProvider } from "./types.js";

export interface FalImageOptions {
  apiKey: string;
  /** fal model id — default FLUX.1 [schnell]: fast, cheap (~$0.003/image), good. */
  model?: string;
}

/**
 * fal.ai image generation (FLUX.1 [schnell] by default). Roughly 50x cheaper
 * than gpt-image-1 at high quality with comparable quality for the illustrated /
 * doodle / vector styles Story Studio uses. The sync endpoint returns a hosted
 * image URL, which we fetch to bytes.
 */
export class FalImageProvider implements ImageProvider {
  private readonly model: string;

  constructor(private readonly opts: FalImageOptions) {
    this.model = opts.model || "fal-ai/flux/schnell";
  }

  async generate(input: { prompt: string; size?: string }): Promise<{ image: Buffer; ext: "png" }> {
    const res = await fetch(`https://fal.run/${this.model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: input.prompt,
        image_size: "portrait_16_9", // 9:16; the assembler pads to 1080x1920
        num_images: 1,
        output_format: "png",
      }),
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
