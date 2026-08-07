/**
 * Shared prompt builders for the CHEAP text tasks (topic suggestions + the
 * dedicated image-prompt pass). Kept provider-neutral so the Anthropic fallback
 * and the DeepSeek provider send byte-identical instructions and never drift.
 */
import type { ExpandImagePromptsInput, RefineImagePromptsInput, SuggestTopicsInput } from "./types.js";

const ERAS = [
  "the Stone Age", "ancient Egypt", "ancient Rome", "ancient Greece", "the Viking age",
  "medieval Europe", "feudal Japan", "the Aztec empire", "the Ottoman empire", "Qing-dynasty China",
  "the Victorian era", "the American frontier (1800s)", "the age of sail", "WWII on the home front", "ancient Mesopotamia",
];
// Wholesome, peaceful slices of daily life — the point is to make the past look
// calm and inviting, so the grim aspects (death, plague, war, crime, sickness)
// are deliberately left out.
const ASPECTS = [
  "food and feasts", "a market day", "crafts and trades", "family and home life", "festivals and holidays",
  "music and dancing", "work and a typical day", "childhood and play", "farming and the seasons", "cooking at the hearth",
  "friendship and neighbours", "games and pastimes", "keeping warm and cosy", "courtship and marriage", "a day by the river",
];
const pick = <T>(a: T[], n: number) => [...a].sort(() => Math.random() - 0.5).slice(0, n);

/** The topic-suggester instruction: mainstream-mixed, plainly worded scenario ideas. */
export function buildTopicsInstruction(input: SuggestTopicsInput): string {
  const avoidBlock = input.avoid?.length
    ? `\n\nDo NOT repeat or lightly reword any of these already-used ideas — go somewhere clearly different:\n${input.avoid.map((t) => `- ${t}`).join("\n")}`
    : "";
  const focus = input.category?.trim();

  // A typed niche/category is the WHOLE point of the field — honour it as the
  // FIXED SUBJECT so ideas change with what the user typed. (The old prompt only
  // pinned random historical eras, so the input was effectively ignored.)
  if (focus) {
    return `Propose ${input.count} immersive, second-person short-video story ideas that are ALL specifically about: "${focus}".

"${focus}" is the FIXED SUBJECT the user asked for — it may be an era, a place, a job, a person, or a theme (e.g. space, sports scandals, cursed history). EVERY single idea must be unmistakably about "${focus}". Do NOT drift to unrelated eras or subjects, and do NOT fall back to generic "life in the past" ideas unless "${focus}" itself is that. Someone who typed "${focus}" should read all ${input.count} ideas and think "yes — these are exactly what I asked for".

Make the ${input.count} ideas DISTINCT from one another by taking different angles, moments or sub-topics WITHIN "${focus}" (a typical day, one specific event, the danger, the money, the people, the strangest detail) — never the same idea reworded.

Frame each as a simple curiosity: "A day in the life of …", "What … was actually like", "How people/they … ", "What happened when …". PLAIN WORDING — everyday language a normal person instantly gets; no jargon or specialist terms (if someone would need to look a word up, reword it). Each idea 6-12 words, concrete and specific, no numbering.${avoidBlock}`;
  }

  // No subject typed → spread across random eras/aspects for a "surprise me" mix.
  const seedEras = pick(ERAS, 4).join(", ");
  const seedAspects = pick(ASPECTS, 5).join(", ");
  return `Propose ${input.count} SCENARIO ideas for immersive, second-person history explainer videos — the kind that opens "Imagine you're a…" and reveals how something in the past actually was.

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
- FOLLOW THE NARRATION'S FLOW, AND VARY THE SCENE. The lines are in order and usually walk one man through a day — so the prompts must PROGRESS with them: read prompt N as the moment right after prompt N-1, in the same continuous story, never a random reshuffle. Shift the TIME OF DAY with the narration (pre-dawn → morning → midday → dusk → night) AND move through DIFFERENT, richly-coloured SETTINGS across the day (warm home interior, sunlit lane, green fields, a lively market, a workshop, the riverside) so the backgrounds stay varied and lively — never the same drab room repeated. Keep every frame WARMLY LIT and bright with colour (soft dawn glow, golden sun, warm firelight, warm moonlit night), never black, grey or gloomy.
- ACCURATE + ON-TOPIC. Use the period-correct materials, structures and objects for this exact era — no anachronisms. Someone who knows the period shouldn't be able to nitpick it.
- CONSISTENT CHARACTER, HAPPY BY DEFAULT. If a recurring person appears, describe him the SAME way in every prompt he's in (establish one short look — e.g. "a stick figure with short brown hair" — and reuse it word-for-word), and give him a warm, content SMILE by default (only another expression when the beat clearly calls for it). Not every beat needs the person; establishing/scene beats can have no one.
- Do NOT describe art style, colours, or medium (that is added automatically). Just the subject and scene.
- One single scene per prompt, no text/letters/labels in the image, 15-40 words each.

Give EXACTLY ${input.beats.length} prompts, one per beat, in beat order.

NARRATION:
${lines}`;
}

