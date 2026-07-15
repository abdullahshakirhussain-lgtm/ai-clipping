import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { loadEnv } from "./env.js";

/**
 * Symmetric encryption for at-rest secrets (social-account passwords in the
 * vault). AES-256-GCM with a key derived from CREDENTIALS_SECRET (falls back to
 * BETTER_AUTH_SECRET). Not a substitute for a real password manager — the key
 * lives on the same server — but keeps plaintext out of the database/backups.
 */
function key(): Buffer {
  const env = loadEnv();
  const secret = env.CREDENTIALS_SECRET || env.BETTER_AUTH_SECRET;
  return createHash("sha256").update(secret).digest(); // 32 bytes
}

/** Encrypt to "v1:<iv>:<tag>:<ciphertext>" (each part base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const [v, ivB, tagB, ctB] = blob.split(":");
  if (v !== "v1" || !ivB || !tagB || !ctB) throw new Error("bad secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
}
