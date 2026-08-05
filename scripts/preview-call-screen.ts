import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCallScreen } from "@clipfactory/media";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const common = { width: 1080, height: 1920, left: "Dave", right: "Priya" };
  for (const active of [0, 1]) {
    const png = await buildCallScreen({ ...common, active });
    const out = join(root, "scripts", `call-screen-${active === 0 ? "left" : "right"}.png`);
    await fs.writeFile(out, png);
    console.log("wrote", out);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
