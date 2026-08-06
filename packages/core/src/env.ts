import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),

  QUEUE_DRIVER: z.enum(["bullmq", "inprocess"]).default("inprocess"),
  REDIS_URL: z.string().optional().default(""),

  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default(".data/storage"),
  R2_ACCOUNT_ID: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET: z.string().optional().default("clipfactory"),
  R2_PUBLIC_BASE_URL: z.string().optional().default(""),

  AI_DRIVER: z.enum(["mock", "live"]).default("mock"),
  GROQ_API_KEY: z.string().optional().default(""),
  GROQ_WHISPER_MODEL: z.string().default("whisper-large-v3-turbo"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  /** Model for commentary writing only (two-pass). Opus is wittier; ~5x text cost. */
  COMMENTARY_MODEL: z.string().default("claude-opus-4-8"),
  // Cheap text tasks (topic suggestions + the tight image-prompt pass) route to
  // DeepSeek V4 Flash when a key is set — ~1/50th the Opus text cost. Narration
  // itself always stays on the Opus writer. Empty key → these fall back to Anthropic.
  DEEPSEEK_API_KEY: z.string().optional().default(""),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com/v1"),
  // ── Wave 3 (cloud): transcription provider. "groq" = Whisper (no diarization);
  //    "deepgram" = word-level + speaker labels. Needs DEEPGRAM_API_KEY.
  TRANSCRIBE_PROVIDER: z.enum(["groq", "deepgram"]).default("groq"),
  DEEPGRAM_API_KEY: z.string().optional().default(""),
  DEEPGRAM_MODEL: z.string().default("nova-2"),
  // ── Wave 3 (cloud): subject-aware reframing. "center" = current 9:16 crop;
  //    "cloud" = face/active-speaker tracking via a vision API (REFRAME_API_KEY).
  REFRAME_PROVIDER: z.enum(["center", "cloud"]).default("center"),
  REFRAME_API_KEY: z.string().optional().default(""),
  // ── Voice-over. ElevenLabs is the only real TTS ("mock" = silent stub so the
  //    pipeline runs keyless in dev). It's used for EVERY spoken tier now — the
  //    old OpenAI TTS was removed. Falls back to mock when the key isn't set.
  TTS_PROVIDER: z.enum(["mock", "elevenlabs"]).default("elevenlabs"),
  OPENAI_API_KEY: z.string().optional().default(""),
  ELEVENLABS_API_KEY: z.string().optional().default(""),
  ELEVENLABS_VOICE_ID: z.string().optional().default(""),
  // eleven_v3 performs inline audio tags ("[shouts]") — the expressive model.
  // Switch on with TTS_PROVIDER=elevenlabs + ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID.
  ELEVENLABS_MODEL: z.string().default("eleven_v3"),

  // ── Story Studio (generated videos) ────────────────────────────────────────
  // Image generation for narrated slideshows. "openai" = gpt-image-1-mini
  // (recommended: an instruction-following model that actually draws stick
  // figures + colorful scenes; ~$0.006/img at low quality, uses OPENAI_API_KEY);
  // "fal" = FLUX.1 schnell (cheapest, but won't render true stick figures,
  // needs FAL_KEY); "mock" draws solid cards so the pipeline runs keyless.
  IMAGE_PROVIDER: z.enum(["mock", "openai", "fal"]).default("mock"),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-1-mini"),
  // Quality tier for the OpenAI image model. "low" keeps a 15-beat story at
  // ~$0.09; "medium" (~$0.22) is sharper; "high"/"auto" cost far more.
  // medium, not low: low renders soft, vague detail — a big part of why
  // environments (e.g. a bunker interior) read as generic instead of accurate.
  OPENAI_IMAGE_QUALITY: z.enum(["auto", "low", "medium", "high"]).default("medium"),
  FAL_KEY: z.string().optional().default(""),
  FAL_IMAGE_MODEL: z.string().default("fal-ai/flux/schnell"),
  // ── Cook Studio (generated cook-in-the-wild videos) ────────────────────────
  // Google Veo via the Gemini API DIRECTLY (no fal reseller markup). Veo 3.1
  // Fast @ 720p ≈ $0.10/sec (~$0.80/8s clip). Provider AUTO-selects: set
  // GEMINI_API_KEY (from Google AI Studio) and it uses Google; leave it blank
  // and it uses a stub mp4. So adding the key is the only setup.
  VIDEO_PROVIDER: z.enum(["auto", "mock", "google"]).default("auto"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_VEO_MODEL: z.string().default("veo-3.1-fast-generate-preview"),
  VEO_RESOLUTION: z.string().default("720p"),
  // A NUMBER, not a string: the API rejects "8" with "The value type for
  // durationSeconds needs to be a number", even though Google's own parameter
  // table documents it as a string. Coerced so an env var (always a string)
  // still arrives as one.
  VEO_DURATION_SECONDS: z.coerce.number().min(4).max(8).default(8),
  // Ceiling on shots == clips per cook video (cost cap; ~$0.80/shot on Fast).
  // 9 x 8s = 72s, over the 60s TikTok Creator Rewards line.
  COOK_MAX_SHOTS: z.coerce.number().min(2).max(12).default(9),
  // Photoreal still for each cook shot, used as the clip's FIRST FRAME so the
  // video model animates an approved scene instead of imagining one. Same
  // GEMINI_API_KEY; "auto" turns it on when the key is present. gemini-2.5-flash-image
  // ($0.039) can edit the previous frame forward, which is what holds the stone,
  // fire and props steady across cuts. "off" reverts to pure text-to-video.
  SCENE_IMAGE_PROVIDER: z.enum(["auto", "off", "google"]).default("auto"),
  GEMINI_IMAGE_MODEL: z.string().default("gemini-2.5-flash-image"),
  // ── Call Studio (fictional prank calls / talk-show rage bait) ──────────────
  // Also Google, also the same GEMINI_API_KEY: a text model improvises the
  // dialogue from the approved brief, then a multi-speaker TTS model performs
  // it. At ~$10/M audio output tokens a 60s call is ~2¢ — the cheapest format
  // here by an order of magnitude. AUTO-selects on the key, like video.
  CALL_PROVIDER: z.enum(["auto", "mock", "google"]).default("auto"),
  GEMINI_TTS_MODEL: z.string().default("gemini-2.5-flash-preview-tts"),
  GEMINI_TEXT_MODEL: z.string().default("gemini-flash-latest"),
  // Target spoken length; the planner paces the escalation to fit. Default 75s
  // so calls clear the 60-second line like every other format (the old 50s
  // default produced sub-minute videos). ~3c of Gemini audio at this length.
  CALL_MAX_SECONDS: z.coerce.number().min(20).max(90).default(75),

  // ── Animation Studio (fully animated stick shorts) ─────────────────────────
  // One generated clip per narrated beat, so figures actually move. Stick art
  // asks far less of the model than photoreal cooking, so it runs on the cheap
  // tier: Veo 3.1 Lite is $0.05/s (half of Fast) and still does image-to-video.
  // 9 x 8s = 72s for ~$3.60. Set GEMINI_ANIM_MODEL to Fast if Lite disappoints.
  GEMINI_ANIM_MODEL: z.string().default("veo-3.1-lite-generate-preview"),
  // 12 x 6s = 72s. Cost is per SECOND, so this is the same spend as 9 x 8s while
  // cutting a third more often — and 6s is short enough that the model has to
  // actually move the characters instead of drifting for eight seconds.
  ANIM_MAX_SHOTS: z.coerce.number().min(2).max(24).default(12),
  // Per-clip length for animation only; cook keeps VEO_DURATION_SECONDS (8).
  // Must be 4, 6 or 8 — and 8 if you ever raise VEO_RESOLUTION past 720p.
  ANIM_CLIP_SECONDS: z.coerce.number().min(4).max(8).default(6),
  // Parallel video calls. Default 1: Veo 3.1 PREVIEW models (Lite/Fast) are only
  // ~10 requests/min and 10 concurrent on Tier 1 — far below the 50 RPM of the
  // production tier — and each shot ALSO polls every 8-20s, so even 2 in flight
  // brushes the ceiling and 429s. Raise it only on Tier 2+.
  ANIM_CONCURRENCY: z.coerce.number().min(1).max(6).default(1),
  // Ceiling on narrated BEATS per story (sentences, not images). Long-form runs
  // ~8 minutes, which is roughly 45 sentence-length beats.
  STORY_MAX_BEATS: z.coerce.number().min(4).max(60).default(50),
  // Seconds each SHOT holds — the same fast cadence for BOTH long and short (a
  // swipe feed punishes a static frame). A narration beat that runs longer than
  // this is split into that many VISUALLY DISTINCT shots (wide → close-up →
  // detail), never the same image nudged. ~2.5s ≈ short ~32 imgs, long ~190.
  STORY_IMAGE_SECONDS: z.coerce.number().min(1.5).max(8).default(2.5),
  // Hard ceiling on images per video (cost cap). Long at 2.5s over ~8 min needs
  // ~190; at gpt-image-1-mini medium (~$0.011) that's ~$2/long video (~$0.35 for
  // a short). Longs aren't published yet, so the cost lives with the format.
  STORY_MAX_IMAGES: z.coerce.number().min(4).max(300).default(220),
  // Slow per-slide push-in. OFF by default: on a fast ~2.5s cadence the zoom read
  // as an annoying vibration, not a cinematic drift, and the image already
  // changes often enough to feel alive. Opt in with "true" if you want it back
  // (the filter is de-jittered via a 2x working scale). String enum, not
  // z.coerce.boolean — the latter reads "false" as truthy.
  STORY_KEN_BURNS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  DOWNLOAD_DRIVER: z.enum(["mock", "ytdlp"]).default("mock"),
  MOCK_VIDEO_DURATION_SEC: z.coerce.number().default(180),
  /** Optional yt-dlp proxy (http://user:pass@host:port) for YouTube/geo blocks. */
  YTDLP_PROXY: z.string().optional().default(""),
  /** Optional path to a Netscape cookies.txt for logged-in downloads. */
  YTDLP_COOKIES_FILE: z.string().optional().default(""),

  // ── Clip detection knobs (no more hardcoded "always 4") ──────────────────────
  /** Hard ceiling on clips kept per source video after scoring/ranking. */
  DETECT_MAX_CLIPS: z.coerce.number().int().min(1).default(30),
  /** Overall-score floor (0-100): candidates below this are discarded. */
  DETECT_MIN_SCORE: z.coerce.number().min(0).max(100).default(55),
  /** Shortest allowed clip, seconds. */
  DETECT_MIN_DURATION_SEC: z.coerce.number().min(1).default(12),
  /** Longest allowed clip, seconds. */
  DETECT_MAX_DURATION_SEC: z.coerce.number().min(1).default(60),
  /** Transcript is chunked into windows of this many minutes for the LLM pass. */
  DETECT_CHUNK_MIN: z.coerce.number().min(1).default(12),
  /** Enable the audio-energy peak detector (catches non-speech moments). */
  DETECT_AUDIO_PEAKS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * Read on-screen text from up to 12 sampled frames to learn who/what a video
   * is about (batched vision with early stop, ≤~3¢/video). Live AI only.
   */
  VISION_CONTEXT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  PUBLISH_DRIVER: z.enum(["mock", "live"]).default("mock"),

  // ── Finder (source discovery) ──────────────────────────────────────────────
  // Opt-in: needs Reddit app credentials. When off, the poll never runs.
  DISCOVERY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  REDDIT_CLIENT_ID: z.string().optional().default(""),
  REDDIT_CLIENT_SECRET: z.string().optional().default(""),
  REDDIT_USER_AGENT: z.string().default("clipfactory/1.0"),
  /** Comma-separated subreddits to watch (without "r/"). */
  DISCOVERY_SUBREDDITS: z.string().default("PublicFreakout,nextfuckinglevel,sports,funny,Damnthatsinteresting"),
  DISCOVERY_POLL_MIN: z.coerce.number().min(1).default(15),
  DISCOVERY_MAX_AGE_H: z.coerce.number().min(1).default(24),

  BETTER_AUTH_SECRET: z.string().default("dev-only-secret-change-me"),
  /** Key for encrypting vault secrets (account passwords). Falls back to BETTER_AUTH_SECRET. */
  CREDENTIALS_SECRET: z.string().optional().default(""),
  API_URL: z.string().default("http://localhost:3001"),
  WEB_URL: z.string().default("http://localhost:3000"),
  API_PORT: z.coerce.number().default(3001),

  ADMIN_EMAIL: z.string().default("admin@clipfactory.local"),
  ADMIN_PASSWORD: z.string().default("admin1234"),
});

export type Env = z.infer<typeof EnvSchema>;

/** Walks up from cwd to the workspace root (pnpm-workspace.yaml) to find .env. */
export function findWorkspaceRoot(startDir = process.cwd()): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const root = findWorkspaceRoot();
  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook. */
export function resetEnvCache(): void {
  cached = undefined;
}
