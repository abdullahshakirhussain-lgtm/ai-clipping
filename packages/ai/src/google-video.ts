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
 * Veo accepted the request, ran it, and then withheld the result — most often
 * because the prompt named a real person ("we can't create videos with real
 * people's names or likenesses"). Distinct from a transport error because the
 * fix is to change the prompt, and it's per-shot rather than systemic.
 */
export class VeoContentFilteredError extends Error {
  constructor(readonly reason: string) {
    super(`Veo filtered this shot: ${reason}`);
    this.name = "VeoContentFilteredError";
  }
}

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
  /**
   * Asset reference images are a Veo 3.1 / Fast feature; Lite rejects the field
   * outright. Branch on the documented capability rather than sending it and
   * letting the retry clean up — relying on the retry is how eight of nine shots
   * died when Google's rejection wording didn't match the pattern.
   */
  private readonly supportsReferenceImages: boolean;
  /**
   * Lite also rejects `negativePrompt`. Sending it anyway means every shot pays
   * for a rejected request BEFORE the real one — doubling the request count
   * against Lite's 10 RPM preview quota, which is exactly what turned a soft
   * rate limit into a run that 429'd on every shot. Gate it like referenceImages
   * rather than leaning on the strip-and-retry backstop.
   */
  private readonly supportsNegativePrompt: boolean;

  constructor(private readonly opts: GoogleVeoOptions) {
    this.model = opts.model || "veo-3.1-fast-generate-preview";
    this.resolution = opts.resolution || "720p";
    this.durationSeconds = Number(opts.durationSeconds) || 8;
    this.supportsReferenceImages = !/lite/i.test(this.model);
    this.supportsNegativePrompt = !/lite/i.test(this.model);
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
    referenceImages?: Buffer[];
    negativePrompt?: string;
  }): Promise<{ video: Buffer; ext: "mp4" }> {
    const headers = { "x-goog-api-key": this.opts.apiKey, "Content-Type": "application/json" };

    // Two DIFFERENT features, both optional and independent:
    //   image          — IMAGE-TO-VIDEO. The still is the clip's first frame.
    //                    Every Veo 3.1 variant supports this, Lite included.
    //   referenceImages — up to 3 "asset" stills the model refers to for the
    //                    whole clip, not just frame one. The stronger character
    //                    anchor, but Veo 3.1 and Fast only; Lite rejects them
    //                    and the retry below sheds the field.
    const instance: Record<string, unknown> = { prompt: input.prompt };
    if (input.image) {
      instance.image = {
        bytesBase64Encoded: input.image.png.toString("base64"),
        mimeType: input.image.mimeType || "image/png",
      };
    }
    if (input.referenceImages?.length && this.supportsReferenceImages) {
      instance.referenceImages = input.referenceImages.slice(0, 3).map((png) => ({
        image: { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
        referenceType: "asset",
      }));
    }

    const parameters: Record<string, unknown> = {
      aspectRatio: input.aspectRatio || "9:16",
      resolution: this.resolution,
      durationSeconds: this.durationSeconds,
      // Not interchangeable: Google allows "allow_all" ONLY for text-to-video,
      // and requires "allow_adult" for image-to-video, interpolation and
      // reference images. Sending the wrong one 400s every request.
      personGeneration: input.image ? "allow_adult" : "allow_all",
    };
    // Caller-overridable: cook wants "no human faces" (hands only), but a
    // stick-figure animation obviously must not exclude its characters. Only
    // sent to models that accept it — Lite doesn't, and a known-rejected field
    // costs a wasted request per shot against its tiny preview quota.
    if (this.supportsNegativePrompt) {
      parameters.negativePrompt =
        input.negativePrompt ??
        "on-screen text, subtitles, watermark, logo, human faces, blurry, low quality";
    }

    // 1. Kick off the long-running generation.
    //
    // Two things can go wrong here and both are recoverable:
    //   - The preview models accept DIFFERENT parameter sets, and which knobs
    //     exist has already shifted twice mid-preview. Drop whatever field the
    //     API names as unsupported and retry; the 400 identifies it precisely.
    //   - Rate limits. A 429 here is transient, not a reason to lose the shot.
    let start: Response;
    let rateLimitWaits = 0;
    for (let attempt = 0; ; attempt++) {
      start = await fetch(`${BASE}/models/${this.model}:predictLongRunning`, {
        method: "POST",
        headers,
        body: JSON.stringify({ instances: [instance], parameters }),
      });
      if (start.ok) break;

      const detail = await start.text().catch(() => "");

      if (isRateLimited(start.status) && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
        const wait = retryAfterMs(start.headers, rateLimitWaits++);
        console.warn(`[veo] ${start.status} starting a shot; waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        attempt--; // a rate limit isn't an attempt at a different request shape
        continue;
      }

      const field = unsupportedField(detail);
      // The rejected field can live in either half of the request — parameters
      // (negativePrompt) or the instance (referenceImages).
      const bag = field && field in parameters ? parameters : field && field in instance ? instance : null;
      if (attempt < 4 && field && bag) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete bag[field];
        console.warn(`[veo] ${this.model} rejected "${field}"; retrying without it`);
        continue;
      }
      throw new Error(`Veo start failed (${start.status}): ${detail.slice(0, 300)}${veoHint(start.status, detail)}`);
    }
    const op = (await start.json()) as { name?: string };
    if (!op.name) throw new Error("Veo start returned no operation name");

    // 2. Poll until done. Veo latency is ~11s–6min; cap at 10 minutes of actual
    //    generation. The interval widens as the shot runs long, which roughly
    //    halves poll volume on slow generations — the whole point being to stay
    //    well clear of the per-minute quota when a dozen shots are in flight.
    let deadline = Date.now() + 10 * 60 * 1000;
    let interval = 8000;
    let done: OpResult;
    for (;;) {
      if (Date.now() > deadline) throw new Error("Veo timed out (>10 min)");
      await sleep(interval);
      interval = Math.min(interval + 2000, 20000);
      const poll = await fetch(`${BASE}/${op.name}`, { headers });
      if (!poll.ok) {
        const detail = await poll.text().catch(() => "");
        // The generation is already running and already being billed. Dropping
        // it because one poll got rate-limited or hit a blip throws away a paid
        // clip — wait and ask again, and extend the deadline by what we waited
        // so a rate limit can't masquerade as a timeout.
        if ((isRateLimited(poll.status) || poll.status >= 500) && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
          const wait = retryAfterMs(poll.headers, rateLimitWaits++);
          console.warn(`[veo] ${poll.status} while polling; waiting ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          deadline += wait;
          continue;
        }
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
    if (!v) {
      // The commonest "finished but empty" case is a safety filter, not a bug —
      // surface its stated reason instead of a wall of JSON, and mark it so the
      // caller can retry with a sanitized prompt rather than treating it as a
      // transport failure.
      const rai = (done.response as { generateVideoResponse?: { raiMediaFilteredReasons?: string[] } } | undefined)
        ?.generateVideoResponse?.raiMediaFilteredReasons;
      if (rai?.length) throw new VeoContentFilteredError(rai.join(" "));
      throw new Error(`Veo finished but returned no video: ${JSON.stringify(done.response).slice(0, 300)}`);
    }
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
  // A 429 is a rate/quota limit, NOT a billing problem — and Google's 429 body
  // literally contains the words "check your plan and billing details", so this
  // MUST be tested before the billing branch or it misdiagnoses every 429 as
  // "enable billing" when billing is already on. Veo 3.1 preview models are 10
  // RPM / 10 concurrent on Tier 1.
  if (status === 429 || d.includes("exceeded your current quota") || d.includes("rate limit")) {
    return (
      "\nHINT: this is a Veo RATE/QUOTA limit, not billing. Veo 3.1 preview models allow only ~10 requests/min and 10 concurrent on Tier 1. " +
      "Lower ANIM_CONCURRENCY (to 1) and/or ANIM_MAX_SHOTS, wait for the per-minute window to clear, or raise your API tier. Check ai.dev/rate-limit to see which quota is at zero."
    );
  }
  if (d.includes("billing")) {
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

/**
 * Pull the field name out of an "unsupported parameter" rejection.
 *
 * Google's wording varies with the field's plurality and preposition —
 * "`negativePrompt` isn't supported by this model" vs "Reference images are not
 * supported for this model". The first version of this matched only the
 * singular form, so a plural rejection went unhandled and killed eight of nine
 * shots in one run. A backticked name anywhere in the message wins, since
 * Google quotes the real parameter when it knows it; otherwise fall back to the
 * identifier immediately before the phrase. Callers check membership before
 * deleting, so a near-miss is harmless.
 */
export function unsupportedField(detail: string): string | null {
  if (!/\bnot\s+supported|\bisn'?t\s+supported|\baren'?t\s+supported/i.test(detail)) return null;
  // BACKTICKS only — Google quotes the offending parameter that way. Matching
  // any quote style instead picks up the surrounding JSON's own keys ("error",
  // "message") long before it reaches the field name.
  const backticked = /`([A-Za-z_][A-Za-z0-9_]*)`/.exec(detail);
  if (backticked?.[1]) return backticked[1];
  const bare = /([A-Za-z_][A-Za-z0-9_]*)\s+(?:is|are|isn'?t|aren'?t|was|were)?\s*(?:not\s+)?supported/i.exec(detail);
  return bare?.[1] ?? null;
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

/**
 * How many times one call may wait out a rate limit before giving up. Kept low
 * on purpose: when the quota is genuinely exhausted (not a momentary burst) the
 * 429 repeats no matter how long we wait, so each extra retry is dead time — and
 * at 12 shots that dead time multiplies. Four waits is ~2+4+8+16 = 30s worst
 * case, after which the shot fails over and the >1/3-stills guard surfaces the
 * quota wall immediately instead of 12 minutes later.
 */
export const MAX_RATE_LIMIT_WAITS = 4;

export function isRateLimited(status: number): boolean {
  return status === 429;
}

/**
 * How long to wait before retrying: the server's `Retry-After` when it gives
 * one, otherwise exponential backoff (2s, 4s, 8s… capped at 60s). Capped
 * because a shot that waits minutes is worse than one that fails and falls back.
 */
export function retryAfterMs(headers: { get(name: string): string | null }, attempt: number): number {
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 60_000);
  return Math.min(2000 * 2 ** attempt, 60_000);
}
