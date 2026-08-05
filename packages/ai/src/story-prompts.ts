/**
 * Shared prompt builders for the CHEAP text tasks (topic suggestions + the
 * dedicated image-prompt pass). Kept provider-neutral so the Anthropic fallback
 * and the DeepSeek provider send byte-identical instructions and never drift.
 */
import type { RefineImagePromptsInput, SuggestTopicsInput } from "./types.js";

const ERAS = [
  "the Stone Age", "ancient Egypt", "ancient Rome", "ancient Greece", "the Viking age",
  "medieval Europe", "feudal Japan", "the Aztec empire", "the Ottoman empire", "Qing-dynasty China",
  "the Victorian era", "the American frontier (1800s)", "the age of sail", "WWII on the home front", "ancient Mesopotamia",
];
const ASPECTS = [
  "food and eating", "medicine and getting sick", "hygiene and the toilet", "death and burial", "war and battle",
  "love, sex and marriage", "money and trade", "crime and punishment", "work and a typical day", "childhood and school",
  "travel and navigation", "law and justice", "entertainment and games", "religion and the afterlife", "disease and plague",
];
const pick = <T>(a: T[], n: number) => [...a].sort(() => Math.random() - 0.5).slice(0, n);

/** The topic-suggester instruction: mainstream-mixed, plainly worded scenario ideas. */
export function buildTopicsInstruction(input: SuggestTopicsInput): string {
  const seedEras = pick(ERAS, 4).join(", ");
  const seedAspects = pick(ASPECTS, 5).join(", ");
  const avoidBlock = input.avoid?.length
    ? `\n\nDo NOT repeat or lightly reword any of these already-used ideas — go to a different era/aspect entirely:\n${input.avoid.map((t) => `- ${t}`).join("\n")}`
    : "";
  return `Propose ${input.count} SCENARIO ideas for immersive, second-person history explainer videos${
    input.category ? ` for a "${input.category}" channel` : ""
  } — the kind that opens "Imagine you're a…" and reveals how something in the past actually was.

Each idea pairs an ERA with an ASPECT OF LIFE, framed as a simple curiosity. Good shapes: "A day in the life of [person in an era]", "What happened if you [did X] in [era]", "How people [did X] before [Y]", "What [aspect] was actually like in [era]".

MIX MAINSTREAM WITH NICHE: about HALF the ideas should be broadly interesting to anyone — familiar, "everyone wonders about this" topics (what a school day was like long ago, how people kept food from spoiling, how they told the time, what happened when you got a toothache) — and about half can be more niche/surprising. Do NOT make them all obscure; a wall of ultra-niche ideas is a fail.

PLAIN WORDING — the idea itself must be in everyday language a normal person instantly gets. NO historical jargon or specialist terms in the idea ("What Florentine sumptuary law forbade" is bad; "What you were and weren't allowed to wear" is good). If someone would need to look up a word in the idea, reword it.

For variety THIS time, lean on these eras — ${seedEras} — and these aspects — ${seedAspects} — but you may mix in others. Each idea 6-12 words, concrete and specific, no numbering.${avoidBlock}`;
}

/**
 * The dedicated image-prompt pass: turn the FINISHED narration into one tight,
 * accurate image prompt per beat. This is where "tighter + more consistent"
 * comes from — each prompt draws exactly what its line describes, on-topic for
 * the setting, and any recurring character is kept visually identical across all
 * beats. Art-style wording is deliberately omitted (the pipeline appends the
 * locked style anchor afterwards), so this focuses purely on SUBJECT + SCENE.
 */
export function buildImagePromptsInstruction(input: RefineImagePromptsInput): string {
  const lines = input.beats.map((b, i) => `${i + 1}. ${b.text.replace(/\[[^\]]*\]/g, "").trim()}`).join("\n");
  return `You are writing image prompts for a stick-figure history explainer about "${input.topic}". You are given the finished narration, one line per beat. Write EXACTLY ${input.beats.length} image prompts, one per beat, in order.

VISUAL WORLD (keep every frame in it): ${input.setting || "(derive a concrete, period-correct world from the lines)"}

RULES:
- DRAW WHAT THE LINE SAYS. Each prompt is the concrete thing that line describes — the specific place, object, structure or action (a brick oven with round loaves; a stone well with a wooden bucket; a market stall with brass scales). Do NOT default to a figure standing in a vague background while the interesting thing goes undrawn.
- FOLLOW THE NARRATION'S FLOW. The lines are in order and usually walk one person through a day — so the prompts must PROGRESS with them: read prompt N as the moment right after prompt N-1, in the same continuous place and story, never a random reshuffle. If the narration moves through the day, move the LIGHT with it (pre-dawn dark → morning → midday sun → dusk → night by candle) and the LOCATION with it, so the frames play as one continuous day, not disconnected cards.
- ACCURATE + ON-TOPIC. Use the period-correct materials, structures and objects for this exact era — no anachronisms. Someone who knows the period shouldn't be able to nitpick it.
- CONSISTENT CHARACTER. If a recurring person appears, describe them the SAME way in every prompt they're in (establish one short look — e.g. "a stick figure with short black hair" — and reuse it word-for-word). Not every beat needs the person; establishing/scene beats can have no one.
- Do NOT describe art style, colours, or medium (that is added automatically). Just the subject and scene.
- One single scene per prompt, no text/letters/labels in the image, 15-40 words each.

Give EXACTLY ${input.beats.length} prompts, one per beat, in beat order.

NARRATION:
${lines}`;
}
