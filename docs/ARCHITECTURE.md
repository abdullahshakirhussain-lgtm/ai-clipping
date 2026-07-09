# Architecture

AI Clipping Factory turns long-form source videos into reviewed, published short-form
clips at scale. The design goal is to **minimize human work** — the only manual step is a
fast review gate (target < 15s/clip) — while keeping every stage modular, typed, and
independently scalable.

## System shape

```
                 ┌─────────────┐      enqueue      ┌──────────────────────┐
   Dashboard ───▶│   API       │ ─────────────────▶│  Queue (BullMQ/Redis │
   (Next.js)     │  (Fastify)  │                   │   or in-process)     │
        ▲        └──────┬──────┘                   └──────────┬───────────┘
        │               │ services / repos                    │ jobs
        │               ▼                                     ▼
        │        ┌─────────────┐                     ┌──────────────────┐
        └────────│ PostgreSQL  │◀────────────────────│  Worker(s)       │
          reads  │  (Prisma)   │   read/write        │  pipeline stages │
                 └─────────────┘                     └────────┬─────────┘
                                                              │ uses
                        ┌─────────────────────────────────────┼───────────────────┐
                        ▼                 ▼                    ▼                   ▼
                   Object storage    AI providers        Media (FFmpeg)      Publishers
                   (R2 / local)      (Groq, Anthropic)   (yt-dlp, ffmpeg)    (TikTok/IG/YT)
```

Two runnable processes share one set of packages:

- **`apps/api`** — thin HTTP layer. Validates requests (zod), calls a service, returns a
  DTO or enqueues a job. Never does heavy work in a request handler.
- **`apps/worker`** — runs the pipeline stage processors. Video work is CPU/IO heavy and
  long-running, so it lives here, out of the request path.

In development (`QUEUE_DRIVER=inprocess`) the API process also runs the pipeline in-process,
so a single `pnpm dev` gives a fully working system with no Redis.

## Layering (Clean Architecture)

```
route / job processor      → apps/*        (transport; no business logic)
  service                  → packages/core (use-cases, orchestration, state machines)
    repository             → packages/db   (all Prisma access; the only SQL layer)
      Prisma / Postgres
```

Cross-cutting providers (storage, AI, media, publishers, queue) are defined as
**interfaces** in their packages and injected into services and pipeline stages through a
small hand-rolled container ([packages/core/src/container.ts](../packages/core/src/container.ts)).
No DI framework — just typed factory functions selected by environment.

### Why a repository layer

Every query lives in `packages/db/src/repositories/*`. Services never touch Prisma
directly. This keeps SQL in one place, makes services trivially unit-testable with mocked
repos (see the tests), and lets us swap query strategies (e.g. materialized rollups) without
touching business logic.

### Guarded status transitions

Entities move through explicit state machines (`SourceVideoStatus`, `ClipStatus`,
`PublishJobStatus`). Repositories expose `transition(id, from[], to)` backed by a conditional
`UPDATE ... WHERE status IN (...)`. Pipeline stages call this before doing work, which makes
every stage **idempotent** — a redelivered job that already ran is a no-op, not a double
render or double publish.

## The pipeline

Each stage is a pure function of `(PipelineContext, id)` in
[packages/core/src/pipeline/stages.ts](../packages/core/src/pipeline/stages.ts). On success a
stage advances the entity's status and enqueues the next stage; on failure it records the
error and lands the entity in a terminal `FAILED` state visible in the dashboard.

| Queue | Stage | Does |
|-------|-------|------|
| `video.download` | download | yt-dlp → object storage, probe metadata (ffprobe) |
| `video.transcribe` | transcribe | Whisper (Groq) → word-level timestamped transcript |
| `clip.detect` | detect | Claude reads transcript → N candidate windows |
| `clip.render` | render | FFmpeg cut → 9:16 crop → burn ASS captions → MP4 |
| `clip.enhance` | enhance | Claude: title/description/hashtags/hooks/scores → **READY_FOR_REVIEW** |
| `publish.execute` | publish | PublisherAdapter, per-attempt logging, exponential backoff retries |
| `analytics.sync` | sync | poll platform metrics → append ClipMetric + refresh ClipFeature |

