import { z } from "zod";

// Story visual styles. "stick-openai" = the working OpenAI stick-figure +
// colourful scene (default). "stick-fal" = the experimental fal composite path.
// "hero-painterly" = the HERO channel: a named human protagonist in soft painterly
// storybook art, rendered by a trained fal character LoRA so he's identical every
// video (inert → falls back to stick-openai until HERO_LORA_URL is configured).
export const STORY_STYLES = ["stick-openai", "stick-fal", "hero-painterly"] as const;
export const STORY_NARRATOR_KEYS = ["storyteller", "hyped", "deadpan-documentary", "conspiratorial"] as const;
export const CAPTION_STYLE_KEYS = ["bold-center", "yellow-pop", "clean-bottom"] as const;
export const CAPTION_POSITIONS = ["top", "middle", "bottom"] as const;
export const MUSIC_MOODS = ["none", "calm", "tense", "upbeat", "epic"] as const;

/**
 * Long-form (16:9, ~8 min) vs short (9:16, ~70-90s). This is the ONE knob that
 * drives everything downstream — aspect ratio, beat count and narration length
 * are all derived from it in the service (see story-service.ts), because a
 * long-form YouTube explainer and a vertical Short are different shapes, not just
 * different durations.
 */
export const STORY_LENGTHS = ["long", "short"] as const;

/**
 * `scenario` (default) is the reference-channel format: an immersive, second-
 * person "Imagine you're a…" walk through how something actually was (a day in
 * the life, what happened if you got sick, how they did X without Y). It doesn't
 * need a dramatic twist — just escalating, surprising, concrete detail. The
 * scenario SPACE is enormous (era × aspect-of-life × frame), which is what keeps
 * ideas from repeating. `story` keeps the older dramatic-true-story mode (a
 * specific event with a hook and a turn) as an option.
 */
export const STORY_MODES = ["scenario", "story"] as const;

/**
 * Create a generated story video. `length` picks the shape (long 16:9 vs short
 * 9:16); the AI then writes the most complete, interesting story it can within
 * that shape's word band.
 */
export const CreateStoryInputSchema = z.object({
  topic: z.string().min(3).max(300),
  /** Optional free-text direction from the user — what to mention, what to avoid,
   *  the angle/tone to take. Woven into the writer's prompt as extra instruction. */
  direction: z.string().max(600).optional(),
  mode: z.enum(STORY_MODES).default("scenario"),
  // Short form (9:16) is the default — that's what we publish. A story may still
  // run a bit past 2 min when that's what a complete telling needs.
  length: z.enum(STORY_LENGTHS).default("short"),
  style: z.enum(STORY_STYLES).default("stick-openai"),
  narrator: z.enum(STORY_NARRATOR_KEYS).default("storyteller"),
  category: z.string().max(60).optional(),
  // Default caption look: clean, at the bottom. Voice is always ElevenLabs
  // (premium) now — no tier to pick — and there is no background music.
  captionStyle: z.enum(CAPTION_STYLE_KEYS).default("clean-bottom"),
  captionPosition: z.enum(CAPTION_POSITIONS).default("bottom"),
});
export type CreateStoryInput = z.infer<typeof CreateStoryInputSchema>;

export const SuggestTopicsQuerySchema = z.object({
  category: z.string().max(60).optional(),
});

export const SuggestTopicsResponseSchema = z.object({ topics: z.array(z.string()) });
