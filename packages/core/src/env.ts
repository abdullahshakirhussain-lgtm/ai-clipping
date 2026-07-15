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
  // ── Wave 3 (cloud): transcription provider. "groq" = Whisper (no diarization);
  //    "deepgram" = word-level + speaker labels. Needs DEEPGRAM_API_KEY.
  TRANSCRIBE_PROVIDER: z.enum(["groq", "deepgram"]).default("groq"),
  DEEPGRAM_API_KEY: z.string().optional().default(""),
  DEEPGRAM_MODEL: z.string().default("nova-2"),
  // ── Wave 3 (cloud): subject-aware reframing. "center" = current 9:16 crop;
  //    "cloud" = face/active-speaker tracking via a vision API (REFRAME_API_KEY).
  REFRAME_PROVIDER: z.enum(["center", "cloud"]).default("center"),
  REFRAME_API_KEY: z.string().optional().default(""),

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

  PUBLISH_DRIVER: z.enum(["mock", "live"]).default("mock"),

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
