/**
 * Supplement to gen-lora-candidates.ts: a few "role accessory" examples for the
 * stickman LoRA. The figure stays a BARE stick body but wears exactly ONE simple
 * item on the HEAD ONLY — a chef's hat, a crown, or a helmet — and nothing else.
 * This teaches the LoRA to signal a role with a single accessory instead of
 * dressing the whole figure. Output: scripts/lora-candidates/accessories/.
 *
 * Run:  FAL_KEY=... pnpm tsx scripts/gen-lora-accessories.ts
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
  console.error("FAL_KEY is required (set it in .env or the environment).");
  process.exit(1);
}

const STYLE =
  "drawn as a clean flat 2D cartoon illustration with a simple flat-colour scene background. " +
  "The person is a TRUE BARE stick figure like an xkcd doodle: a single thin black line torso, " +
  "thin straight black-line arms and legs, tiny stick hands, a plain round head with a simple " +
  "expressive face (dot eyes, small eyebrows, a curved-line mouth) and optionally a few thin " +
  "strokes of hair. The body is thin LINES ONLY — never filled, never thick, never a rounded or " +
  "muscled cartoon body — and it wears NO clothes, NO shirt, NO trousers, NO robe, NO body armour. " +
  "The ONLY thing it may wear is the ONE simple item named in the description, worn on the HEAD " +
  "only, and nothing else on the body. Everything that is NOT the person — animals, tools, objects, " +
  "buildings, landscape — is drawn properly and accurately as a real recognisable thing, never as " +
  "sticks, with bold clean outlines, flat bright colours and light shading. One single scene, no text.";

// NOTE: role nouns ("chef", "knight") make the model add an apron/armour to the
// body. So name ONLY the head accessory + a hard "bare torso" clause, never the role.
const SUBJECTS = [
  "a proud bare stick figure wearing ONLY a small simple gold crown on its head (bare stick body, no clothes) sitting on a detailed ornate golden throne in a stone hall",
  "a stern bare stick figure wearing ONLY a gold crown on its head (bare stick body, no clothes) pointing forward, a properly-drawn royal banner behind",
  "a cheerful bare thin-line stick figure with a tall white chef's hat balanced on its round head — its torso, arms and legs are bare thin black lines with NO apron and NO clothing at all — holding a fork beside a detailed roast feast on a wooden table",
  "a bare thin-line stick figure with a tall white chef's hat on its round head — completely bare black-line body, absolutely NO apron and NO shirt — kneading dough on a board beside a detailed brick oven",
  "a brave bare thin-line stick figure with a simple grey metal helmet on its round head — its torso, arms and legs are bare thin black lines with NO armour, NO tunic and NO clothing — holding a properly-drawn sword and a round wooden shield",
  "an alert bare stick figure wearing ONLY a round metal helmet on its head (bare stick body, no clothes) standing guard with a properly-drawn spear beside a stone castle gate",
  "a bare thin-line stick figure with a round metal helmet on its round head — completely bare black-line body, NO armour and NO clothes — riding a properly-drawn brown horse across a field",
  "an alert bare thin-line stick figure with a metal helmet on its round head — bare thin black-line body, NO armour and NO clothing whatsoever — holding a properly-drawn spear on a stone castle wall at dusk",
];

const OUT = join(root, "scripts", "lora-candidates", "accessories");

async function generate(prompt: string): Promise<Buffer> {
  const res = await fetch("https://fal.run/fal-ai/flux/dev", {
    method: "POST",
    headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: "square_hd", num_inference_steps: 30, guidance_scale: 3.5, num_images: 1, enable_safety_checker: true }),
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
  const manifest: string[] = [];
  for (let i = 0; i < SUBJECTS.length; i++) {
    const n = String(i + 1).padStart(2, "0");
    const file = join(OUT, `${n}.jpg`);
    manifest.push(`${n}.jpg  —  ${SUBJECTS[i]}`);
    if (existsSync(file)) { console.log(`${n} skip (exists)`); continue; }
    process.stdout.write(`${n} generating … `);
    try {
      const bytes = await generate(`${SUBJECTS[i]}, ${STYLE}`);
      await fs.writeFile(file, bytes);
      console.log(`ok (${Math.round(bytes.length / 1024)} KB)`);
    } catch (err) {
      console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await fs.writeFile(join(OUT, "subjects.txt"), manifest.join("\n") + "\n", "utf8");
  console.log(`\nDone. Images in ${OUT}`);
}

main().catch((err) => { console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
