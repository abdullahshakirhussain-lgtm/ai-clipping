import { z } from "zod";

/** A discovered candidate as shown in the Finder feed. */
export const DiscoveredVideoDtoSchema = z.object({
  id: z.string(),
  platform: z.string(),
  url: z.string(),
  permalink: z.string(),
  title: z.string(),
  thumbnailUrl: z.string().nullable(),
  author: z.string().nullable(),
  source: z.string(),
  mediaType: z.string(),
  sourceCreatedAt: z.string(),
  score: z.number().int(),
  comments: z.number().int(),
  velocity: z.number(),
  /** Age in hours at DTO time — the feed shows "how fresh". */
  ageHours: z.number(),
  status: z.enum(["NEW", "INGESTED", "HIDDEN"]),
  ingestedVideoId: z.string().nullable(),
});
export type DiscoveredVideoDto = z.infer<typeof DiscoveredVideoDtoSchema>;

/**
 * Settings applied when a discovered video is sent into the pipeline — the same
 * knobs as a manual upload (the Finder defaults them from the upload settings).
 */
export const IngestDiscoveredInputSchema = z.object({
  category: z.string().max(60).optional(),
  commentaryMode: z.enum(["off", "intro_outro", "interject", "full"]).optional(),
  subtitlesOnly: z.boolean().optional(),
  untouched: z.boolean().optional(),
  captionStyle: z.enum(["bold-center", "yellow-pop", "clean-bottom"]).optional(),
  captionPosition: z.enum(["top", "middle", "bottom"]).optional(),
  reframe: z.boolean().optional(),
  autoEnhance: z.boolean().optional(),
});
export type IngestDiscoveredInput = z.infer<typeof IngestDiscoveredInputSchema>;
