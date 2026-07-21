import { Prisma } from "@clipfactory/db";
import type { CampaignWithRelations, PublishJobDetail } from "@clipfactory/db";
import type { ObjectStorage } from "@clipfactory/storage";
import type {
  CampaignDto,
  ClipDto,
  CommentaryLineDto,
  Hooks,
  PublishJobDto,
  SocialAccountDto,
  SourceVideoDto,
} from "./contracts/index.js";

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export type ClipListRow = Prisma.ClipGetPayload<{
  include: {
    enhancement: true;
    campaign: true;
    publishJobs: { include: { socialAccount: true } };
  };
}>;

type AccountRow = Prisma.SocialAccountGetPayload<{
  include: { _count: { select: { publishJobs: true } } };
}>;

type VideoListRow = Prisma.SourceVideoGetPayload<{
  include: { campaign: true; _count: { select: { clips: true } } };
}>;

export function toCampaignDto(c: CampaignWithRelations): CampaignDto {
  return {
    id: c.id,
    name: c.name,
    sourceVideoUrl: c.sourceVideoUrl ?? null,
    sourcePlatform: c.sourcePlatform,
    allowedPlatforms: c.allowedPlatforms,
    rules: (c.rules as Record<string, unknown> | null) ?? null,
    expiresAt: isoOrNull(c.expiresAt),
    status: c.status,
    sourceVideoCount: c._count.sourceVideos,
    clipCount: c._count.clips,
    createdAt: iso(c.createdAt),
  };
}

export function toSourceVideoDto(v: VideoListRow): SourceVideoDto {
  return {
    id: v.id,
    campaignId: v.campaignId,
    campaignName: v.campaign.name,
    originalUrl: v.originalUrl,
    status: v.status,
    title: v.title,
    durationSec: v.durationSec,
    clipCount: v._count.clips,
    category: v.category,
    error: v.error,
    createdAt: iso(v.createdAt),
    captionStyle: v.captionStyle,
    captionPosition: v.captionPosition,
    reframe: v.reframe,
    autoEnhance: v.autoEnhance,
    subtitlesOnly: v.subtitlesOnly,
    untouched: v.untouched,
    commentaryMode: v.commentaryMode,
    context: v.context ?? null,
    autoContext: v.autoContext ?? null,
    kind: v.kind,
    storyProgress:
      (v.storySpec as { progress?: { stage: string; pct: number } } | null)?.progress ?? null,
    storyScript: (v.storySpec as { script?: string } | null)?.script ?? null,
  };
}

function parseHooks(hooks: Prisma.JsonValue | null | undefined): Hooks | null {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const h = hooks as { variants?: unknown; selectedIndex?: unknown };
  if (!Array.isArray(h.variants)) return null;
  return {
    variants: h.variants.map(String),
    selectedIndex: typeof h.selectedIndex === "number" ? h.selectedIndex : 0,
  };
}

export async function toClipDto(clip: ClipListRow, storage: ObjectStorage): Promise<ClipDto> {
  const [previewUrl, thumbnailUrl] = await Promise.all([
    clip.storageKey ? storage.getUrl(clip.storageKey) : Promise.resolve(null),
    clip.thumbnailKey ? storage.getUrl(clip.thumbnailKey) : Promise.resolve(null),
  ]);
  const e = clip.enhancement;
  return {
    id: clip.id,
    campaignId: clip.campaignId,
    campaignName: clip.campaign.name,
    allowedPlatforms: clip.campaign.allowedPlatforms,
    sourceVideoId: clip.sourceVideoId,
    startSec: clip.startSec,
    endSec: clip.endSec,
    durationSec: Math.round((clip.endSec - clip.startSec) * 10) / 10,
    status: clip.status,
    previewUrl,
    thumbnailUrl,
    detectionReason: clip.detectionReason,
    captionStyle: clip.captionStyle,
    error: clip.error,
    title: e?.title ?? null,
    description: e?.description ?? null,
    hashtags: e?.hashtags ?? [],
    hooks: parseHooks(e?.hooks),
    qualityScore: e?.qualityScore ?? null,
    estimatedEngagement: e?.estimatedEngagement ?? null,
    hookScore: clip.hookScore,
    viralScore: clip.viralScore,
    overallScore: clip.overallScore,
    scoreBreakdown: (clip.scoreBreakdown as Record<string, unknown> | null) ?? null,
    detectionSource: clip.detectionSource,
    kept: clip.kept,
    category: clip.category ?? null,
    hasSfx: Array.isArray((clip.edl as { sfx?: unknown[] } | null)?.sfx)
      ? (clip.edl as { sfx?: unknown[] }).sfx!.length > 0
      : false,
    commentary: Array.isArray((clip.edl as { commentary?: unknown[] } | null)?.commentary)
      ? ((clip.edl as { commentary: CommentaryLineDto[] }).commentary ?? [])
      : [],
    voiceTier: clip.voiceTier,
    outcome: clip.outcome ?? null,
    publishJobs: clip.publishJobs.map((j) => ({
      jobId: j.id,
      platform: j.socialAccount.platform,
      accountHandle: j.socialAccount.handle,
      status: j.status,
      externalUrl: j.externalUrl,
    })),
    createdAt: iso(clip.createdAt),
  };
}

export function toPublishJobDto(job: PublishJobDetail): PublishJobDto {
  return {
    id: job.id,
    clipId: job.clipId,
    clipTitle: job.clip.enhancement?.title ?? null,
    campaignName: job.clip.campaign.name,
    platform: job.socialAccount.platform,
    accountHandle: job.socialAccount.handle,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    scheduledAt: isoOrNull(job.scheduledAt),
    publishedAt: isoOrNull(job.publishedAt),
    externalUrl: job.externalUrl,
    lastError: job.lastError,
    attemptsLog: job.publishAttempts.map((a) => ({
      startedAt: iso(a.startedAt),
      finishedAt: isoOrNull(a.finishedAt),
      success: a.success,
      response: a.response ?? null,
    })),
    createdAt: iso(job.createdAt),
  };
}

export function toAccountDto(a: AccountRow): SocialAccountDto {
  return {
    id: a.id,
    platform: a.platform,
    handle: a.handle,
    displayName: a.displayName,
    username: a.username,
    hasPassword: a.passwordEnc !== null,
    category: a.category,
    channelId: a.channelId,
    postsPerDay: a.postsPerDay,
    activeStartHour: a.activeStartHour,
    activeEndHour: a.activeEndHour,
    timezone: a.timezone,
    status: a.status,
    publishJobCount: a._count.publishJobs,
    hasCredentials: a.credentials !== null,
    createdAt: iso(a.createdAt),
  };
}
