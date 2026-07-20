import type { ImageProvider } from "./types.js";

export interface OpenAiImageOptions {
  apiKey: string;
  /** gpt-image-1 (default). */
  model?: string;
}

/**
 * OpenAI image generation for Story Studio frames. Uses the same API key as the
 * TTS provider. gpt-image-1 returns base64 PNG; portrait size is closest to 9:16
 * (the assembler pads to 1080x1920).
 *
 * Note: gpt-image-1 requires organization verification on some accounts — a 403
 * here is handled upstream by falling back to a plain card, so one unverified
 * account never sinks the pipeline.
 */
export class OpenAiImageProvider implements ImageProvider {
  private readonly model: string;

  constructor(private readonly opts: OpenAiImageOptions) {
    this.model = opts.model || "gpt-image-1";
  }

  async generate(input: { prompt: string; size?: string }): Promise<{ image: Buffer; ext: "png" }> {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        prompt: input.prompt,
        size: input.size || "1024x1536",
        n: 1,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI image failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI image returned no b64_json");
    return { image: Buffer.from(b64, "base64"), ext: "png" };
  }
}
