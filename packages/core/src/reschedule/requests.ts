import { randomUUID } from "node:crypto";
import { encrypt } from "../crypto/aes-gcm";
import type { PrismaClient } from "../db/client";

/** A parent's message is short; anything longer is almost certainly not a scheduling request. */
export const MAX_MESSAGE_CHARS = 2000;

export class RequestError extends Error {
  constructor(readonly code: "EMPTY" | "TOO_LONG" | "NO_GUARDIAN", message: string) {
    super(message);
    this.name = "RequestError";
  }
}

export interface NewRequest {
  guardianId: string;
  message: string;
  channel?: "simulator" | "email";
  encryptionKey: string;
  createdById?: string;
}

/** Store the parent's message (encrypted) and queue a rescheduling run for it, in one transaction. */
export async function createRescheduleRequest(prisma: PrismaClient, input: NewRequest): Promise<{ requestId: string; runId: string }> {
  const message = input.message.normalize("NFC").replace(/\u0000/g, "").trim();
  if (message.length === 0) throw new RequestError("EMPTY", "Please type the parent's message.");
  if (message.length > MAX_MESSAGE_CHARS) throw new RequestError("TOO_LONG", `The message can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`);
  const guardian = await prisma.guardian.findUnique({ where: { id: input.guardianId }, select: { id: true, learnerId: true } });
  if (!guardian) throw new RequestError("NO_GUARDIAN", "That guardian could not be found.");

  return prisma.$transaction(async (tx) => {
    const run = await tx.run.create({
      data: { pipeline: "reschedule", idempotencyKey: `reschedule:${randomUUID()}`, createdById: input.createdById ?? null },
      select: { id: true },
    });
    const request = await tx.rescheduleRequest.create({
      data: {
        guardianId: guardian.id, learnerId: guardian.learnerId, channel: input.channel ?? "simulator",
        rawMessageEnc: encrypt(message, input.encryptionKey), runId: run.id,
      },
      select: { id: true },
    });
    return { requestId: request.id, runId: run.id };
  });
}
