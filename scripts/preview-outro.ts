import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOutroCard } from "@clipfactory/media";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const png = await buildOutroCard(1080, 1920);
  const out = join(root, "scripts", "outro-card.png");
  await fs.writeFile(out, png);
  console.log(`Wrote ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
