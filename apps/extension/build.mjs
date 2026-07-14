// Bundles the extension's TS entry points into dist/ (IIFE, no modules — MV3
// content scripts must be classic scripts) and copies the static assets.
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const ctx = {
  entryPoints: [
    join(root, "src/background.ts"),
    join(root, "src/bridge.ts"),
    join(root, "src/content-youtube.ts"),
    join(root, "src/content-tiktok.ts"),
    join(root, "src/popup.ts"),
  ],
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome110",
  logLevel: "info",
};

await build(ctx);

// Static assets (manifest, popup html, icons) live in public/ and ship as-is.
await cp(join(root, "public"), dist, { recursive: true });

console.log(`built extension → ${dist}${watch ? " (rebuild by re-running)" : ""}`);