Human review sits between `clip.enhance` and `publish.execute`. Review actions
(regenerate / improve hook / improve captions) simply re-enqueue the relevant stage.

## Provider abstractions and drivers

Every external dependency has an interface + a real driver + a mock driver, chosen by env:

| Concern | Interface | Real driver | Mock (default) |
|---------|-----------|-------------|----------------|
| Storage | `ObjectStorage` | Cloudflare R2 (S3 SDK) | local disk, served via API |
| Transcription | `TranscriptionProvider` | Groq Whisper | deterministic synthetic transcript |
| LLM | `LlmProvider` | Anthropic Claude | deterministic scores/hooks |
| Download | `DownloadProvider` | yt-dlp | FFmpeg-synthesized test video |
| Publishing | `PublisherAdapter` | TikTok / IG / YouTube | instant success + growth-curve metrics |
| Queue | `Dispatcher` | BullMQ + Redis | in-process FIFO with retry/backoff |

This is what lets the whole loop run end-to-end with **zero API keys and no Redis** — flip
each driver to its live implementation by adding credentials and restarting.

## Decision records

- **DR-1 Self-built AI pipeline** over a third-party clipping API. At 100 clips/day the
  per-clip cost and quality control of owning the pipeline (yt-dlp + Whisper + Claude +
  FFmpeg) outweighs the faster integration of a vendor. Each step is behind an interface, so
  a vendor could still be dropped in for one stage later.
- **DR-2 Better Auth** over Clerk. This is an internal ops tool (admins + reviewers), so
  self-hosted, Prisma-backed, no per-MAU cost fits better than a managed consumer-auth SaaS.
- **DR-3 Cloudflare R2** over S3. Videos are pulled repeatedly (processing, review preview,
  publishing). R2's zero egress fees matter at video scale; the S3-compatible SDK keeps the
  code portable.
- **DR-4 Separate API and worker processes** sharing `packages/*`. Lets render/transcode
  concurrency scale independently of HTTP traffic, and keeps request latency flat.
- **DR-5 Two queue drivers.** BullMQ for production; an in-process driver for dev so the
  product is runnable with `pnpm dev` alone. Same `Dispatcher` interface, same handlers.
- **DR-6 Denormalized `ClipMetric` + `ClipFeature`.** `ClipMetric` is an append-only time
  series (latest row = current stats, history = trend). `ClipFeature` is one row per
  published clip capturing hook/length/topic/caption-style/timing/performance — the training
  substrate for the Learning Engine's future recommendations.

## Publishing APIs — real-world constraint

The TikTok Content Posting API, Instagram Graph API, and YouTube Data API each require a
**registered, approved developer app** and per-account OAuth before real publishing works:

- **TikTok** — Content Posting API, `video.publish` scope, app audit (unaudited apps can
  only post `SELF_ONLY`). PULL_FROM_URL flow is implemented.
- **Instagram** — Reels via Graph API needs a Business/Creator account linked to a Facebook
  Page, an approved Meta app with `instagram_content_publish`, and the two-step container flow.
- **YouTube** — Data API v3 resumable upload, OAuth with `youtube.upload` scope.

The adapters in `packages/publishers` are written to these real request shapes, but the
**mock publisher is the default** so the system is fully demonstrable before any platform
approvals land. Add credentials to a `SocialAccount` and set `PUBLISH_DRIVER=live` to go real.

## Scaling notes (toward 100 clips/day and beyond)

- Stage concurrency is tuned per queue in [apps/worker](../apps/worker/src/index.ts) — render
  kept low (CPU-bound FFmpeg), enhance/publish higher (IO-bound API calls). Scale render by
  adding worker machines.
- The API is stateless; run N replicas behind a load balancer. Sessions live in Postgres.
- `MetricsRepository.latestPerJob` uses `DISTINCT ON` today; move to materialized rollups
  when published-post count grows large.
- Object storage and Postgres are the stateful tiers; everything else scales horizontally.
