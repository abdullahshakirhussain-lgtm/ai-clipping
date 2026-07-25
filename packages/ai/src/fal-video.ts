import type { VideoProvider } from "./types.js";

export interface FalVideoOptions {
  apiKey: string;
  /** fal model id — default Veo 3.1 Fast (native audio, ~$0.15/sec). */
  model?: string;
  /** "720p" (cheap) | "1080p". */
  resolution?: string;
  /** Per-shot duration the model generates, e.g. "8s". */
  duration?: string;
}

/**
 * fal.ai video generation (Google Veo 3.1 by default) with NATIVE audio — the
 * model generates the ambient/foley sound itself, so there's no separate audio
 * track to assemble. Unlike the image endpoint this is async: submit to the
 * queue, poll status until COMPLETED, then fetch the result and download the mp4.
 * Same auth/HTTP shape as FalImageProvider.
 */
export class FalVideoProvider implements VideoProvider {
  private readonly model: string;
  private readonly resolution: string;
  private readonly duration: string;

  constructor(private readonly opts: FalVideoOptions) {
    this.model = opts.model || "fal-ai/veo3.1/fast";
    this.resolution = opts.resolution || "720p";
    this.duration = opts.duration || "8s";
  }

  async generate(input: { prompt: string; aspectRatio?: string }): Promise<{ video: Buffer; ext: "mp4" }> {
    const auth = { Authorization: `Key ${this.opts.apiKey}` };
    const submit = await fetch(`https://queue.fal.run/${this.model}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: input.prompt,
        aspect_ratio: input.aspectRatio || "9:16",
        resolution: this.resolution,
        duration: this.duration,
        generate_audio: true,
        negative_prompt: "human faces, on-screen text, subtitles, watermark, logo, blurry, low quality",
      }),
    });
    if (!submit.ok) {
      const detail = await submit.text().catch(() => "");
      throw new Error(`fal video submit failed (${submit.status}): ${detail.slice(0, 200)}`);
    }
    const { status_url, response_url } = (await submit.json()) as {
      status_url?: string;
      response_url?: string;
    };
    if (!status_url || !response_url) throw new Error("fal video submit returned no status/response url");

    // Poll until done. Veo renders in ~1-4 min; cap at 10 to avoid a wedged job
    // hanging the pipeline.
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("fal video timed out (>10 min)");
      await sleep(6000);
      const sj = (await (await fetch(status_url, { headers: auth })).json()) as { status?: string; error?: unknown };
      if (sj.status === "COMPLETED") break;
      if (sj.status === "FAILED" || sj.error) throw new Error(`fal video failed: ${JSON.stringify(sj).slice(0, 200)}`);
    }
    const rj = (await (await fetch(response_url, { headers: auth })).json()) as { video?: { url?: string } };
    const url = rj?.video?.url;
    if (!url) throw new Error(`fal video returned no url: ${JSON.stringify(rj).slice(0, 200)}`);
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`fal video download failed (${dl.status})`);
    return { video: Buffer.from(await dl.arrayBuffer()), ext: "mp4" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
