/**
 * Eyeball the deterministic stick figure — NO AI, free. Renders every pose (in a
 * few expressions + head items) into one PNG sheet so we can confirm the code-drawn
 * character looks right before wiring any AI path.
 *
 * Run:  pnpm tsx scripts/preview-stickman.ts   → scripts/stickman-preview.png
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStickmanSheetPng, POSE_NAMES, type Expression, type HeadItem, type SheetCell } from "@clipfactory/media";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const cells: SheetCell[] = [
  ...POSE_NAMES.map((pose) => ({ label: pose, figures: [{ pose, expression: "neutral" as Expression }] })),
  ...(["happy", "scared", "sad", "angry", "surprised"] as Expression[]).map((expression) => ({
    label: `face:${expression}`,
    figures: [{ pose: "stand" as const, expression }],
  })),
  ...(["crown", "hat", "helmet"] as HeadItem[]).map((headItem) => ({
    label: `head:${headItem}`,
    figures: [{ pose: "stand" as const, expression: "happy" as Expression, headItem }],
  })),
  {
    label: "two-char",
    figures: [
      { pose: "hold-out", expression: "happy", x: 0.34, scale: 0.6 },
      { pose: "point", expression: "surprised", x: 0.68, scale: 0.6, flip: true },
    ],
  },
];

async function main() {
  const png = await buildStickmanSheetPng(cells);
  const out = join(root, "scripts", "stickman-preview.png");
  await fs.writeFile(out, png);
  console.log(`Wrote ${out} (${cells.length} cells)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
