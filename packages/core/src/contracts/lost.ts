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

/**
 * Curated starter scenes (the UI also allows free text + a suggester). These are
 * PEACEFUL, LIVED-IN, self-sufficient communities without modern tech — the "I'd
 * love to live here" feeling, NOT empty ruins.
 */
export const LOST_SCENES = [
  "a Tuscan hillside village at golden hour, terracotta rooftops, cypress trees and vineyards",
  "a Swiss alpine hamlet in summer, timber chalets with flower boxes, cows in green meadows, snow peaks",
  "a Japanese satoyama mountain village in autumn, tiled farmhouses, rice terraces and a small shrine",
  "a Greek island town at dusk, white cubic houses with blue doors, steps down to a calm sea",
  "a Nepali Himalayan village in morning mist, stone-and-timber houses, terraced fields, prayer flags",
  "an Irish coastal village, whitewashed stone cottages, green cliffs and fishing boats in a small harbour",
  "a Moroccan oasis kasbah at evening, earthen houses, date palms and irrigation channels, warm light",
  "a Vietnamese highland village at dawn, stilt houses, terraced rice paddies and water buffalo in the mist",
  "an English Cotswold village in spring, honey-stone cottages, a village green and a brook",
  "a Scandinavian fjord hamlet, red wooden houses, a jetty on still water, pine forest and steep cliffs",
  "an Andean village in Peru, adobe houses with tiled roofs, terraced fields and llamas on green mountains",
  "a Kerala backwater village, palm-thatched houses along the water, coconut palms and a wooden canoe",
  "a Bavarian alpine village, timber-framed houses, an onion-dome church and wildflower meadows",
  "a Provençal farming village in summer, a stone town, lavender rows and plane trees, cicada heat",
  "a New England coastal village in autumn, clapboard houses, a white steeple and a harbour of small boats",
  "an old Silk Road oasis town at sunset, mud-brick houses, a bustling little bazaar and camels resting",
] as const;

// ── Scene suggester (cheap; optional hint) ──────────────────────────────────
export const LostSuggestRequestSchema = z.object({
  /** Optional steer, e.g. "coastal", "past", "snow", "off-grid modern". */
  hint: z.string().max(200).optional(),
});
export const LostSuggestResponseSchema = z.object({ scenes: z.array(z.string()) });

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

/** REFINE: keep the current still, add a small detail (image-to-image). Reuses
 *  the preview response/status shapes (returns a new stillKey + url). */
export const LostRefineRequestSchema = z.object({
  stillKey: z.string().min(1),
  stillPrompt: z.string().max(4000),
  adjustment: z.string().min(1).max(600),
});
export type LostRefineRequest = z.infer<typeof LostRefineRequestSchema>;

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
