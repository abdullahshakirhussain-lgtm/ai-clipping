import { z } from "zod";

/**
 * Manual clip workflow: automate everything EXCEPT the paid video generation.
 * The pipeline writes the script, the voiceover and the per-clip video prompts
 * (and a character reference for Video); the user generates each clip on a free
 * platform and uploads them one-by-one; then the pipeline assembles the result.
 * Two formats share it: "video" (auto voiceover) and "cook" (native clip audio).
 */
export const MANUAL_FORMATS = ["video", "cook", "pov"] as const;

// ── Plan (background + poll — like Cook) ────────────────────────────────────
export const ManualPlanRequestSchema = z.object({
  format: z.enum(MANUAL_FORMATS),
  /** Topic (video) or dish (cook). */
  topic: z.string().min(3).max(300),
  /** Video only: free-text direction — what to write, the angle/tone, what to
   *  mention or avoid. Honoured on top of the doctrine, without overriding it.
   *  Roomy (~1500 words) so a full brief fits. */
  direction: z.string().max(12000).optional(),
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
  /** First/single character reference image URL (back-compat). */
  characterRefUrl: z.string().nullable(),
  /** All character reference image URLs — POV returns several trademark-hand poses
   *  to feed one Flow Ingredient; video returns its single ref; cook returns none. */
  characterRefUrls: z.array(z.string()).optional(),
  /** POV only: the cinematic intro hook ("Constantinople · 1453 · Dawn") that the
   *  Veo prompt renders and fades out. null for other formats. */
  hook: z.string().nullable().optional(),
  /** POV only: one-sentence summary shown for approval before the prompts. */
  logline: z.string().nullable().optional(),
  /** POV only: a short one-line label per clip (what that beat shows) — the
   *  approval summary lists these instead of the full verbose prompts. */
  beatLabels: z.array(z.string()).optional(),
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
