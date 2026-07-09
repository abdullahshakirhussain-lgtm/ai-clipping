# API Reference

Base URL: `http://localhost:3001`
Versioned routes are under `/api/v1`. Interactive OpenAPI reference: **`/docs`**.

All request/response schemas are defined once as zod schemas in
[`packages/core/src/contracts`](../packages/core/src/contracts) and shared by the Fastify
server (validation + serialization + OpenAPI generation) and the web client (types). The
generated OpenAPI spec is always in sync with the code.

## Auth

Better Auth is mounted at `/api/auth/*` (email + password). The session cookie is set on the
API origin; the dashboard sends it with `credentials: "include"`. On an empty database the
API bootstraps an admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

All `/api/v1/*` routes except `/api/v1/files/*` require a valid session (401 otherwise).

## Error envelope

Every error returns a uniform shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "Clip abc123 not found" } }
```

Codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`CONFLICT` (409), `INTERNAL_ERROR` (500).

## Endpoints

### Campaigns
| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/campaigns` | — | list with counts |
| GET | `/campaigns/:id` | — | single |
| POST | `/campaigns` | `CreateCampaignInput` | `creator` inline or `creatorId`; `ingestNow` starts pipeline |
| PATCH | `/campaigns/:id` | `UpdateCampaignInput` | status/platforms/rate/rules/expiry |
| POST | `/campaigns/:id/ingest` | — | creates a SourceVideo, enqueues `video.download` |

### Videos (intake)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/videos?campaignId&status` | intake queue |
| GET | `/videos/:id` | includes transcript + segments |

### Clips + review
| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/clips?status&campaignId&sourceVideoId&take&skip` | — | `{ items, total }` |
| GET | `/clips/:id` | — | detail incl. transcript excerpt + review history |
| POST | `/clips/:id/review` | `{ action, note? }` | APPROVE / REJECT / REGENERATE / IMPROVE_HOOK / IMPROVE_CAPTIONS |
| POST | `/clips/:id/publish` | `{ accountIds[], scheduledAt? }` | one PublishJob per account |

Legal review actions depend on clip status (the state machine lives in
[`ReviewService.allowedActions`](../packages/core/src/services/review-service.ts)); an illegal
action returns 409.

### Publishing
| Method | Path | Notes |
|--------|------|-------|
| GET | `/publish-jobs?status&clipId` | queue + logs |
| GET | `/publish-jobs/:id` | single with attempt log |
| POST | `/publish-jobs/:id/retry` | FAILED → QUEUED |
| POST | `/publish-jobs/:id/cancel` | QUEUED/SCHEDULED → CANCELLED |

### Accounts
| Method | Path | Body |
|--------|------|------|
| GET | `/accounts` | — |
| POST | `/accounts` | `CreateAccountInput` |
| PATCH | `/accounts/:id` | `UpdateAccountInput` |

### Analytics
| Method | Path | Notes |
|--------|------|-------|
| GET | `/analytics/overview` | pipeline counts, totals, by-platform, top clips, queue health |
| GET | `/analytics/revenue` | revenue by campaign (views × rate/1000) |
| GET | `/analytics/clips/:id` | metric time series for one clip |
| POST | `/analytics/sync` | enqueue a metrics sweep of published posts |

### System
| Method | Path | Notes |
|--------|------|-------|
| GET | `/system/queues` | per-queue waiting/active/failed |
| GET | `/system/me` | current user |
| GET | `/health` | liveness (unauthenticated) |
| GET | `/api/v1/files/*` | dev-only local object serving with HTTP range support |

## Example: create a campaign and start the pipeline

```bash
curl -X POST http://localhost:3001/api/v1/campaigns \
  -H 'content-type: application/json' --cookie "$SESSION" \
  -d '{
    "name": "Podcast Ep. 42",
    "sourceVideoUrl": "https://www.youtube.com/watch?v=xxxx",
    "allowedPlatforms": ["TIKTOK","YOUTUBE"],
    "revenueRatePerMille": 1.25,
    "creator": { "name": "Alex Rivera", "handle": "alexrivera" },
    "ingestNow": true
  }'
```

The response is the campaign; candidate clips appear at `GET /clips?status=READY_FOR_REVIEW`
once the (mock or live) pipeline finishes.
