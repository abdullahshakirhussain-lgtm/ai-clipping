/**
 * Generate ONE style-reference exemplar per Story style and bundle them (base64)
 * into packages/ai/src/style-refs.generated.ts, plus PNG previews under
 * scripts/style-refs-preview/ for eyeballing.
 *
 * These exemplars are fed to gpt-image's edits endpoint on every story frame so
 * the chosen style is enforced by EXAMPLE, not by a text description that
 * gpt-image-1-mini collapses to one default look. The exemplar prompts here are
 * bespoke (deliberately structurally distinct — explainer = single graphic on
 * white; stick-scene = a figure in a colourful scene) so no two styles converge.
 *
 * Run:   pnpm tsx scripts/gen-style-exemplars.ts        (needs OPENAI_API_KEY)
 * Then:  review scripts/style-refs-preview/*.png, and commit style-refs.generated.ts
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { OpenAiImageProvider } from "@clipfactory/ai";
import { STORY_STYLES } from "@clipfactory/core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) loadDotenv({ path: envPath });

// Bespoke canonical exemplar per style — NOT the per-beat styledImagePrompt.
// Each is a single clean example of the style, structurally distinct from the
// others so the reference forces a genuinely different look.
const EXEMPLAR_PROMPTS: Record<string, string> = {
  "stick-scene":
    "A single canonical example frame in a kids' history-explainer style: ONE true simple stick figure (plain black thin-line body, bare circle head, single-line limbs, a simple face of dot eyes + eyebrows + a mouth) standing in a colourful flat-colour illustrated scene with a few simple background props. Bold clean black outlines, flat bright colours, minimal soft shading. One picture, plain and clear.",
  explainer:
    "A single canonical example frame for a stick-figure explainer channel: ONE bold flat-vector ICON plus a tiny shapes-and-arrows diagram (a red arrow, a circle) on a PLAIN WHITE background — NO scenery, NO landscape, NO colourful backdrop. Black outlines, flat colours, a single small red accent. Minimal, whiteboard-clear, like a modern 2D history-explainer graphic.",
  whiteboard:
    "A single canonical whiteboard-marker drawing: a simple stick figure and one basic object drawn in bright red, blue and green marker strokes on a plain white board. Energetic hand-drawn marker look, clean white background.",
  doodle:
    "A single canonical bright doodle-cartoon frame: one simple expressive stick figure with a big emotive face (large eyes, open mouth, eyebrows), thick bold outlines, cheerful flat colours, a simple colourful background.",
  "flat-vector":
    "A single canonical flat-vector infographic frame: bold simple geometric shapes, bright saturated flat colours, thick clean outlines, one minimal expressive character, modern infographic look on a plain light background.",
  "notebook-sketch":
    "A single canonical notebook-sketch frame: loose hand-drawn pen-and-marker doodles and one simple expressive stick figure, bright marker colour over blue-ink linework, on lined notebook paper.",
};

/** Downscale a PNG to `size`² via ffmpeg-static (keeps the bundled base64 small). Falls back to the original if ffmpeg isn't found. */
async function downscale(png: Buffer, size: number): Promise<Buffer> {
  const bin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const pnpm = join(root, "node_modules", ".pnpm");
  let ffmpeg: string | null = null;
  try {
    const dir = (await fs.readdir(pnpm)).find((e) => e.startsWith("ffmpeg-static@"));
    if (dir) {
      const p = join(pnpm, dir, "node_modules", "ffmpeg-static", bin);
      if (existsSync(p)) ffmpeg = p;
    }
  } catch {
    /* ignore */
  }
  if (!ffmpeg) {
    console.warn("  (ffmpeg-static not found — bundling full-size PNG)");
    return png;
  }
  return await new Promise<Buffer>((resolve) => {
    const p = spawn(ffmpeg!, ["-y", "-i", "pipe:0", "-vf", `scale=${size}:${size}`, "-vcodec", "png", "-f", "image2pipe", "pipe:1"]);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", () => resolve(png));
    p.on("close", (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : png));
    p.stdin.on("error", () => {});
    p.stdin.end(png);
  });
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (set it in .env or the environment)");
  // Full quality for the one-time exemplars — they set the look for every frame.
  const provider = new OpenAiImageProvider({ apiKey, model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini", quality: "high" });

  const previewDir = join(root, "scripts", "style-refs-preview");
  await fs.mkdir(previewDir, { recursive: true });

  const out: Record<string, string> = {};
  for (const style of STORY_STYLES) {
    const prompt = EXEMPLAR_PROMPTS[style];
    if (!prompt) {
      console.warn(`No exemplar prompt for "${style}" — skipping`);
      continue;
    }
    process.stdout.write(`Generating exemplar: ${style} … `);
    const { image } = await provider.generate({ prompt, size: "1024x1024" });
    const small = await downscale(image, 512);
    out[style] = small.toString("base64");
    await fs.writeFile(join(previewDir, `${style}.png`), small);
    console.log(`ok (${Math.round(small.length / 1024)} KB)`);
  }

  const banner = `/**
 * GENERATED by scripts/gen-style-exemplars.ts — do not edit by hand.
 * One base64 PNG per Story style, used as a fixed STYLE REFERENCE (gpt-image
 * edits) so the chosen style is enforced by example. Regenerate + re-commit when
 * you want to change a style's canonical look.
 */
export const STYLE_REFS: Record<string, string> = ${JSON.stringify(out, null, 2)};
`;
  const target = join(root, "packages", "ai", "src", "style-refs.generated.ts");
  await fs.writeFile(target, banner, "utf8");
  console.log(`\nWrote ${Object.keys(out).length} exemplars to ${target}`);
  console.log(`Review previews in ${previewDir}, then commit style-refs.generated.ts`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
