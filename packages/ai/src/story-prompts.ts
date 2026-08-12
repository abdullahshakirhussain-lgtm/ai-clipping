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
  "music and dancing", "work and a typical day", "childhood and play", "farming and the seasons", "cooking over the fire",
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
  const isFpv = input.style === "anime-fpv";

  // The FPV channel is shot FIRST-PERSON: the camera is the viewer's own eyes, so
  // the "figure/pose" and "consistent character" rules are replaced with POV rules
  // (your own hands do the action; never your face). Everything else — flow,
  // accuracy, detailed background, one scene — is shared.
  const intro = isFpv
    ? `You are writing FIRST-PERSON POV image prompts for a detailed anime day-in-the-life video about "${input.topic}". The camera is the viewer's OWN eyes ("you"). You are given the finished narration, one line per beat. Write EXACTLY ${input.beats.length} image prompts, one per beat, in order.`
    : `You are writing image prompts for a stick-figure day-in-the-life explainer about "${input.topic}". You are given the finished narration, one line per beat. Write EXACTLY ${input.beats.length} image prompts, one per beat, in order.`;

  const drawRule = isFpv
    ? `- DRAW WHAT THE LINE SAYS, FROM YOUR OWN EYES. Each prompt is the concrete thing that line describes as YOU would see it — the brick oven right in front of you, the well as you look down into it, the market stall across the counter. The interesting thing is always in view; do NOT waste the frame on nothing.`
    : `- DRAW WHAT THE LINE SAYS. Each prompt is the concrete thing that line describes — the specific place, object, structure or action (a brick oven with round loaves; a stone well with a wooden bucket; a market stall with brass scales). Do NOT default to a figure standing in a vague background while the interesting thing goes undrawn.`;

  const bodyRule = isFpv
    ? `- FIRST-PERSON POV, ALWAYS. Every prompt is what YOU see from inside your own body — the world directly ahead, and your OWN hands/arms/legs entering the frame when you act: "pov, your own hands kneading dough on the floured board, the warm kitchen ahead", "looking down the lane, your feet on the dirt path", "pov looking up at the wooden ceiling from your pillow as you wake", "pov, your eyelids closing, the dim room going dark". NEVER draw a separate person standing in the scene, and NEVER show your own face (no front view, no mirror, no reflection). Match your hands/body to the ACTION in the line (kneading, carrying, reaching, lying still) — do not default to empty hands. An occasional over-the-shoulder view of your own back (head from behind only) is fine for variety, never a face.`
    : `- STATE THE POSE / ACTION. Whenever the person is in the shot, say plainly what he is DOING and his body pose — "lying in bed asleep with his eyes closed", "sitting cross-legged by the fire", "kneeling to plant seeds", "walking down the lane with a basket", "reaching up to a high shelf", "leaning on the fence talking". The pose matters as much as the place: NEVER write him standing when the line has him lying down, sitting, kneeling, sleeping or otherwise — read the line and match his body to it. "Lying down to sleep" must show him lying down, not standing.`;

  const bgRule = isFpv
    ? `- INSANELY DETAILED BACKGROUND — this is the whole point. Since no character fills the frame, the WORLD is the subject: pack every prompt with specific, layered detail — the named place plus its smaller props, textures, plants, furnishings and surroundings, with real depth (foreground, middle, distance). Full, lived-in, interesting; never a bare or empty backdrop.`
    : `- RICH, DETAILED BACKGROUND — the figures stay simple, the WORLD does not. Fill the scene behind and around the stick figure with specific, layered detail: the named place plus its smaller props, textures, plants, furnishings and surroundings, and a sense of depth (foreground, middle, distance). The stick figure itself is always a plain simple doodle — never add detail to the FIGURE — but the background should look full, lived-in and interesting, never a bare or empty backdrop.`;

  const consistencyRule = isFpv
    ? `- CONSISTENT "YOU". When your hands, arms or clothing show, keep them the SAME each time (ordinary young man's hands, plain simple clothes) — but they are only glimpses at the edge of the frame; the DETAILED WORLD ahead is the subject, not your body. Plenty of beats show no body at all, just what you're looking at.`
    : `- CONSISTENT CHARACTER, HAPPY BY DEFAULT. If a recurring person appears, describe him the SAME way in every prompt he's in (establish one short look — e.g. "a stick figure with short brown hair" — and reuse it word-for-word), and give him a warm, content SMILE by default (only another expression when the beat clearly calls for it). Not every beat needs the person; establishing/scene beats can have no one.`;

  return `${intro}

VISUAL WORLD (keep every frame in it): ${input.setting || "(derive a concrete world true to the topic — its own time and place, historical or modern — from the lines)"}

RULES:
${drawRule}
${bodyRule}
- FOLLOW THE NARRATION'S FLOW, AND VARY THE SCENE. The lines are in order and usually walk one man through a day — so the prompts must PROGRESS with them: read prompt N as the moment right after prompt N-1, in the same continuous story, never a random reshuffle. Move through DIFFERENT, richly-coloured SETTINGS across the day (warm home interior, sunlit lane, green fields, a lively market, a workshop, the riverside) so the backgrounds stay varied and lively — never the same drab room repeated. Keep every frame full of clear, varied colour (fresh greens, sky blues, clean reds — not just warm tones), lit naturally for the time of day, and never a flat yellow/amber/sepia wash over the whole picture.
- SPACE & PLACE — MAP THE WORLD, keep it consistent. Before writing, lay out the story's SPACE as a simple mental map: the handful of distinct locations it uses (e.g. the bedroom, the kitchen/hearth, the yard, the lane, the market, the workshop, the river) and, for EACH, whether it is INSIDE (a room with walls, a ceiling, a window) or OUTSIDE (open sky and ground). Then place EVERY beat in its correct location and START the prompt with the word INTERIOR or EXTERIOR and the place — e.g. "Interior, inside the bedroom: …" or "Exterior, out on the lane: …". Match the narration exactly: waking up and going to bed are INTERIOR bedroom scenes (the bed is INDOORS, never out in a field), lighting the fire / cooking / eating is INTERIOR at the hearth or table, walking to market or working the field is EXTERIOR. For an INTERIOR, render a FULLY ENCLOSED room seen from inside — walls filling the frame, a ceiling overhead, a floor and furniture — so it is unmistakably indoors and cannot be read as outside. The image model has NO negative prompt, so you must state the enclosure POSITIVELY ("indoors, an enclosed room, walls and a ceiling around the bed") rather than just "not outside" — "not outside" does nothing. An EXTERIOR shows open sky and ground. When a place reappears later, draw it the SAME way (the same bedroom, the same kitchen) so the world stays mappable and the viewer always knows where they are. Keep each place's FIXED FIXTURES anchored in the SAME spot every time — the bed stays against its wall, the fireplace/hearth stays in its corner, the table, window and door don't move. Furniture and fittings are fixed points, not rearranged from beat to beat.
- TIME-OF-DAY & WEATHER CONTINUITY — a HARD rule; without it the lighting flickers at random between frames. First read the WHOLE narration and fix ONE consistent timeline: (a) a DAY-CLOCK that only ever moves FORWARD — pre-dawn → dawn → morning → midday → afternoon → evening → dusk → night — and never jumps back to daylight once it's dark WITHIN a day; the ONLY time daylight returns is a genuine NEW DAY (he sleeps, then wakes the next morning — some stories span several days), which restarts the clock at that new morning and moves forward again. The frames must march through each day in that order, not bounce around; and (b) the WEATHER, which stays the SAME from one beat to the next and only changes when a line explicitly changes it (it starts to rain, the clouds break, snow begins, fog lifts). Weather EFFECTS persist realistically — after rain the ground stays wet and puddled a while before it dries, snow lingers on roofs and fields, mud stays muddy; it doesn't snap back to bone-dry the next frame. Then write an explicit TIME-OF-DAY + LIGHT + WEATHER phrase into EVERY prompt — e.g. "early morning, soft clear light", "grey afternoon, steady drizzle", "warm sunset light", "night, dark outside, warm lamp light" — so no frame is left for the model to light at random. If the narration NAMES a time (dawn, noon, dusk, midnight) or weather (rain, snow, wind, fog, storm, hot sun, clear sky), the image MUST match it exactly. Indoor beats still keep the OUTSIDE time/weather consistent (through windows/doorways), so the day reads as continuous whether we're inside or out.
- OUTFIT — ONE LOOK PER DAY, held consistently. Within a single day the protagonist wears the SAME clothes in EVERY frame: fix his day-outfit (take it from the visual world above, or set one plain outfit at that day's first beat) and repeat it word-for-word in every prompt of that day — same garments, same colours. Do NOT recolour or restyle his clothes frame to frame within a day; that flicker is the single biggest giveaway. He changes clothes ONLY when the story clearly calls for it, and then KEEPS the new state until the next clear change: a hooded cloak/coat when it starts to rain (worn while it rains), nightclothes once he's in bed, an apron for messy work. IMPORTANT — some stories span MULTIPLE DAYS: when the narration moves into a NEW DAY (he wakes to a new morning, "the next day"), he may wear a FRESH outfit for that day, then hold it consistently all through that day. So: the same outfit through one whole day, a new outfit only at a genuine new day or an explicit change. (For first-person POV, the same applies to your own visible sleeves/coat/hands.)
- SEASON, CARRIED THINGS & OTHER PEOPLE — lock these too, they wander otherwise. SEASON: the time of year (green summer leaves, autumn colour, bare winter branches, snow, the state of the crops) is FIXED for the whole story — every frame shows the same season, shifting only if the story explicitly spans months. CARRIED ITEMS: anything the man is holding or using (a basket, a tool, a lantern, a loaf) stays with him and looks the same across the beats it belongs to, and is gone once he sets it down — it does not pop in and out between frames. OTHER PEOPLE: any recurring person (a neighbour, the miller, his child) keeps the SAME face, hair and clothes every time they appear — establish their look once and reuse it word-for-word, exactly like the protagonist; one-off passers-by stay generic.
- LEAD WITH THE LOCKED STATE — this is what stops the flicker that destroys the feel. The image model renders each frame on its own and has NO negative prompt, so START every prompt with the beat's fixed state, concrete and POSITIVE: the LOCATION + interior/exterior, the TIME OF DAY + light, the WEATHER, and the OUTFIT — e.g. "Interior, inside the bedroom, early morning, soft clear light, in his plain brown coat: <the action/scene>". Then the specific action follows. Keep that opening state clause IDENTICAL from frame to frame; change a value ONLY when the story changes it (a new place, the clock moving on, rain starting, a new day's outfit). Always say what IS there, never what isn't — "overcast and raining", not "no sun"; "an enclosed room with walls and a ceiling", not "not outside". ("not X" is invisible to the model.)
- ACCURATE + ON-TOPIC. Use the materials, structures and objects that belong to the topic's real time and place (historical or modern) — nothing out of place. Someone who knows the subject shouldn't be able to nitpick it.
${bgRule}
${consistencyRule}
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
  const isFpv = input.style === "anime-fpv";

  // FPV keeps every shot inside the viewer's own eyes: the camera distance moves
  // (wide POV → closer POV → detail) but it never leaves first person and never
  // shows a face. Non-FPV styles keep the normal third-person coverage rules.
  const differRule = isFpv
    ? `- THE ${count} SHOTS MUST LOOK CLEARLY DIFFERENT, all in FIRST-PERSON POV. Change the CAMERA distance, not the vantage: a WIDE POV taking in the whole place ahead of you → a CLOSER POV on the key object / your own hands at the work → a tight DETAIL of the single most important element. Still first-person every time (never step outside to a third-person view), and if two prompts could render near-identical, rewrite one.`
    : `- THE ${count} SHOTS MUST LOOK CLEARLY DIFFERENT, or they render as the same picture and get dropped as duplicates. Change the CAMERA between them, not the caption: a WIDE establishing view of the whole place → a CLOSER angle on the key structure/object/action → a tight DETAIL of the single most important element. Different distance AND angle each time. If two of your prompts could produce near-identical images, rewrite one.`;

  const holdRule = isFpv
    ? `- STAY FIRST-PERSON AND NO FACE ACROSS ALL ${count} SHOTS. Every shot is "pov" from your own eyes — your own hands/body may enter the frame doing the beat's action, but NEVER a separate standing figure and NEVER your face (no front view, no mirror, no reflection). Carry the action from the base prompt into each shot (if you're lying down to sleep, all ${count} shots are that POV — the ceiling, your hands settling, eyes closing to dark), do NOT reset to a neutral establishing shot with a person in it.`
    : `- KEEP THE SAME POSE/ACTION ACROSS ALL ${count} SHOTS — only the camera moves, never the body. If the beat has the figure lying down asleep, sitting, or kneeling, then EVERY one of the ${count} shots shows him lying / sitting / kneeling (wide, closer and detail all of that same pose) — do NOT reset him to a neutral standing establishing shot. Carry the pose from the base prompt into each shot verbatim.`;

  const subjectRule = isFpv
    ? `- Every shot depicts the SPECIFIC thing this beat's narration describes, as YOU see it, rendered with its stated details (if the line says "fifty doors", draw fifty; if "shields locked", lock them). The base prompt names that subject — keep it central. Make one a tight close-up of your own hands / what you're holding when the beat is about doing something; for place/object beats, keep the described thing on screen.`
    : `- Every shot depicts the SPECIFIC thing this beat's narration describes, rendered with its stated details (if the line says "fifty doors", draw fifty; if it says "shields locked", lock them). The base prompt names that subject — keep it central. Only make one a close-up on a character's face when the beat is actually ABOUT a person reacting — for scene/place/object beats, keep the described thing on screen, not a random figure.`;

  const faceRule = isFpv
    ? `- Each prompt stands alone (the image model sees only that one line) and must carry the world's concrete markers so the shots clearly belong to the same scene; keep it first-person with NO face shown.`
    : `- Each prompt stands alone (the image model sees only that one line) and must carry the world's concrete markers so the shots clearly belong to the same scene; when a face is shown, give it a warm, content SMILE by default (only another expression when the beat clearly calls for it).`;

  return `Each beat below stays on screen too long for a single picture. Cut it into the requested number of DISTINCT SHOTS — the way a video editor covers one moment from different angles — so the screen keeps changing and never looks like the same picture nudged.

WORLD (every shot lives here): ${input.setting || "unspecified"}

${listing}

Rules:
- ONE SINGLE MOMENT PER PROMPT. Each prompt is ONE instant seen by ONE camera — never two things at once, never a sequence. NO collages, NO split screens, NO side-by-side or before/after panels, NO grids or multi-panel layouts, and no "then"/"and then"/"as well as" describing a second scene. One place, one instant, one composition. (This is the collage bug — kill it here.)
${differRule}
${holdRule}
${subjectRule}
- SAME LIGHT AND WEATHER ACROSS ALL ${count} SHOTS. Read the TIME-OF-DAY, lighting and WEATHER stated in the base prompt and keep them IDENTICAL in every shot — never re-light the scene or change the weather between shots (if the base prompt is "night, rain", all ${count} shots are night and rain). This is one moment, so it is one time of day and one weather.
- SAME PLACE, SAME SIDE OF THE WALL, ACROSS ALL ${count} SHOTS. Every shot is in the SAME location as the base prompt: if the beat is INSIDE (a room), all ${count} shots are interior (walls, ceiling, furniture, a window) — never step outside to an open landscape just to vary the angle; if OUTSIDE, all ${count} shots are outdoors. Move the camera within that one place, don't relocate it — and keep its fixed furniture (bed, fireplace/hearth, table, window, door) in the SAME positions across the shots.
- SAME OUTFIT ACROSS ALL ${count} SHOTS: the figure wears the exact same clothes in every shot (read it from the base prompt) — never restyle or recolour the outfit between shots. (For first-person POV, the same visible sleeves/coat.)
- SAME SEASON, CARRIED ITEMS & OTHER PEOPLE across all ${count} shots: the season, anything he's holding, and any other person present look identical in every shot (read them from the base prompt) — nothing appears, vanishes or changes appearance between the shots of one beat.
- Stay true to the beat; do NOT invent new events the narration doesn't mention, and never jump ahead to a later beat.
${faceRule}
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
