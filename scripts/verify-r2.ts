/**
 * R2 end-to-end smoke test. Reads R2_* from your .env (or the process env) and
 * performs a real round-trip against the bucket:
 *   putBuffer -> exists -> getUrl (presigned) -> HTTP GET -> delete -> exists=false
 *
 * Run:  pnpm tsx scripts/verify-r2.ts
 *
 * It never touches app data — it writes a single throwaway key under
 * `__verify/` and deletes it at the end.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { R2Storage } from "@clipfactory/storage";

// Load the workspace .env (same file the app uses).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) loadDotenv({ path: envPath });

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`\n✗ Missing ${name}. Set it in .env before running.\n`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const accountId = req("R2_ACCOUNT_ID");
  const accessKeyId = req("R2_ACCESS_KEY_ID");
  const secretAccessKey = req("R2_SECRET_ACCESS_KEY");
  const bucket = req("R2_BUCKET");
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim() || undefined;

  console.log(`\nR2 config:`);
  console.log(`  account:   ${accountId.slice(0, 6)}…`);
  console.log(`  bucket:    ${bucket}`);
  console.log(`  endpoint:  https://${accountId}.r2.cloudflarestorage.com`);
  console.log(`  urls:      ${publicBaseUrl ? `public (${publicBaseUrl})` : "presigned (bucket stays private)"}\n`);

  const storage = new R2Storage({ accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl });

  const key = `__verify/${Date.now()}.txt`;
  const payload = `clipfactory-r2-ok ${new Date().toISOString()}`;

  console.log(`→ putBuffer ${key}`);
  await storage.putBuffer(key, Buffer.from(payload), "text/plain");

  console.log(`→ exists`);
  const present = await storage.exists(key);
  if (!present) throw new Error("object not found immediately after upload");
  console.log(`  ✓ present`);

  console.log(`→ getUrl`);
  const url = await storage.getUrl(key);
  console.log(`  ${url.slice(0, 90)}${url.length > 90 ? "…" : ""}`);

  console.log(`→ HTTP GET the url`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET failed: ${res.status} ${res.statusText}`);
  const body = await res.text();
  if (body !== payload) throw new Error(`content mismatch: got "${body.slice(0, 40)}"`);
  console.log(`  ✓ round-trip content matches`);

  console.log(`→ delete (cleanup)`);
  await storage.delete(key);
  const gone = await storage.exists(key);
  if (gone) throw new Error("object still present after delete");
  console.log(`  ✓ deleted\n`);

  console.log(`✅ R2 is wired correctly. Set STORAGE_DRIVER=r2 (+ the same R2_* vars) on Railway.\n`);
}

main().catch((err) => {
  console.error(`\n✗ R2 verification FAILED:`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error(`\nCommon causes:`);
  console.error(`  • Wrong Account ID (it's the hash in the R2 endpoint, not your email).`);
  console.error(`  • API token lacks Object Read & Write on this bucket.`);
  console.error(`  • R2_BUCKET name doesn't match the bucket you created.\n`);
  process.exit(1);
});
