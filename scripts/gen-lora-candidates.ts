/**
 * Generate a CONSISTENT candidate set for training a "stickman" style LoRA.
 *
 * Every image shares one fixed STYLE block, so the ~32 candidates look like one
 * hand drew them — the whole point, because a style LoRA trained on a mishmash
 * produces a mushy average. Each SUBJECT deliberately pairs a stick-figure human
 * (with an expressive face + a little hair) with a PROPERLY-drawn animal/object/
 * place, so the training set visibly teaches the rule "sticks only for people,
 * everything else is real". Emotions vary per subject so the face stays
 * expressive, not frozen.
 *
 * Source model: fal's base FLUX.1 [dev] (fal-ai/flux/dev) — same account/credit
 * you'll train on, and far better at a distinctive stick style than gpt-image-mini.
 *
 * Run:   pnpm tsx scripts/gen-lora-candidates.ts        (needs FAL_KEY)
 * Then:  open scripts/lora-candidates/stick-scene/, DELETE any image where the
 *        human isn't a clean stick or a non-human went sticky, and upload the
 *        ~20 keepers to fal → Train Flux LoRA (STYLE mode, trigger word
 *        "stickmanstyle"). Culling is the quality control.
 *
 * ~32 images at ~$0.03 each ≈ $1. Safe to re-run: existing files are skipped, so
 * a failed/rate-limited run just fills the gaps on the next pass.
 */
import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) loadDotenv({ path: envPath });

const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
if (!KEY) {
  console.error("FAL_KEY is required (set it in .env or the environment). Get one at fal.ai → Settings → Keys.");
  process.exit(1);
}

// The FIXED style — identical on every image. HARD RULE learned the hard way:
// the body must be a single LINE, never an outlined/filled torso — an outlined
// bare torso + no face reads as a NAKED person. So: single-line body + always a
// face. Clothing only ever a named HEAD item (crown/hat/helmet).
const STYLE =
  "drawn as a simple black line-drawing stick-figure cartoon, flat 2D, on a simple flat-colour " +
  "scene background. EACH person is an abstract xkcd-style stick figure: a plain round head with a " +
  "simple face (two dot eyes and a small curved mouth, and optionally a few thin strokes of hair), " +
  "ONE single straight vertical line for the whole body and torso, single thin straight lines for " +
  "the arms and legs, and tiny stick hands and feet. CRITICAL: the body is a LINE, never a filled " +
  "or outlined torso — there is no chest, no belly, no shoulders, no waist, no muscles, no skin and " +
  "NO NUDITY. The body wears no clothing at all; a figure may wear ONLY a named head item (a crown, " +
  "a chef's hat, or a helmet) and nothing else. If a figure looks like a bare human body instead of " +
  "simple black stick lines, it is WRONG. Everything that is NOT a person — animals, tools, objects, " +
  "food, plants, buildings, vehicles, the landscape — is drawn PROPERLY and accurately as a real " +
  "recognisable thing, never as sticks, with bold clean outlines, flat bright colours and light " +
  "shading. One single clear scene, no text, no panels, nothing clipped by the frame edge.";

