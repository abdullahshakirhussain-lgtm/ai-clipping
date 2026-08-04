import { promises as fs } from "node:fs";
import { join } from "node:path";
import { assembleSlideshow, buildOutroCard, probe } from "@clipfactory/media";
import type { PipelineContext } from "./context.js";

/**
 * The reused like/subscribe/follow outro appended to every story. It's identical
 * for every video — a fixed graphic + a fixed line in the premium voice — so it's
 * built ONCE per frame size and cached on disk; later renders reuse the same mp4.
 * Its separate narration and card make it read as clearly not part of the story.
 */
const OUTRO_LINE = "If you made it this far, hit like and follow — a new story every week.";
const OUTRO_MIN_SEC = 3;

/** Build-or-reuse the cached outro clip for this frame size. Null on failure. */
export async function getOutro(ctx: PipelineContext, width: number, height: number): Promise<string | null> {
  const dir = join(ctx.workRoot, "outro");
  const outPath = join(dir, `outro-${width}x${height}.mp4`);
  try {
    if ((await fs.stat(outPath)).size > 0) return outPath; // already built — reuse
  } catch {
    /* not built yet */
  }
  await fs.mkdir(dir, { recursive: true });

  // 1. Fixed narration in the premium voice.
  const { audio, ext } = await ctx.ttsFor("premium").synthesize({ text: OUTRO_LINE });
  const audioFile = join(dir, `outro-${width}x${height}.${ext}`);
  await fs.writeFile(audioFile, audio);

  // 2. Fixed card graphic (stick figure + LIKE · SUBSCRIBE · FOLLOW).
  const cardFile = join(dir, `outro-${width}x${height}.png`);
  await fs.writeFile(cardFile, await buildOutroCard(width, height));

  // 3. Hold the card for the length of the line (floored to a few seconds).
  let durationSec = OUTRO_MIN_SEC;
  try {
    const p = await probe(audioFile);
    if (p.durationSec > 0) durationSec = Math.max(OUTRO_MIN_SEC, p.durationSec + 0.4);
  } catch {
    /* keep the floor */
  }

  await assembleSlideshow({
    slides: [{ imageFile: cardFile, durationSec }],
    audioFile,
    outPath,
    workDir: dir,
    width,
    height,
  });
  return outPath;
}
