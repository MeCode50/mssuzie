import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function toKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

/** AES-256-GCM. Output: `v1:<iv>:<tag>:<ciphertext>` (all base64). */
export function encrypt(plaintext: string, keyB64: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", toKey(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** Throws if the payload is malformed, tampered with, or the key is wrong. */
export function decrypt(payload: string, keyB64: string): string {
  const [version, iv, tag, ct, ...rest] = payload.split(":");
  if (version !== VERSION || !iv || !tag || ct === undefined || rest.length > 0) {
    throw new Error("Unsupported or malformed encrypted payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", toKey(keyB64), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown, keyB64: string): string {
  return encrypt(JSON.stringify(value), keyB64);
}

export function decryptJson<T>(payload: string, keyB64: string): T {
  return JSON.parse(decrypt(payload, keyB64)) as T;
}
