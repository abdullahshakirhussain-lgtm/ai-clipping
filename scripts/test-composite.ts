/**
 * WAY A test (plan build-step 3): the reliable path. Generate a background WITH NO
 * people, then composite our deterministic code-drawn stick figure onto it. The
 * figure is identical every time — no AI on the character at all.
 *
 * Run:  FAL_KEY=... ./node_modules/.bin/tsx scripts/test-composite.ts
 */
import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { compositeFigure, renderStickman, type FigureSpec, type PoseName } from "@clipfactory/media";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) loadDotenv({ path: envPath });

const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
if (!KEY) {
  console.error("FAL_KEY required");
  process.exit(1);
}

const W = 768;
const H = 1280;

// No-object shots (Way A handles these; held objects are Way B's job).
const SCENES: Array<{ pose: PoseName; expression: FigureSpec["expression"]; scene: string; heightFrac: number }> = [
  { pose: "point", expression: "surprised", scene: "a huge erupting volcano with lava, ash cloud and rocks", heightFrac: 0.42 },
  { pose: "stand", expression: "happy", scene: "a medieval village street with stone cottages and market stalls", heightFrac: 0.5 },
  { pose: "run", expression: "scared", scene: "a desert with tall pyramids under a blue sky", heightFrac: 0.4 },
  { pose: "arms-raised", expression: "happy", scene: "a green hilltop with a castle in the distance and blue sky", heightFrac: 0.46 },
];

async function background(scene: string): Promise<Buffer> {
  const prompt =
    `${scene}, flat 2D colourful children's history-explainer cartoon illustration, bold clean black outlines, ` +
    `flat bright colours, light shading, wide empty foreground with clear open ground, NO people, no characters, no figures, no text`;
  const res = await fetch("https://fal.run/fal-ai/flux/dev", {
    method: "POST",
    headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: { width: W, height: H }, num_inference_steps: 28, guidance_scale: 3.5, num_images: 1, output_format: "png", seed: Math.floor(Math.random() * 1e9) }),
  });
  if (!res.ok) throw new Error(`bg ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { images?: Array<{ url?: string }> };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("no bg url");
  const img = await fetch(url);
  return Buffer.from(await img.arrayBuffer());
}

async function main() {
  const OUT = join(root, "scripts", "composite-test");
  await fs.mkdir(OUT, { recursive: true });
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i]!;
    const n = String(i + 1).padStart(2, "0");
    process.stdout.write(`${n} ${s.pose} … `);
    const bg = await background(s.scene);
    const { figurePng } = await renderStickman({ figures: [{ pose: s.pose, expression: s.expression, scale: 0.92 }], width: 300, height: 450 });
    const out = await compositeFigure(bg, figurePng, { heightFrac: s.heightFrac, xFrac: 0.5, bottomFrac: 0.92 });
    await fs.writeFile(join(OUT, `${n}-${s.pose}.png`), out);
    console.log("ok");
  }
  console.log(`\nOutputs in ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
