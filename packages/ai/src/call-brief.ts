import type { CallPlan } from "./types.js";

export interface GeminiVoice {
  name: string;
  /** Google's own one-word character for the voice. */
  tone: string;
  /**
   * Perceived gender. Google does NOT publish a gender label for these voices —
   * this is an approximation from how they read, used only to help the planner
   * pick a plausible voice for a character. The user can swap any voice in the
   * review step, which is the real fix when one sounds wrong.
   */
  gender: "male" | "female";
}

/** The 30 prebuilt Gemini TTS voices (same set for single- and multi-speaker). */
export const GEMINI_VOICES: GeminiVoice[] = [
  { name: "Zephyr", tone: "bright", gender: "female" },
  { name: "Puck", tone: "upbeat", gender: "male" },
  { name: "Charon", tone: "informative", gender: "male" },
  { name: "Kore", tone: "firm", gender: "female" },
  { name: "Fenrir", tone: "excitable", gender: "male" },
  { name: "Leda", tone: "youthful", gender: "female" },
  { name: "Orus", tone: "firm", gender: "male" },
  { name: "Aoede", tone: "breezy", gender: "female" },
  { name: "Callirrhoe", tone: "easy-going", gender: "female" },
  { name: "Autonoe", tone: "bright", gender: "female" },
  { name: "Enceladus", tone: "breathy", gender: "male" },
  { name: "Iapetus", tone: "clear", gender: "male" },
  { name: "Umbriel", tone: "easy-going", gender: "male" },
  { name: "Algieba", tone: "smooth", gender: "male" },
  { name: "Despina", tone: "smooth", gender: "female" },
  { name: "Erinome", tone: "clear", gender: "female" },
  { name: "Algenib", tone: "gravelly", gender: "male" },
  { name: "Rasalgethi", tone: "informative", gender: "male" },
  { name: "Laomedeia", tone: "upbeat", gender: "female" },
  { name: "Achernar", tone: "soft", gender: "female" },
  { name: "Alnilam", tone: "firm", gender: "male" },
  { name: "Schedar", tone: "even", gender: "male" },
  { name: "Gacrux", tone: "mature", gender: "female" },
  { name: "Pulcherrima", tone: "forward", gender: "female" },
  { name: "Achird", tone: "friendly", gender: "male" },
  { name: "Zubenelgenubi", tone: "casual", gender: "male" },
  { name: "Vindemiatrix", tone: "gentle", gender: "female" },
  { name: "Sadachbia", tone: "lively", gender: "female" },
  { name: "Sadaltager", tone: "knowledgeable", gender: "male" },
  { name: "Sulafat", tone: "warm", gender: "female" },
];

const VOICE_NAMES = new Set(GEMINI_VOICES.map((v) => v.name));

/** Compact catalogue for the planner prompt so it picks a real voice id. */
export function voiceCatalogue(): string {
  return GEMINI_VOICES.map((v) => `${v.name} (${v.gender}, ${v.tone})`).join("; ");
}

/**
 * Coerce whatever the planner returned to a real voice id. A hallucinated name
 * would 400 the TTS call, so fall back to a same-gender voice by position.
 */
export function resolveVoice(name: string | undefined, gender: "male" | "female", index = 0): string {
  const wanted = String(name ?? "").trim();
  if (VOICE_NAMES.has(wanted)) return wanted;
  const pool = GEMINI_VOICES.filter((v) => v.gender === gender);
  return (pool[index % pool.length] ?? GEMINI_VOICES[0]!).name;
}

/**
 * Assemble the director's BRIEF from the plan — in code, so the string the user
 * previews is byte-identical to the one that reaches the API (same reason the
 * cook style bible is assembled here rather than asked for verbatim). The brief
 * describes the call; it deliberately contains no dialogue, because the audio
 * model improvises far more naturally than a written script performs.
 */
export function buildCallBrief(plan: CallPlan): string {
  const cast = plan.characters
    .map((c, i) => {
      const bits = [
        `SPEAKER ${i + 1} — ${c.name} (${c.role})`,
        `  voice: ${c.voice} · ${c.gender} · ${c.age}`,
        `  accent & delivery: ${c.accent}`,
        `  personality: ${c.personality}`,
        `  wants: ${c.agenda}`,
        `  speech habits: ${c.quirks}`,
      ];
      return bits.join("\n");
    })
    .join("\n\n");

  const numbered = (items: string[]) => items.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const bulleted = (items: string[]) => items.map((s) => `- ${s}`).join("\n");

  return [
    `FORMAT: a recorded phone call, roughly ${plan.durationSeconds} seconds, exactly two speakers, no narrator, no music, no intro or outro — the recording starts mid-situation.`,
    ``,
    `PREMISE: ${plan.premise}`,
    `SETUP: ${plan.setup}`,
    ``,
    `CAST`,
    cast,
    ``,
    `HOW IT ESCALATES (beats, not lines — the speakers improvise the words)`,
    numbered(plan.escalation),
    ``,
    `THE DETAILS THAT MAKE PEOPLE COMMENT (work these in naturally, don't announce them)`,
    bulleted(plan.ragebait),
    ``,
    `ENDING: ${plan.ending}`,
    ``,
    `DIRECTION: ${plan.direction}`,
    ``,
    `HARD RULES`,
    `- Everyone in this call is FICTIONAL. No real people, no real companies, banks, agencies or brands, no real phone numbers, addresses or account numbers.`,
    `- It must sound like a real call, not a sketch: interruptions, talking over each other, "hello? hello?", sighs, dead air, repeated questions.`,
    `- Never narrate, never explain the joke, never break character, no laugh track, no sound effects.`,
    `- No slurs, no threats of real violence, nothing sexual, no targeting of a real identifiable person.`,
    `- Cut on the peak. Do not resolve it politely and do not end with a quip.`,
  ].join("\n");
}
