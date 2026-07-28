import { checkModel } from "./google-call.js";
import type { VideoProvider, VideoSeedImage } from "./types.js";

export interface GoogleVeoOptions {
  apiKey: string;
  /** Gemini API Veo model id — default Veo 3.1 Fast (native audio, cheapest quality tier). */
  model?: string;
  /** "720p" (cheapest) | "1080p" | "4k". */
  resolution?: string;
  /**
   * 4 | 6 | 8 — must be 8 for 1080p/4k, reference images or extension.
   *
   * A NUMBER, despite Google's parameter table documenting it as a string: the
   * live API rejects `"8"` with `The value type for durationSeconds needs to be
   * a number` (400 INVALID_ARGUMENT). Trust the API over the docs here.
   */
  durationSeconds?: number;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Google Veo video generation via the Gemini API DIRECTLY (no fal reseller
 * markup — Veo 3.1 Fast @ 720p is ~$0.10/sec vs fal's ~$0.15). Async: submit a
 * long-running operation, poll until done, then download the resulting mp4. Auth
 * is a Gemini API key (from Google AI Studio) on the x-goog-api-key header.
 *
 * The finished-operation response shape has moved around across preview builds,
 * so the video reference is extracted defensively; the model id is env-driven so
 * it's a one-line swap when Google renames the preview endpoint.
 */
export class GoogleVeoProvider implements VideoProvider {
  private readonly model: string;
  private readonly resolution: string;
  private readonly durationSeconds: number;

  constructor(private readonly opts: GoogleVeoOptions) {
    this.model = opts.model || "veo-3.1-fast-generate-preview";
    this.resolution = opts.resolution || "720p";
    this.durationSeconds = Number(opts.durationSeconds) || 8;
  }

  /**
   * Confirms the key can see the configured Veo model and that it exposes
   * predictLongRunning — a plain models.get, so it costs nothing. Worth running
   * before the first render: a wrong/renamed preview id otherwise only shows up
   * after a job has already started.
   */
  async check(): Promise<{ ok: boolean; model: string; detail: string; resolution: string; durationSeconds: number }> {
    const r = await checkModel(this.opts.apiKey, this.model);
    return {
      ok: r.ok,
      model: this.model,
      detail: r.detail,
      resolution: this.resolution,
      durationSeconds: this.durationSeconds,
    };
  }

  async generate(input: {
    prompt: string;
    aspectRatio?: string;
    image?: VideoSeedImage;
    negativePrompt?: string;
  }): Promise<{ video: Buffer; ext: "mp4" }> {
    const headers = { "x-goog-api-key": this.opts.apiKey, "Content-Type": "application/json" };

    // A seed image makes this IMAGE-TO-VIDEO: the still is the first frame.
    const instance: Record<string, unknown> = { prompt: input.prompt };
    if (input.image) {
      instance.image = {
        bytesBase64Encoded: input.image.png.toString("base64"),
        mimeType: input.image.mimeType || "image/png",
      };
    }

    // 1. Kick off the long-running generation.
    const start = await fetch(`${BASE}/models/${this.model}:predictLongRunning`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        instances: [instance],
        parameters: {
          aspectRatio: input.aspectRatio || "9:16",
          resolution: this.resolution,
          durationSeconds: this.durationSeconds,
          // Not interchangeable: Google allows "allow_all" ONLY for
          // text-to-video, and requires "allow_adult" for image-to-video,
          // interpolation and reference images. Sending the wrong one 400s
          // every request.
          personGeneration: input.image ? "allow_adult" : "allow_all",
          // Caller-overridable: cook wants "no human faces" (hands only), but a
          // stick-figure animation obviously must not exclude its characters.
          negativePrompt:
            input.negativePrompt ??
            "on-screen text, subtitles, watermark, logo, human faces, blurry, low quality",
        },
      }),
    });
    if (!start.ok) {
      const detail = await start.text().catch(() => "");
      throw new Error(`Veo start failed (${start.status}): ${detail.slice(0, 300)}${veoHint(start.status, detail)}`);
    }
    const op = (await start.json()) as { name?: string };
    if (!op.name) throw new Error("Veo start returned no operation name");