/**
 * Shared instruction for the SPLIT pass: fan each long beat into N DISTINCT shot
 * prompts. Provider-neutral so DeepSeek (the budget model that runs this at scale)
 * and the Anthropic fallback send identical rules; each provider appends its own
 * output directive (tool call vs JSON). This is the biggest per-video image-prompt
 * workload (44 beats × 3 ≈ 132 shots), so it belongs on the cheap model.
 */
export function buildExpandFramesInstruction(input: ExpandImagePromptsInput): string {
  const listing = input.beats
    .map((b, i) => `${i + 1}. NARRATION: "${b.text}"\n   BASE IMAGE: ${b.imagePrompt}\n   SPLIT INTO: ${b.count} frames`)
    .join("\n");
  const count = input.beats[0]?.count ?? 3;
  return `Each beat below stays on screen too long for a single picture. Cut it into the requested number of DISTINCT SHOTS — the way a video editor covers one moment from different angles — so the screen keeps changing and never looks like the same picture nudged.

WORLD (every shot lives here): ${input.setting || "unspecified"}

${listing}

Rules:
- ONE SINGLE MOMENT PER PROMPT. Each prompt is ONE instant seen by ONE camera — never two things at once, never a sequence. NO collages, NO split screens, NO side-by-side or before/after panels, NO grids or multi-panel layouts, and no "then"/"and then"/"as well as" describing a second scene. One place, one instant, one composition. (This is the collage bug — kill it here.)
- THE ${count} SHOTS MUST LOOK CLEARLY DIFFERENT, or they render as the same picture and get dropped as duplicates. Change the CAMERA between them, not the caption: a WIDE establishing view of the whole place → a CLOSER angle on the key structure/object/action → a tight DETAIL of the single most important element. Different distance AND angle each time. If two of your prompts could produce near-identical images, rewrite one.
- Every shot depicts the SPECIFIC thing this beat's narration describes, rendered with its stated details (if the line says "fifty doors", draw fifty; if it says "shields locked", lock them). The base prompt names that subject — keep it central. Only make one a close-up on a character's face when the beat is actually ABOUT a person reacting — for scene/place/object beats, keep the described thing on screen, not a random figure.
- Stay true to the beat; do NOT invent new events the narration doesn't mention, and never jump ahead to a later beat.
- Each prompt stands alone (the image model sees only that one line) and must carry the world's concrete markers so the shots clearly belong to the same scene; when a face is shown, give it a warm, content SMILE by default (only another expression when the beat clearly calls for it).
- Keep every subject centered and simply drawn; no on-screen text.
- Return exactly the requested number of prompts per beat, in the same beat order.`;
}

/** Align a raw per-beat prompt list back to the requested counts (pad/trim), so
 *  the slide list never desyncs from the timing plan. Shared by both providers. */
export function alignExpandedFrames(
  input: ExpandImagePromptsInput,
  rawBeats: Array<{ prompts?: unknown }>,
): string[][] {
  return input.beats.map((b, i) => {
    const got = (Array.isArray(rawBeats[i]?.prompts) ? (rawBeats[i]!.prompts as unknown[]) : [])
      .map((p) => String(p ?? "").trim())
      .filter(Boolean);
    const out: string[] = [];
    for (let k = 0; k < b.count; k++) out.push(got[k] ?? got[got.length - 1] ?? b.imagePrompt);
    return out;
  });
}
