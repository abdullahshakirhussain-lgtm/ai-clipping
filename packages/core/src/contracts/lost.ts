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
  "a cosy self-sufficient mountain village at golden hour, smoke from the chimneys, people tending their gardens",
  "a warm evening on a valley homestead, lantern light, a family sharing a meal at an outdoor table",
  "a peaceful riverside village, wooden houses, people fishing and washing by the water, children playing",
  "an off-grid forest homestead at dawn, chickens in the yard, a vegetable patch, someone carrying firewood",
  "terraced rice fields around a small village in soft morning mist, farmers wading the paddies",
  "a snowy alpine hamlet at dusk, warm glowing windows, someone clearing a path, woodsmoke in the air",
  "a coastal fishing village at sunrise, boats coming in, nets drying, the little market opening",
  "a desert oasis town in the evening, date palms, people drawing water from the well, warm lamplight",
  "a highland shepherd's hamlet, stone cottages, flocks coming home at sunset, a shared fire",
  "a cottage with a garden in full bloom in early summer, washing on the line, bees, a cat asleep on the step",
  "a lakeside cabin community in autumn, canoes on still water, someone splitting wood, orange leaves",
  "an old-town bakery street at dawn, warm bread in the window, cobblestones, the first customers",
  "a self-sufficient island village, terraced gardens, goats, fishing boats, a windmill turning",
  "a prairie homestead at golden hour, a windmill, horses grazing, someone resting on the porch",
  "a canal village, little boats, flower boxes on the bridges, neighbours chatting from doorways",
  "a hillside vineyard village at harvest, baskets of grapes, long tables set outside, warm light",
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
