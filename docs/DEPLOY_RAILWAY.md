# Deploying to Railway

This deploys the **simple single-service topology**: one Postgres, one **API**
service (which runs the clipping pipeline in-process), and one **web** service —
with **live AI** (Groq + Anthropic) and **Cloudflare R2** for clip storage. No
Redis, no separate worker.

```
┌──────────┐     ┌─────────────────────────────┐     ┌──────────┐
│ Postgres │◀───▶│ API  (Fastify + pipeline)   │◀───▶│ Cloudflare│
│ (plugin) │     │  yt-dlp · ffmpeg · Whisper  │     │    R2     │
└──────────┘     │  · Claude · in-process queue│     └──────────┘
                 └──────────────┬──────────────┘
                                │ browser calls (CORS)
                         ┌──────┴──────┐
                         │ web (Next)  │
                         └─────────────┘
```

> Scaling to the multi-service topology (dedicated worker + Redis) is a small step
> later — see the last section.

## Prerequisites

- A [Railway](https://railway.app) account and the CLI: `npm i -g @railway/cli` then `railway login`.
- The repo pushed to GitHub (Railway deploys from a connected repo), **or** deploy
  from the local directory with `railway up`.
- A **Cloudflare R2** bucket + an S3 API token (Account ID, Access Key ID, Secret).
- **Groq** and **Anthropic** API keys.

## What's already in the repo

| File | Purpose |
|------|---------|
| `Dockerfile` | Backend image (API / worker) |
| `Dockerfile.web` | Next.js web image |
| `railway.api.json` | API service: Dockerfile, start cmd, **pre-deploy `prisma migrate deploy`**, `/health` check |
| `railway.web.json` | Web service config |
| `railway.worker.json` | Worker config (only for the scalable topology) |
| `.env.production.example` | Every variable to set, annotated `[api]` / `[web]` |

## Step 1 — Create the project and Postgres

```bash
railway login
railway init                      # create a new project (or: railway link)
```

In the Railway dashboard: **New → Database → Add PostgreSQL**. This provides a
`DATABASE_URL` you'll reference from the API service.

## Step 2 — Create the API service

1. **New → GitHub Repo** (select this repo) — or `railway up` from the repo root.
2. Open the service → **Settings**:
   - **Config-as-code / Railway config file:** `railway.api.json`
     (this points the build at `Dockerfile` and sets the migrate pre-deploy step).
   - **Networking:** click **Generate Domain** → note the URL (this is `API_URL`).
3. **Variables** (from `.env.production.example`, the `[api]` ones):
   - `DATABASE_URL` = `${{ Postgres.DATABASE_URL }}`  ← Railway reference, not a literal
   - `NODE_ENV=production`, `QUEUE_DRIVER=inprocess`
   - `STORAGE_DRIVER=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   - `AI_DRIVER=live`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`
   - `DOWNLOAD_DRIVER=ytdlp`, `PUBLISH_DRIVER=mock`
   - `BETTER_AUTH_SECRET` = output of `openssl rand -hex 32`
   - `API_URL` = the API domain from step 2.2
   - `WEB_URL` = the web domain (fill after step 3, then redeploy)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`

The pre-deploy command runs `prisma migrate deploy` against `DATABASE_URL` before
each release, so the schema is applied automatically. On the first boot with an
empty DB, the API creates the admin user from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Step 3 — Create the web service

1. **New → GitHub Repo** (same repo, second service).
2. **Settings → Config file:** `railway.web.json`.
3. **Networking → Generate Domain** → this is `WEB_URL`. Go back and set `WEB_URL`
   on the **API** service, then redeploy the API (needed for CORS + auth origins).
4. **Variables:** set `API_URL` = the API domain. This is read at **build time**
   and baked into the client bundle (`NEXT_PUBLIC_API_URL`), so a change to it
   requires a rebuild of the web service.

## Step 4 — Seed (optional)

Migrations run automatically. Demo data is optional and **destructive** (the seed
wipes domain tables), so only run it on a fresh DB:

```bash
railway run --service <api-service> pnpm --filter @clipfactory/db exec tsx prisma/seed.ts
```

## Step 5 — Verify

- API: open `https://<api-domain>/health` → `{"status":"ok"}`; `…/docs` → OpenAPI UI.
- Web: open `https://<web-domain>` → sign in with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
- Create a campaign with a real source URL and **Ingest** → watch it flow through
  Video Queue → Review Queue (real transcript + AI hooks) → publish (mock) → Analytics.

## Notes, gotchas, and costs

- **Cross-origin cookies:** web and API are on different `*.railway.app` subdomains,
  so the session cookie uses `SameSite=None; Secure` in production (handled in
  [`apps/api/src/auth.ts`](../apps/api/src/auth.ts)). If you put both behind one
  custom domain (`app.example.com` + `api.example.com`), they're same-site and you
  can relax this.
- **CORS:** the API only allows the origin in `WEB_URL`. Keep it exact (https, no
  trailing slash).
- **Pipeline load:** the API container does yt-dlp downloads + FFmpeg rendering.
  Give it a plan with enough RAM/CPU for video work, or move to the scalable
  topology below. Watch memory on long videos.
- **R2:** clips are stored in R2 and served to the browser via presigned URLs, so
  no shared volume is needed. Zero egress fees.
- **Publishing:** stays mock until you register approved TikTok/Meta/YouTube apps
  (see [ARCHITECTURE.md](ARCHITECTURE.md)). Then add per-account credentials and set
  `PUBLISH_DRIVER=live`.

## Scaling up (multi-service topology)

When one container isn't enough for the render/publish throughput (toward 100
clips/day):

1. **Add Redis:** dashboard → New → Database → Redis. Set `REDIS_URL =
   ${{ Redis.REDIS_URL }}` and `QUEUE_DRIVER=bullmq` on **both** the API and worker.
2. **Add a worker service:** New → same repo → Config file `railway.worker.json`,
   same `[api]` variables as the API service. It runs the BullMQ processors and the
   periodic analytics sync.
3. The API now only enqueues jobs; the worker does the heavy lifting. Scale the
   worker's replicas/resources independently of the API.

Nothing else changes — same image, same code, driven entirely by `QUEUE_DRIVER`.
