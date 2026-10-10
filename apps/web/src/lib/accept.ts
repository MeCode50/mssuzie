import { checkActionToken, confirmSlot, consumeRateLimit, formatWithZone, type ConfirmRefusal } from "@mssuzie/core";
import { z } from "zod";
import { ApiError } from "./errors";
import type { Container } from "./container";
import type { RequestContext } from "./http";

export const AcceptSchema = z.object({ token: z.string().min(10, "This link isn't valid.").max(200, "This link isn't valid.") });

const INVALID = "This link isn't valid. Please reply to our email and we'll help you.";
const BAD_TOKEN: Record<string, { status: number; message: string }> = {
  malformed: { status: 400, message: INVALID },
  bad_signature: { status: 400, message: INVALID },
  unknown: { status: 400, message: INVALID },
  expired: { status: 410, message: "This link has expired. Please reply to our email and we'll find a time that works." },
  used: { status: 410, message: "This link has already been used, or a time has already been chosen for this class." },
};
const GONE: Partial<Record<ConfirmRefusal, string>> = {
  slot_unavailable: "That time has just been taken, so we've left the class where it was. Please reply to our email and we'll find another time.",
  slot_taken: "That time has just been taken, so we've left the class where it was. Please reply to our email and we'll find another time.",
  stale: "The class changed a moment ago, so nothing was moved. Please reply to our email and we'll help.",
  not_open: "A time has already been chosen for this class.",
  cancelled: "That class has been cancelled, so nothing was moved.",
};

export interface AcceptPreview {
  valid: true;
  learnerFirstName: string;
  tutorFirstName: string;
  guardianFirstName: string;
  /** The offered time, in the parent's own zone. */
  newTime: string;
  /** The class as it stands now, in the parent's zone. */
  currentTime: string | null;
}

/** What the confirmation page shows. Never consumes the link (so email scanners that open it cannot use it up). */
export async function previewAccept(c: Pick<Container, "prisma" | "env">, token: string): Promise<AcceptPreview | { valid: false; message: string }> {
  const secret = c.env.ACTION_LINK_SECRET;
  if (!secret) return { valid: false, message: "This page isn't available right now. Please reply to our email and we'll help." };
  const check = await checkActionToken(c.prisma, secret, token);
  if (!check.ok) return { valid: false, message: (BAD_TOKEN[check.reason] ?? BAD_TOKEN.unknown!).message };
  const request = await c.prisma.rescheduleRequest.findUnique({
    where: { id: check.requestId },
    include: { booking: true, guardian: { include: { learner: { include: { tutor: true } } } } },
  });
  if (!request || request.decision !== "proposed") return { valid: false, message: BAD_TOKEN.used!.message };
  const zone = request.guardian.timezone;
  const first = (n: string) => n.split(" ")[0] ?? n;
  return {
    valid: true,
    learnerFirstName: first(request.guardian.learner.displayName), tutorFirstName: first(request.guardian.learner.tutor.name), guardianFirstName: first(request.guardian.name),
    newTime: formatWithZone(check.slotStartsAt, zone),
    currentTime: request.booking ? formatWithZone(request.booking.startsAt, zone) : null,
  };
}

/** The parent pressed "Yes, move it". Public (the link is the credential), so it is rate limited per address. */
export async function acceptFromLink(ctx: RequestContext, token: string) {
  const { c, ip } = ctx;
  const secret = c.env.ACTION_LINK_SECRET;
  if (!secret) throw new ApiError(503, "internal_error", "This page isn't available right now. Please reply to our email and we'll help.");
  const limited = await consumeRateLimit(c.prisma, { key: `ip:${ip}:accept`, limit: 20, windowMs: 600_000 });
  if (!limited.allowed) throw new ApiError(429, "rate_limited", "That's a lot of tries. Please wait a few minutes.", { "retry-after": String(limited.retryAfterSec) });

  const check = await checkActionToken(c.prisma, secret, token);
  if (!check.ok) {
    const e = BAD_TOKEN[check.reason] ?? BAD_TOKEN.unknown!;
    // "used" right after a success is the double-click case: still tell the truth, kindly.
    throw new ApiError(e.status, "conflict", e.message);
  }
  const res = await confirmSlot(
    { prisma: c.prisma, ...c.integrations, minNoticeHours: c.env.RESCHEDULE_MIN_NOTICE_HOURS },
    { requestId: check.requestId, startsAt: check.slotStartsAt, actor: { kind: "parent_link", tokenId: check.tokenId } },
  );
  if (!res.ok) throw new ApiError(409, "conflict", GONE[res.reason] ?? "We couldn't move the class. Please reply to our email and we'll help.");
  const request = await c.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: check.requestId }, include: { guardian: true } });
  return { ok: true, newTime: formatWithZone(check.slotStartsAt, request.guardian.timezone), alreadyApplied: res.alreadyApplied };
}
