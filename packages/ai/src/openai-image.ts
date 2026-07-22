import type { ImageProvider } from "./types.js";

export type OpenAiImageQuality = "auto" | "low" | "medium" | "high";

export interface OpenAiImageOptions {
  apiKey: string;
  /** gpt-image-1-mini (default) — same style-understanding as gpt-image-1 at ~10x lower cost. */
  model?: string;
  /**
   * Quality tier (gpt-image-1 / gpt-image-1-mini). "low" is the default: on
   * gpt-image-1-mini that's ~$0.006/image (~$0.09 for a 15-beat story) while
   * still rendering the stick-figure + colorful-scene style faithfully.
   */
  quality?: OpenAiImageQuality;
}

/**
 * OpenAI image generation for Story Studio frames. Uses the same API key as the
 * TTS provider. Returns base64 PNG; portrait 1024x1536 (2:3) is the closest
 * size to 9:16 — the assembler scales to cover 1080x1920 and center-crops the
 * ~8% side overflow for full-bleed frames (prompts keep subjects centered). gpt-image-1-mini is the default model — an
 * instruction-following model that honours "simple stick figures + colorful
 * background" (which pure diffusion models like FLUX will not), at a fraction of
 * gpt-image-1's cost.
 *
 * Note: gpt-image models require organization verification on some accounts — a
 * 403 here is handled upstream by falling back to a plain card, so one
 * unverified account never sinks the pipeline.
 */
export class OpenAiImageProvider implements ImageProvider {
  private readonly model: string;
  private readonly quality: OpenAiImageQuality;

  constructor(private readonly opts: OpenAiImageOptions) {
    this.model = opts.model || "gpt-image-1-mini";
    this.quality = opts.quality || "low";
  }

  /**
   * Generate with retries: 429s (rate limits from our 3-way concurrency) and
   * 5xx/network blips are transient and MUST NOT surface as a blank card in a
   * finished video — back off (honouring Retry-After) and try again. Other 4xx
   * (moderation blocks, bad params) are deterministic; fail fast so the caller
   * can fall back differently.
   */
  async generate(input: { prompt: string; size?: string }): Promise<{ image: Buffer; ext: "png" }> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = new Error("OpenAI image: no attempts made");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            prompt: input.prompt,
            size: input.size || "1024x1536",
            quality: this.quality,
            n: 1,
          }),
        });
      } catch (err) {
        lastErr = err; // network blip — retry
        if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
        const b64 = json.data?.[0]?.b64_json;
        if (!b64) throw new Error("OpenAI image returned no b64_json");
        return { image: Buffer.from(b64, "base64"), ext: "png" };
      }
      const detail = await res.text().catch(() => "");
      lastErr = new Error(`OpenAI image failed (${res.status}): ${detail.slice(0, 200)}`);
      if (res.status !== 429 && res.status < 500) throw lastErr; // deterministic 4xx
      if (attempt < MAX_ATTEMPTS) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        await sleep(Math.max(Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 0, 1500 * attempt));
      }
    }
    throw lastErr;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
