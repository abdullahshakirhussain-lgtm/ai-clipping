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

  DOWNLOAD_DRIVER: z.enum(["mock", "ytdlp"]).default("mock"),
  MOCK_VIDEO_DURATION_SEC: z.coerce.number().default(180),

  PUBLISH_DRIVER: z.enum(["mock", "live"]).default("mock"),

  BETTER_AUTH_SECRET: z.string().default("dev-only-secret-change-me"),
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
