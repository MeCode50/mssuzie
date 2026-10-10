import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "../db/client";

export const ACTION_LINK_TTL_MS = 48 * 3_600_000;

export type LinkCheck =
  | { ok: true; tokenId: string; requestId: string; slotStartsAt: Date }
  | { ok: false; reason: "malformed" | "bad_signature" | "unknown" | "expired" | "used" };

const sign = (id: string, secret: string) => createHmac("sha256", secret).update(id).digest("base64url");

/** Create a single-use, 48-hour accept link token for one proposed slot of a request. */
export async function issueActionToken(
  prisma: PrismaClient,
  secret: string,
  input: { requestId: string; slotStartsAt: Date; now?: Date },
): Promise<string> {
  const now = input.now ?? new Date();
  const row = await prisma.actionToken.create({
    data: { requestId: input.requestId, slotStartsAt: input.slotStartsAt, expiresAt: new Date(now.getTime() + ACTION_LINK_TTL_MS) },
    select: { id: true },
  });
  return `${row.id}.${sign(row.id, secret)}`;
}

/** Check the signature, existence, expiry and that it has not been used. Does not consume it. */
export async function checkActionToken(prisma: PrismaClient, secret: string, token: string, now = new Date()): Promise<LinkCheck> {
  const [id, sig, ...rest] = token.split(".");
  if (!id || !sig || rest.length > 0 || id.length > 64) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(id, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  const row = await prisma.actionToken.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: "unknown" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, tokenId: row.id, requestId: row.requestId, slotStartsAt: row.slotStartsAt };
}

/** Atomically mark a token used. Returns false if someone else used it first (or it expired). */
export async function consumeActionToken(prisma: PrismaClient, tokenId: string, now = new Date()): Promise<boolean> {
  const { count } = await prisma.actionToken.updateMany({ where: { id: tokenId, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  return count === 1;
}

/** Every outstanding link for a request stops working once the request is settled. */
export async function voidActionTokens(prisma: PrismaClient, requestId: string, now = new Date()): Promise<void> {
  await prisma.actionToken.updateMany({ where: { requestId, usedAt: null }, data: { usedAt: now } });
}
