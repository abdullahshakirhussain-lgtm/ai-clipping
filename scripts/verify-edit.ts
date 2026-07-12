import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClipEdit, probe, renderClip, synthesizeTestVideo } from "@clipfactory/media";

async function main() {
  const workDir = join(tmpdir(), "cf-edit-verify");
  await fs.mkdir(workDir, { recursive: true });
  const src = join(workDir, "src.mp4");
  await synthesizeTestVideo(src, 40);

  // Words with a large gap (2s..20s) to force a real jump-cut.
  const words = [
    { word: "this", start: 1.0, end: 1.4 },
    { word: "is", start: 1.5, end: 1.8 },
    { word: "the", start: 1.9, end: 2.1 },
    { word: "hook", start: 2.2, end: 2.6 },
    { word: "again", start: 20.0, end: 20.4 },
    { word: "now", start: 20.5, end: 21.0 },
  ];
  const plan = planClipEdit({ words, clipStart: 0, clipEnd: 40, hookText: "You won't believe this" });
  console.log("selectSpans:", JSON.stringify(plan.selectSpans));
  console.log("keptDurationSec:", plan.clipDurationSec.toFixed(2), "removedSec:", plan.removedSec.toFixed(2));

  await fs.writeFile(join(workDir, "edit.ass"), plan.ass, "utf8");
  const out = join(workDir, "out.mp4");
  await renderClip({
    inputPath: src,
    outPath: out,
    startSec: 0,
    endSec: 40,
    workDir,
    selectSpans: plan.selectSpans,
    captionsFileName: "edit.ass",
  });
  const p = await probe(out);
  const size = (await fs.stat(out)).size;
  console.log(`RENDERED: ${p.width}x${p.height}, duration=${p.durationSec.toFixed(2)}s, ${size} bytes`);
  console.log(p.durationSec < 5 ? "PASS: jump-cut collapsed 40s -> a few seconds" : "WARN: duration not collapsed");
}

void main();
