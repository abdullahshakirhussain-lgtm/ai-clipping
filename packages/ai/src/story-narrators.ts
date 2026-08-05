/**
 * Narrator personas for Story Studio. The base instruction sets the voice's
 * character; each beat's own `delivery` (written by the LLM) is appended so the
 * read rises and falls with the story instead of droning — the fix for the flat
 * read. (Formerly fed to OpenAI TTS as `instructions`; that provider is gone.)
 */
export const STORY_NARRATORS: Record<string, string> = {
  storyteller:
    "Voice: a captivating storyteller telling a gripping tale to a friend. Warm, expressive, wide pitch range. Lean into suspense, slow down for the reveal, speed up when the action rises. Never monotone — every sentence has a shape.",
  hyped:
    "Voice: high-energy, fast, hyped — like a creator who can't believe what they're telling you. Big dynamic swings, punchy emphasis, breathless excitement building to the payoff.",
  "deadpan-documentary":
    "Voice: dry, composed documentary narrator — measured and authoritative, but with subtle irony. Let the wild facts land with a raised eyebrow, not a shout. Deliberate pacing, weighty pauses.",
  conspiratorial:
    "Voice: hushed and conspiratorial, like you're leaning in to share a secret. Intimate, low, building intrigue, dropping to a near-whisper on the shocking parts, then a sly lift on the twist.",
};

export const DEFAULT_NARRATOR = "storyteller";

/** Base voice instruction for a narrator persona (falls back to the default). */
export function narratorBase(narrator: string): string {
  return STORY_NARRATORS[narrator] ?? STORY_NARRATORS[DEFAULT_NARRATOR]!;
}

/** Compose the TTS instructions for one beat: persona character + this beat's read. */
export function narratorInstruction(narrator: string, delivery?: string): string {
  const base = narratorBase(narrator);
  return delivery?.trim() ? `${base}\nThis line: ${delivery.trim()}` : base;
}
