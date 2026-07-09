# AI Clipping Factory

An automated pipeline that turns long-form source videos into reviewed, published
short-form clips (TikTok / Reels / Shorts) at scale. The only manual step is a fast
keyboard-driven review gate — everything else (download, transcribe, highlight detection,
9:16 render, captions, metadata, scoring, publishing, analytics) is automated.

Built to run **end-to-end with no API keys and no Redis** via mock drivers, then flip to
live providers (Groq Whisper, Anthropic Claude, Cloudflare R2, BullMQ, real platform APIs)
by adding credentials.

## Stack

Next.js 15 · React 19 · TypeScript · Tailwind v4 · Fastify · Prisma 6 · PostgreSQL ·
BullMQ/Redis · Better Auth · Cloudflare R2 (S3 SDK) · FFmpeg · yt-dlp · pnpm workspaces.

## Layout

```
apps/
  api      Fastify HTTP API (zod-validated, OpenAPI at /docs) + Better Auth
  worker   BullMQ pipeline processors (production) + metrics scheduler
  web      Next.js dashboard (Overview, Campaigns, Video/Review/Publishing queues, …)
packages/
  db          Prisma schema, repositories, seed
  core        contracts (zod), services, pipeline stages, DI container, env, logger
  queue       Dispatcher interface + BullMQ and in-process drivers
  ai          TranscriptionProvider / LlmProvider + Groq, Anthropic, mock drivers
  media       yt-dlp download + FFmpeg render/caption + mock synthesizer
  storage     ObjectStorage + R2 and local drivers
  publishers  PublisherAdapter + TikTok/Instagram/YouTube + mock
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/API.md](docs/API.md).

## Prerequisites

- Node 20+ and pnpm (`corepack enable`)
- A PostgreSQL 16 database (see options below)
- FFmpeg is bundled via `ffmpeg-static` — no manual install needed.

## Quickstart

```bash
pnpm install
cp .env.example .env          # defaults use mock drivers + local storage

# 1. Start a database (pick one — see "Database options" below)
docker compose up -d          # easiest: Postgres + Redis

# 2. Migrate + seed demo data (2 creators, campaigns, 8 clips, 3 accounts)
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 3. Run the API (also runs the in-process pipeline) + the dashboard
pnpm dev                      # api :3001, web :3000
```

Open `http://localhost:3000`, sign in with `admin@clipfactory.local` / `admin1234`
(auto-created on first run), and:

1. **Campaigns → New campaign** (or use the seeded one) → **Ingest video**.
2. Watch it move through **Video Queue** (mock download → transcript → detection).
3. Candidate clips land in **Review Queue** — approve with the keyboard (`A R H C G P`, `← →`).
4. Publishing to a mock account shows up in **Publishing Queue → Published**.
5. **Analytics / Revenue** fill in as the mock metrics sync runs.

For production-style queueing, set `QUEUE_DRIVER=bullmq` + `REDIS_URL` and run the worker:

```bash
pnpm dev:worker
```

## Database options

The app needs a reachable Postgres at `DATABASE_URL`.

- **Docker (recommended):** `docker compose up -d` starts Postgres (`:5432`) and Redis
  (`:6379`). Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/clipfactory`.
- **Embedded (no Docker):** `pnpm dev:db` boots an in-process Postgres on `:5433` under
  `.data/pg` (this is the default `DATABASE_URL` in `.env.example`).
  ⚠️ **PostgreSQL refuses to run under a Windows Administrator account** (a hardcoded
  security check). Use a normal user account, or use Docker, if you hit
  *"Execution of PostgreSQL by a user with administrative permissions is not permitted."*
- **Any existing Postgres:** point `DATABASE_URL` at it and run the migrate/seed steps.

## Drivers (all default to mock)

Configure in `.env`:

| Var | Mock (default) | Live |
|-----|----------------|------|
| `AI_DRIVER` | deterministic transcript + scores | `live` → Groq Whisper + Anthropic Claude (needs keys) |
| `DOWNLOAD_DRIVER` | FFmpeg-synthesized test video | `ytdlp` → real downloads |
| `STORAGE_DRIVER` | `local` disk under `.data/storage` | `r2` → Cloudflare R2 (needs keys) |
| `QUEUE_DRIVER` | `inprocess` (no Redis) | `bullmq` → needs `REDIS_URL` |
| `PUBLISH_DRIVER` | instant success + fake metrics | `live` → real platform APIs (needs approved apps) |

> Real publishing requires approved TikTok / Meta / YouTube developer apps and per-account
> OAuth — see the constraint section in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Scripts

| Command | Does |
|---------|------|
| `pnpm dev` | API + web (in-process pipeline) |
| `pnpm dev:worker` | BullMQ worker (production queueing) |
| `pnpm dev:db` | embedded Postgres on :5433 |
| `pnpm db:migrate` / `db:seed` | Prisma migrate / seed |
| `pnpm typecheck` | typecheck all 11 projects |
| `pnpm test` | unit tests (vitest) |
| `pnpm lint` | eslint |

## Verification status

Verified in this environment:

- ✅ **`pnpm typecheck`** — all 11 projects compile clean.
- ✅ **`pnpm test`** — 10 unit tests pass (review state machine + publish retry/backoff).
- ✅ **API boots and serves** — container graph, all routes, Better Auth, and OpenAPI
  register; `/health` returns ok. (Admin bootstrap is non-fatal if the DB is down.)
- ✅ **Dashboard renders** — Next.js serves the app and login.

Not exercised here: the full DB-backed data flow, because this sandbox runs as a Windows
Administrator (Postgres refuses to start) and has no Docker. On a normal account or with
Docker, `pnpm db:migrate && pnpm db:seed && pnpm dev` runs the complete loop described above.
