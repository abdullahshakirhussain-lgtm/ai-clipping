import { synthesizeTestVideo } from "@clipfactory/media";

async function main() {
  const out = process.argv[2] ?? "test-source.mp4";
  const dur = Number(process.argv[3] ?? 40);
  await synthesizeTestVideo(out, dur);
  console.log(`wrote ${out} (${dur}s)`);
}

void main();
