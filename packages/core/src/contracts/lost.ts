import { z } from "zod";

/**
 * "Lost Chronicles" — calm anime Veo shorts, built around a COST GATE so no paid
 * Veo render is ever wasted:
 *   1. plan   (cheap text)  — a scene → editable still + motion prompts + caption.
 *   2. preview(cheap ~$0.04)— render the anime STILL, iterate until it's perfect.
 *   3. create (Veo, ONCE)   — animate the APPROVED still (by storage key) + slow to length.
 * Both plan and preview run in the background (planJobs) and the client polls,
 * so a slow model call can't hit the proxy's ~30s cutoff.
 */

/** Curated starter scenes (the UI also allows free text). */
export const LOST_SCENES = [
  "an ancient library swallowed by a forest, golden light through a collapsed roof",
  "an overgrown stone temple at dusk, vines and moss over the carvings, fireflies",
  "a forgotten town square, a dry fountain, tall grass between the flagstones",
  "sunken ruins in a shallow crystal lake, half-submerged pillars, koi weaving between them",
  "a misty mountain village at sunrise, smoke from a few chimneys, terraced fields",
  "a quiet seaside harbour at dawn, wooden boats, soft mist, a figure at the end of the pier",
  "a snowbound village at night, lantern-lit windows, gentle falling snow",
  "an old shrine courtyard under falling cherry blossoms, a stone basin, a wind chime",
  "floating sky islands with a ruined temple, drifting clouds, a thin waterfall off the edge",
  "a cliff-top lighthouse at twilight, sweeping beam, tall grass bending in the wind",
  "a lone traveller on a hill overlooking an endless valley of ruins at low sun",
  "a desert caravan resting among half-buried statues at sunset",
  "a campfire beside ancient standing stones under an aurora, embers rising",
  "rain on the porch of an old wooden house, dripping eaves, a cat by the door",
  "a floating-lantern night on a still lake, lanterns lifting, mirrored in the water",
  "a wooden boat drifting down a forest river, dappled light, a figure lying back",
] as const;

// ── Step 1: plan (background + poll) ────────────────────────────────────────
export const LostPlanRequestSchema = z.object({
  scene: z.string().min(3).max(400),
  direction: z.string().max(600).optional(),
});
export type LostPlanRequest = z.infer<typeof LostPlanRequestSchema>;

export const LostPlanSchema = z.object({
  stillPrompt: z.string(),
  motionPrompt: z.string(),
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
});
export type LostPlanDto = z.infer<typeof LostPlanSchema>;

export const LostPlanStatusSchema = z.object({
  status: z.enum(["pending", "done", "error"]),
  elapsedMs: z.number(),
  plan: LostPlanSchema.optional(),
  error: z.string().optional(),
});

// ── Step 2: preview the still (background + poll) ────────────────────────────
export const LostPreviewRequestSchema = z.object({
  stillPrompt: z.string().min(3).max(4000),
});
export type LostPreviewRequest = z.infer<typeof LostPreviewRequestSchema>;

/** The generated still: its storage key (passed back to create) + a viewable URL. */
export const LostPreviewSchema = z.object({ stillKey: z.string(), url: z.string() });
export type LostPreviewDto = z.infer<typeof LostPreviewSchema>;

export const LostPreviewStatusSchema = z.object({
  status: z.enum(["pending", "done", "error"]),
  elapsedMs: z.number(),
  plan: LostPreviewSchema.optional(),
  error: z.string().optional(),
});

// ── Step 3: create — animate the APPROVED still, once ───────────────────────
export const CreateLostInputSchema = z.object({
  scene: z.string().min(3).max(400),
  /** Storage key of the approved still — the exact frame Veo will animate. */
  stillKey: z.string().min(1),
  stillPrompt: z.string().max(4000),
  motionPrompt: z.string().min(1).max(2000),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  hashtags: z.array(z.string()).max(10).optional(),
  category: z.string().max(60).optional(),
});
export type CreateLostInput = z.infer<typeof CreateLostInputSchema>;
