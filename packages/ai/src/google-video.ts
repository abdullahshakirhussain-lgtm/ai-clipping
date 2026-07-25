import type { VideoProvider } from "./types.js";

export interface GoogleVeoOptions {
  apiKey: string;
  /** Gemini API Veo model id — default Veo 3.1 Fast (native audio, cheapest quality tier). */
  model?: string;
  /** "720p" (cheapest) | "1080p" | "4k". */
  resolution?: string;
  /** "4" | "6" | "8" — must be "8" for 1080p/4k. */
  durationSeconds?: string;
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
  private readonly durationSeconds: string;

  constructor(private readonly opts: GoogleVeoOptions) {
    this.model = opts.model || "veo-3.1-fast-generate-preview";
    this.resolution = opts.resolution || "720p";
    this.durationSeconds = opts.durationSeconds || "8";
  }

  async generate(input: { prompt: string; aspectRatio?: string }): Promise<{ video: Buffer; ext: "mp4" }> {
    const headers = { "x-goog-api-key": this.opts.apiKey, "Content-Type": "application/json" };

    // 1. Kick off the long-running generation.
    const start = await fetch(`${BASE}/models/${this.model}:predictLongRunning`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        instances: [{ prompt: input.prompt }],
        parameters: {
          aspectRatio: input.aspectRatio || "9:16",
          resolution: this.resolution,
          durationSeconds: this.durationSeconds,
          personGeneration: "allow_all",
          negativePrompt: "on-screen text, subtitles, watermark, logo, human faces, blurry, low quality",
        },
      }),
    });
    if (!start.ok) {
      const detail = await start.text().catch(() => "");
      throw new Error(`Veo start failed (${start.status}): ${detail.slice(0, 300)}`);
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
