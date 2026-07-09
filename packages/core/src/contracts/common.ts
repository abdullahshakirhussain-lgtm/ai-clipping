import { z } from "zod";

export const PlatformSchema = z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]);
export type PlatformValue = z.infer<typeof PlatformSchema>;

export const SourcePlatformSchema = z.enum(["YOUTUBE", "TWITCH", "KICK", "RUMBLE", "VIMEO", "OTHER"]);

export const CampaignStatusSchema = z.enum(["DRAFT", "ACTIVE", "PAUSED", "EXPIRED", "ARCHIVED"]);

export const SourceVideoStatusSchema = z.enum([
  "PENDING",
  "DOWNLOADING",
  "DOWNLOADED",
  "TRANSCRIBING",
  "TRANSCRIBED",
  "DETECTING",
  "PROCESSED",
  "FAILED",
]);

export const ClipStatusSchema = z.enum([
  "CANDIDATE",
  "RENDERING",
  "ENHANCING",
  "READY_FOR_REVIEW",
  "APPROVED",
  "REJECTED",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
]);

export const ReviewActionTypeSchema = z.enum([
  "APPROVE",
  "REJECT",
  "REGENERATE",
  "IMPROVE_HOOK",
  "IMPROVE_CAPTIONS",
]);

export const SocialAccountStatusSchema = z.enum(["ACTIVE", "DISABLED", "ERROR"]);

export const PublishJobStatusSchema = z.enum([
  "QUEUED",
  "SCHEDULED",
  "RUNNING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
]);

export const IdParamSchema = z.object({ id: z.string().min(1) });

export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export const OkResponseSchema = z.object({ ok: z.literal(true) });
