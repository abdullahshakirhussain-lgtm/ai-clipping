// Builds the extension and zips dist/ into the web app's public folder so the
// dashboard can serve it for download on any device (unzip → chrome://extensions
// → Load unpacked). Runs as the web app's prebuild, and the zip is also
// committed so the download works even on builds that skip prebuild.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import archiver from "archiver";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const publicDir = join(root, "..", "web", "public");
const outFile = join(publicDir, "clipfactory-extension.zip");

const res = spawnSync(process.execPath, [join(root, "build.mjs")], { stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);

// Next.js has no public/ by default — create it so the write stream can open.
await mkdir(publicDir, { recursive: true });

await new Promise((resolve, reject) => {
  const output = createWriteStream(outFile);
  const archive = archiver("zip", { zlib: { level: 9 } });
  output.on("close", resolve);
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(dist, "clipfactory-extension");
  void archive.finalize();
});

console.log(`zipped extension → ${outFile}`);
