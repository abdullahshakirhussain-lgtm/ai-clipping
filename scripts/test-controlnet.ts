/**
 * MAKE-OR-BREAK TEST (plan build-step 2): does a ControlNet lock the figure to our
 * code-drawn stick skeleton while the AI draws the held object into the posed hand?
 *
 * For each pose+object, we render the deterministic control image (black lines on
 * white) and feed it to fal-ai/flux-general as the control, with a stick-style
 * prompt (+ our LoRA if FAL_STICKMAN_LORA_URL is set). Outputs + the control images
 * are written to scripts/controlnet-test/ for full-res review.
 *
 * Run:  FAL_KEY=... [FAL_STICKMAN_LORA_URL=...] pnpm tsx scripts/test-controlnet.ts
 */
import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { renderStickman, type PoseName } from "@clipfactory/media";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) loadDotenv({ path: envPath });

const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
if (!KEY) {
  console.error("FAL_KEY required");
  process.exit(1);
}
const LORA = process.env.FAL_STICKMAN_LORA_URL || "";

// Lead with the trigger word and ASK FOR COLOUR — the LoRA supplies the figure
// look now, so we don't over-describe "line drawing" (that flattened the render).
const STYLE =
  "stickmanstyle, a simple stick figure in a flat 2D colourful children's history-explainer cartoon, " +
  "bold clean black outlines, flat BRIGHT COLOURS, light shading, a simple colourful flat-colour scene, " +
  "single character, no other people, no crowd";

const COMBOS: Array<{ pose: PoseName; scene: string }> = [
  { pose: "hold-out", scene: "holding a wooden quill pen, writing on a properly-drawn parchment scroll on a wooden desk" },
  { pose: "overhead-swing", scene: "swinging a properly-drawn metal sword over a glowing anvil in a stone forge" },
  { pose: "carry-side", scene: "carrying a properly-drawn wooden bucket beside a round stone well" },
  { pose: "point", scene: "pointing at a properly-drawn erupting volcano with lava and ash" },
];

const OUT = join(root, "scripts", "controlnet-test");

async function call(controlDataUri: string, prompt: string): Promise<{ ok: boolean; body: string; url?: string }> {
  const body: Record<string, unknown> = {
    prompt,
    image_size: { width: 768, height: 1280 },
    num_inference_steps: 28,
    guidance_scale: 3.5,
    num_images: 1,
    output_format: "png",
    seed: Math.floor(Math.random() * 1_000_000_000),
    controlnet_unions: [
      {
        path: "Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro",
        // Low strength + apply ONLY for the first half of denoising: this locks the
        // POSE early, then lets the model finish freely so colour/style come through
        // instead of the whole image collapsing into the black-line stencil.
        controls: [{ control_mode: "canny", control_image_url: controlDataUri, conditioning_scale: 0.6, start_percentage: 0, end_percentage: 0.75 }],
      },
    ],
  };
  if (LORA) body.loras = [{ path: LORA, scale: 1 }];

  const res = await fetch("https://fal.run/fal-ai/flux-general", {
    method: "POST",
    headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, body: text };
  const json = JSON.parse(text) as { images?: Array<{ url?: string }> };
  return { ok: true, body: text, url: json.images?.[0]?.url };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log(`LoRA: ${LORA ? "yes" : "no (style via prompt only)"}\n`);
  for (let i = 0; i < COMBOS.length; i++) {
    const c = COMBOS[i]!;
    const n = String(i + 1).padStart(2, "0");
    // Smaller figure (~0.45 of height) sits it in the scene like #4, where it stays
    // a clean stick — big foreground figures let the model fill in a clothed human.
    const { controlPng } = await renderStickman({ figures: [{ pose: c.pose, expression: "neutral", scale: 0.45 }], width: 768, height: 1280 });
    await fs.writeFile(join(OUT, `${n}-${c.pose}-control.png`), controlPng);
    const dataUri = `data:image/png;base64,${controlPng.toString("base64")}`;
    process.stdout.write(`${n} ${c.pose} … `);
    const r = await call(dataUri, `${STYLE}, ${c.scene}`);
    if (!r.ok) {
      console.log(`FAILED\n${r.body.slice(0, 700)}\n`);
      // Schema-discovery run: stop after the first error so we read it clean.
      break;
    }
    if (r.url) {
      const img = await fetch(r.url);
      await fs.writeFile(join(OUT, `${n}-${c.pose}-result.png`), Buffer.from(await img.arrayBuffer()));
      console.log("ok");
    } else {
      console.log(`ok but no image url\n${r.body.slice(0, 300)}`);
    }
  }
  console.log(`\nOutputs in ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
