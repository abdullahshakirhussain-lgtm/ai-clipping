import { isRateLimited, MAX_RATE_LIMIT_WAITS, retryAfterMs } from "./google-video.js";
import type { ImageProvider } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface GoogleImageOptions {
  apiKey: string;
  /** Gemini image model — default "Nano Banana" (cheapest that can edit). */
  model?: string;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Photoreal stills from the Gemini API, on the SAME GEMINI_API_KEY as Veo — so
 * cook needs no extra setup. gemini-2.5-flash-image ("Nano Banana") is $0.039
 * an image, which is ~1/20th of one 8s video clip: cheap enough to regenerate a
 * frame until it's right, which is the whole point of putting a still in front
 * of the video model.
 *
 * The reason this model specifically: it takes INPUT images, so each shot can be
 * an edit of the previous frame ("same scene, the fish is now seasoned") rather
 * than a fresh imagining. That is what keeps the stone, the fire, the bowls and
 * the hands identical from cut to cut — the failure mode text prompts never fixed.
 *
 * Note it has no free tier (same as Veo): the key's project needs billing.
 */
export class GoogleImageProvider implements ImageProvider {
  private readonly model: string;

  constructor(private readonly opts: GoogleImageOptions) {
    this.model = opts.model || "gemini-2.5-flash-image";
  }

  async generate(input: {
    prompt: string;
    size?: string;
    /** Previous frame to edit forward — the continuity anchor. */
    referenceImage?: Buffer;
  }): Promise<{ image: Buffer; ext: "png" }> {
    const parts: Array<Record<string, unknown>> = [];
    // Image first, then instruction: the model reads it as "here is the scene,
    // now change this about it".
    if (input.referenceImage) {
      parts.push({ inlineData: { mimeType: "image/png", data: input.referenceImage.toString("base64") } });
    }
    parts.push({ text: input.prompt });

    // Cook draws its stills SEQUENTIALLY (each frame is an edit of the one
    // before it), so a single rate-limited call costs a frame and breaks the
    // chain that keeps the scene consistent. Wait it out instead.
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${BASE}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": this.opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }] }),
      });
      if (res.ok) break;

      const detail = await res.text().catch(() => "");
      if ((isRateLimited(res.status) || res.status >= 500) && attempt < MAX_RATE_LIMIT_WAITS) {
        const wait = retryAfterMs(res.headers, attempt);
        console.warn(`[gemini-image] ${res.status}; waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      const hint =
        res.status === 429 || detail.toLowerCase().includes("billing")
          ? "\nHINT: Gemini image models have no free tier — enable billing on the project behind GEMINI_API_KEY."
          : "";
      throw new Error(`Gemini image failed (${res.status}): ${detail.slice(0, 300)}${hint}`);
    }

    const j = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
    };
    const data = (j.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new Error("Gemini image returned no image data");
    return { image: Buffer.from(data, "base64"), ext: "png" };
  }
}
