import { z } from "zod";

/**
 * Manual clip workflow: automate everything EXCEPT the paid video generation.
 * The pipeline writes the script, the voiceover and the per-clip video prompts
 * (and a character reference for Video); the user generates each clip on a free
 * platform and uploads them one-by-one; then the pipeline assembles the result.
 * Two formats share it: "video" (auto voiceover) and "cook" (native clip audio).
 */
export const MANUAL_FORMATS = ["video", "cook"] as const;

// ── Plan (background + poll — like Cook) ────────────────────────────────────
export const ManualPlanRequestSchema = z.object({
  format: z.enum(MANUAL_FORMATS),
  /** Topic (video) or dish (cook). */
  topic: z.string().min(3).max(300),
  length: z.enum(["short", "long"]).default("short"),
  category: z.string().max(60).optional(),
});
export type ManualPlanRequest = z.infer<typeof ManualPlanRequestSchema>;

export const ManualClipSchema = z.object({ prompt: z.string(), seconds: z.number() });

/** The plan: created SourceVideo id + the ordered clip prompts + refs. */
export const ManualPlanSchema = z.object({
  sourceVideoId: z.string(),
  format: z.enum(MANUAL_FORMATS),
  title: z.string(),
  aspect: z.string(),
  clips: z.array(ManualClipSchema),
  /** Character reference image URL (video only) to use on the gen platform. */
  characterRefUrl: z.string().nullable(),
  /** Storage keys already uploaded, index-aligned to clips (null = not yet). */
  uploaded: z.array(z.string().nullable()),
});
export type ManualPlanDto = z.infer<typeof ManualPlanSchema>;

export const ManualPlanStatusSchema = z.object({
  status: z.enum(["pending", "done", "error"]),
  elapsedMs: z.number(),
  plan: ManualPlanSchema.optional(),
  error: z.string().optional(),
});

/** Returned by the per-clip upload + reloadable status. */
export const ManualProgressSchema = z.object({
  uploaded: z.array(z.string().nullable()),
  total: z.number(),
  complete: z.boolean(),
});
