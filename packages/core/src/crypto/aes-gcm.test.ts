import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, decryptJson, encrypt, encryptJson } from "./aes-gcm";

const key = randomBytes(32).toString("base64");

describe("aes-256-gcm", () => {
  it("round-trips text, including unicode", () => {
    const text = "Amara struggled with ½ + ¼ — then got it 🎉";
    expect(decrypt(encrypt(text, key), key)).toBe(text);
  });

  it("round-trips JSON", () => {
    const map = { "[CHILD_1]": "Amara", "[SCHOOL_1]": "Oakfield Primary" };
    expect(decryptJson(encryptJson(map, key), key)).toEqual(map);
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("rejects a wrong key", () => {
    const other = randomBytes(32).toString("base64");
    expect(() => decrypt(encrypt("secret", key), other)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = encrypt("secret notes", key).split(":");
    const flipped = Buffer.from(ct ?? "", "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64")].join(":"), key)).toThrow();
  });

  it("rejects malformed payloads and bad keys", () => {
    expect(() => decrypt("nonsense", key)).toThrow();
    expect(() => encrypt("x", Buffer.alloc(16).toString("base64"))).toThrow();
  });
});