    // 2. Poll until done. Veo latency is ~11s–6min; cap at 10.
    const deadline = Date.now() + 10 * 60 * 1000;
    let done: OpResult;
    for (;;) {
      if (Date.now() > deadline) throw new Error("Veo timed out (>10 min)");
      await sleep(8000);
      const poll = await fetch(`${BASE}/${op.name}`, { headers });
      if (!poll.ok) {
        const detail = await poll.text().catch(() => "");
        throw new Error(`Veo poll failed (${poll.status}): ${detail.slice(0, 200)}`);
      }
      const j = (await poll.json()) as OpResult;
      if (j.error) throw new Error(`Veo failed: ${JSON.stringify(j.error).slice(0, 200)}`);
      if (j.done) {
        done = j;
        break;
      }
    }

    // 3. Extract the video: either inline base64 or a file uri to download.
    const v = extractVideo(done);
    if (!v) throw new Error(`Veo finished but returned no video: ${JSON.stringify(done.response).slice(0, 300)}`);
    if (v.bytesBase64) return { video: Buffer.from(v.bytesBase64, "base64"), ext: "mp4" };

    const dl = await fetch(v.uri!.includes("alt=media") ? v.uri! : `${v.uri}${v.uri!.includes("?") ? "&" : "?"}alt=media`, {
      headers: { "x-goog-api-key": this.opts.apiKey },
    });
    if (!dl.ok) throw new Error(`Veo video download failed (${dl.status})`);
    return { video: Buffer.from(await dl.arrayBuffer()), ext: "mp4" };
  }
}

/**
 * Turn Google's terse rejections into the actual next action. Veo has NO free
 * tier, so the single most common cause of "every shot failed" is a key whose
 * Google Cloud project has no billing account — which the raw error states only
 * obliquely, if at all.
 */
function veoHint(status: number, detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes("billing") || d.includes("quota") || status === 429) {
    return "\nHINT: Veo has no free tier — enable billing on the Google Cloud project behind GEMINI_API_KEY.";
  }
  if (status === 403 || d.includes("permission")) {
    return "\nHINT: the key can't access this model. Veo requires a paid (billing-enabled) project; check GEMINI_API_KEY and GEMINI_VEO_MODEL.";
  }
  if (status === 404 || d.includes("not found")) {
    return "\nHINT: model id not found — Veo preview ids get renamed. Run GET /system/providers to see what this key resolves.";
  }
  if (status === 400) {
    return "\nHINT: a parameter was rejected. personGeneration must be 'allow_all' for text-to-video and 'allow_adult' for image-to-video; durationSeconds must be a NUMBER (8, not \"8\") and must be 8 at 1080p/4k.";
  }
  return "";
}

interface OpResult {
  done?: boolean;
  error?: unknown;
  response?: Record<string, unknown>;
}

/** The finished response nests the video differently across preview builds; check the known shapes. */
function extractVideo(op: OpResult): { uri?: string; bytesBase64?: string } | null {
  const r = op.response ?? {};
  const candidates: unknown[] = [
    (r as any).generateVideoResponse?.generatedSamples?.[0]?.video,
    (r as any).generatedVideos?.[0]?.video,
    (r as any).generated_videos?.[0]?.video,
    (r as any).generateVideoResponse?.generatedVideos?.[0]?.video,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const vid = c as { uri?: string; videoUri?: string; bytesBase64Encoded?: string; videoBytes?: string };
    const bytesBase64 = vid.bytesBase64Encoded || vid.videoBytes;
    const uri = vid.uri || vid.videoUri;
    if (bytesBase64 || uri) return { uri, bytesBase64 };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
