import type { PrismaClient } from "../db/client";
import { Prisma } from "../generated/prisma/client";

export type MoveRefusal =
  /** Someone changed the booking after we looked at it (optimistic lock). */
  | "stale"
  /** The tutor or the learner already has a class at that time. */
  | "slot_taken"
  | "cancelled"
  | "not_found"
  /** The request already ended another way (rejected, or applied to a different slot). */
  | "already_decided";

export type MoveResult =
  | { ok: true; alreadyApplied: boolean; bookingId: string; fromAt: Date; toAt: Date; version: number; durationMin: number }
  | { ok: false; reason: MoveRefusal };

export interface MoveInput {
  requestId: string;
  bookingId: string;
  toStartsAt: Date;
  /** The booking version the decision was based on. */
  expectedVersion: number;
  decision: "auto_applied" | "confirmed";
  decidedBy: string;
  now?: Date;
}

const isOverlap = (err: unknown): boolean => {
  const text = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}` : String(err);
  return /bookings_(tutor|learner)_no_overlap|23P01|exclusion constraint/i.test(text);
};

/**
 * Move a booking and settle its request in ONE transaction. Safe to call again for the same
 * request and slot (returns alreadyApplied), and safe against concurrent callers: the request row
 * is locked, the booking is updated only if its version is unchanged, and the database itself
 * refuses overlapping classes for the tutor or the learner.
 */
export async function moveBooking(prisma: PrismaClient, input: MoveInput): Promise<MoveResult> {
  const now = input.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx): Promise<MoveResult> => {
      await tx.$queryRaw`SELECT id FROM reschedule_requests WHERE id = ${input.requestId} FOR UPDATE`;
      const request = await tx.rescheduleRequest.findUniqueOrThrow({ where: { id: input.requestId } });

      if (request.appliedToAt) {
        const same = request.bookingId === input.bookingId && request.appliedToAt.getTime() === input.toStartsAt.getTime();
        if (!same) return { ok: false, reason: "already_decided" };
        const b = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId } });
        return { ok: true, alreadyApplied: true, bookingId: b.id, fromAt: request.appliedFromAt ?? b.startsAt, toAt: request.appliedToAt, version: b.version, durationMin: b.durationMin };
      }
      if (request.decision === "rejected") return { ok: false, reason: "already_decided" };

      const before = await tx.booking.findUnique({ where: { id: input.bookingId } });
      if (!before) return { ok: false, reason: "not_found" };
      if (before.status === "cancelled") return { ok: false, reason: "cancelled" };

      const { count } = await tx.booking.updateMany({
        where: { id: input.bookingId, version: input.expectedVersion, status: { not: "cancelled" } },
        data: { startsAt: input.toStartsAt, status: "rescheduled", version: { increment: 1 }, lastMovedAt: now },
      });
      if (count !== 1) return { ok: false, reason: "stale" };

      await tx.rescheduleRequest.update({
        where: { id: input.requestId },
        data: { bookingId: input.bookingId, decision: input.decision, decidedBy: input.decidedBy, appliedFromAt: before.startsAt, appliedToAt: input.toStartsAt },
      });
      return { ok: true, alreadyApplied: false, bookingId: before.id, fromAt: before.startsAt, toAt: input.toStartsAt, version: before.version + 1, durationMin: before.durationMin };
    });
  } catch (err) {
    if (isOverlap(err)) return { ok: false, reason: "slot_taken" };
    // Prisma wraps driver errors; surface anything that is not an overlap untouched.
    if (err instanceof Prisma.PrismaClientKnownRequestError && isOverlap(err.meta)) return { ok: false, reason: "slot_taken" };
    throw err;
  }
}
