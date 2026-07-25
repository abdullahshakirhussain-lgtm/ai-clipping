import { z } from "zod";

/**
 * One voice in the call. The planner fills all of this from a one-line idea and
 * the user edits any of it before anything is sent — gender, accent and voice
 * are the fields that decide whether two synthetic speakers read as two people.
 */
export const CallCharacterSchema = z.object({
  name: z.string().min(1).max(40),
  role: z.string().max(200),
  gender: z.enum(["male", "female"]),
  age: z.string().max(60),
  accent: z.string().max(600),
  /** Gemini prebuilt voice id (see GEMINI_VOICES in @clipfactory/ai). */
  voice: z.string().max(40),
  personality: z.string().max(400),
  agenda: z.string().max(400),
  quirks: z.string().max(400),
});
export type CallCharacterDto = z.infer<typeof CallCharacterSchema>;

/** The editable brief fields, without the assembled prompt. */
export const CallSpecSchema = z.object({
  title: z.string().max(200),
  description: z.string().max(2000),
  hashtags: z.array(z.string()).max(10),
  premise: z.string().max(600),
  setup: z.string().max(1200),
  characters: z.array(CallCharacterSchema).min(2).max(2),
  escalation: z.array(z.string().max(400)).min(1).max(8),
  ragebait: z.array(z.string().max(400)).max(8),
  ending: z.string().max(600),
  durationSeconds: z.number().min(20).max(90),
  direction: z.string().max(1200),
  imagePrompts: z.array(z.string().max(600)).max(6),
});
export type CallSpecDto = z.infer<typeof CallSpecSchema>;

/**
 * Step 1 — plan: one line in ("rage bait a scammer"), a full editable brief out.
 * Cheap text only. `brief` is the exact prompt the audio model will receive,
 * assembled from the fields, so the user reviews what actually gets sent.
 */
export const CallPlanRequestSchema = z.object({ idea: z.string().min(3).max(300) });
export type CallPlanRequest = z.infer<typeof CallPlanRequestSchema>;

export const CallPlanSchema = CallSpecSchema.extend({ brief: z.string() });
export type CallPlanDto = z.infer<typeof CallPlanSchema>;

/** Step 1b — re-assemble the brief after the user edits the fields. No spend. */
export const CallBriefRequestSchema = CallSpecSchema;
export const CallBriefSchema = z.object({ brief: z.string() });

/**
 * Step 2 — generate: the brief the user approved is sent VERBATIM; the audio
 * model improvises the dialogue from it. Nothing is re-planned in the job.
 */
export const CreateCallInputSchema = CallSpecSchema.extend({
  brief: z.string().min(20).max(20000),
  category: z.string().max(60).optional(),
  captionStyle: z.string().max(40).optional(),
  captionPosition: z.enum(["top", "middle", "bottom"]).optional(),
});
export type CreateCallInput = z.infer<typeof CreateCallInputSchema>;