// Mix: single-character actions, the SEATED/STATIC poses that drifted anatomical
// (must come out as clean line-sticks WITH faces now), MULTI-CHARACTER scenes, and
// accessory shots (single-line body + one head item). Every "stick figure" relies
// on the STYLE block for the single-line-body + always-a-face rule.
const SUBJECTS = [
  // --- single-character actions ---
  "a stick figure hammering a glowing sword on a detailed iron anvil beside a stone forge, sparks flying",
  "a stick figure drawing a properly-drawn wooden bow at a running deer in a green forest",
  "a stick figure pushing a detailed wooden wheelbarrow full of stones along a dirt path",
  "a stick figure pulling round loaves of bread out of a detailed brick oven",
  "a stick figure pointing up at a properly-drawn erupting volcano, ash and embers falling",
  "a stick figure carrying a wooden bucket up from a properly-drawn round stone well",
  "a stick figure climbing the rigging ropes of a tall detailed wooden sailing ship",
  "a stick figure picking red apples from a properly-drawn apple tree into a wicker basket",
  "a stick figure riding a properly-drawn galloping brown horse across a grassy field",
  "a stick figure running away from a properly-drawn erupting volcano, ash falling",
  // --- seated / static (the failure cases to nail) ---
  "a stick figure sitting cross-legged reading a properly-drawn open book by candlelight",
  "a stick figure sitting on a properly-drawn wooden stool milking a properly-drawn cow",
  "a stick figure sitting at a properly-drawn wooden desk writing on a scroll with a feather quill",
  "a stick figure kneeling on the ground to light a small campfire under a starry night sky",
  "a stick figure sitting on the ground eating rice from a properly-drawn clay bowl",
  // --- multi-character scenes ---
  "two stick figures shaking hands in front of a properly-drawn wooden market stall",
  "three stick figures rowing a properly-drawn long wooden boat across a calm lake",
  "two stick figures duelling with properly-drawn swords and round wooden shields on a field",
  "three stick figures sitting together around a properly-drawn campfire at night",
  "two stick figures carrying a properly-drawn heavy wooden log between them",
  "one tall stick figure pointing at a properly-drawn chalkboard teaching two smaller stick figures",
  "two stick figures pulling opposite ends of a rope in a tug-of-war on a grassy field",
  "four small stick figures marching in a line carrying properly-drawn spears",
  "two stick figures trading — one holding a properly-drawn chicken, the other a pile of gold coins",
  "two stick figures lifting a properly-drawn stone block onto a half-built wall together",
  "a stick figure handing a properly-drawn loaf of bread to a smaller stick figure child",
  // --- accessories: single-line body + ONE head item ---
  "a stick figure wearing only a small gold crown, sitting on a properly-drawn ornate golden throne",
  "a stick figure wearing only a tall white chef's hat, flipping a pancake over a properly-drawn stove",
  "a stick figure wearing only a metal helmet, holding a properly-drawn spear on a stone castle wall",
  "two stick figures in a properly-drawn throne room — one wearing a small gold crown, the other bowing",
  "a stick figure wearing only a metal helmet, raising a properly-drawn sword beside a round shield",
  "a stick figure wearing only a straw hat, scattering seed to properly-drawn chickens on a farm",
];

const OUT = join(root, "scripts", "lora-candidates", "stick-scene-v2");

/** One FLUX.1 [dev] generation via fal's synchronous host; returns the PNG/JPEG bytes. */
async function generate(prompt: string): Promise<Buffer> {
  const res = await fetch("https://fal.run/fal-ai/flux/dev", {
    method: "POST",
    headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      image_size: "square_hd", // 1024² — clean, aspect-neutral training crops
      num_inference_steps: 30,
      guidance_scale: 3.5,
      num_images: 1,
      enable_safety_checker: true,
    }),
  });
  if (!res.ok) throw new Error(`fal ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { images?: Array<{ url?: string }> };
  const url = data.images?.[0]?.url;
  if (!url) throw new Error("fal returned no image url");
  const img = await fetch(url);
  if (!img.ok) throw new Error(`download failed: ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  // A manifest so you know which file is which scene while culling.
  const manifest: string[] = [];
  const failed: number[] = [];

  for (let i = 0; i < SUBJECTS.length; i++) {
    const n = String(i + 1).padStart(2, "0");
    const file = join(OUT, `${n}.png`);
    manifest.push(`${n}.png  —  ${SUBJECTS[i]}`);
    if (existsSync(file)) {
      console.log(`${n} skip (exists)`);
      continue;
    }
    process.stdout.write(`${n} generating … `);
    try {
      const bytes = await generate(`${SUBJECTS[i]}, ${STYLE}`);
      await fs.writeFile(file, bytes);
      console.log(`ok (${Math.round(bytes.length / 1024)} KB)`);
    } catch (err) {
      failed.push(i + 1);
      console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await fs.writeFile(join(OUT, "subjects.txt"), manifest.join("\n") + "\n", "utf8");
  console.log(`\nDone. Images in ${OUT}`);
  if (failed.length) console.log(`Re-run to retry failed: ${failed.map((f) => String(f).padStart(2, "0")).join(", ")}`);
  console.log(
    "Next: delete any image where the human isn't a clean stick (or a non-human went sticky),\n" +
      'then upload the ~20 keepers to fal → Train Flux LoRA (STYLE mode, trigger word "stickmanstyle").',
  );
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
