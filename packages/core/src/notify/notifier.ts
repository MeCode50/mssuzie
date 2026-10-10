import type { PrismaClient } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import type { MailResult } from "./mailer";
import { renderMessage, type MessageContext, type MessageKind, type MessageRole } from "./messages";

export interface Mailer {
  send(mail: { to: string; subject: string; text: string }): Promise<MailResult>;
}

export interface NotifyInput {
  requestId: string;
  kind: MessageKind;
  role: MessageRole;
  /** Real recipient address (ignored for in-app ops notes). */
  to?: string;
  context: MessageContext;
}

export interface NotifyOutcome {
  role: MessageRole;
  kind: MessageKind;
  status: "sent" | "failed" | "dry_run";
  /** True when this call found the message already recorded and did not send again. */
  alreadySent: boolean;
  error: string | null;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";

/**
 * Send one message and record it, at most once per (request, recipient role, kind). A message that
 * previously FAILED is tried again; one that was sent (or recorded as a dry run) never is.
 */
export async function notify(prisma: PrismaClient, mailer: Mailer, input: NotifyInput): Promise<NotifyOutcome | null> {
  const rendered = renderMessage(input.kind, input.role, input.context);
  if (!rendered) return null;
  const key = { requestId: input.requestId, toRole: input.role, kind: input.kind } as const;
  const where = { requestId_toRole_kind: key };
  const outcome = (status: NotifyOutcome["status"], alreadySent: boolean, error: string | null): NotifyOutcome => ({ role: input.role, kind: input.kind, status, alreadySent, error });

  const existing = await prisma.notification.findUnique({ where });
  if (existing && existing.status !== "failed") return outcome(existing.status, true, null);

  // In-app note for Ops: nothing to deliver.
  if (input.role === "ops") {
    const data = { ...key, subject: rendered.subject, body: rendered.body, status: "sent" as const, toEmail: null, intendedEmail: null };
    await prisma.notification.upsert({ where, create: data, update: { ...data, error: null } });
    return outcome("sent", false, null);
  }

  // Claim the slot first so a crash mid-send leaves a visible "failed" row (retried next time),
  // and two writers cannot both send.
  if (!existing) {
    try {
      await prisma.notification.create({ data: { ...key, subject: rendered.subject, body: rendered.body, status: "failed", error: "Sending was started but did not finish." } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another writer claimed it first and is (or was) sending.
      const raced = await prisma.notification.findUniqueOrThrow({ where });
      return outcome(raced.status, true, null);
    }
  }

  const result = input.to
    ? await mailer.send({ to: input.to, subject: rendered.subject, text: rendered.body })
    : ({ status: "failed", deliveredTo: null, intendedTo: null, subject: rendered.subject, body: rendered.body, messageId: null, error: "There is no email address for this person." } satisfies MailResult);

  const data: Prisma.NotificationUpdateInput = {
    subject: result.subject, body: result.body, status: result.status, toEmail: result.deliveredTo,
    intendedEmail: result.intendedTo ?? (result.deliveredTo ? null : input.to ?? null),
    providerMessageId: result.messageId, error: result.error,
  };
  await prisma.notification.update({ where, data });
  return outcome(result.status, false, result.error);
}
