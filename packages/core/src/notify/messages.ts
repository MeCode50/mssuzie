import { formatWithZone } from "../scheduling/time";

export type MessageKind = "applied" | "proposal" | "confirmed" | "escalation" | "rejected";
export type MessageRole = "parent" | "tutor" | "ops";

export interface MessageContext {
  guardianFirstName: string;
  learnerFirstName: string;
  tutorFirstName: string;
  guardianZone: string;
  tutorZone: string;
  /** The class as it was (UTC), when known. */
  from?: Date;
  /** The new time (UTC), for applied / confirmed. */
  to?: Date;
  /** Offered times with their accept links, for proposals. */
  options?: { startsAt: Date; url: string }[];
  /** Why a person is needed (escalation) or a note from Ops (rejected). */
  reason?: string;
}

export interface RenderedMessage {
  subject: string;
  body: string;
}

const sign = (name: string) => `\nMsSuzie scheduling team on behalf of ${name}`;

/**
 * Plain, deterministic wording. No model writes these, so nothing a parent typed can steer an
 * email, and every time is shown in the reader's own zone.
 */
export function renderMessage(kind: MessageKind, role: MessageRole, c: MessageContext): RenderedMessage | null {
  const at = (d: Date | undefined, zone: string) => (d ? formatWithZone(d, zone) : "a time to be confirmed");
  const child = c.learnerFirstName;

  if (role === "parent") {
    switch (kind) {
      case "applied":
      case "confirmed":
        return {
          subject: `${child}'s class is moved to ${at(c.to, c.guardianZone)}`,
          body: `Hi ${c.guardianFirstName},\n\n${child}'s class with ${c.tutorFirstName} has been moved.\n\nWas: ${at(c.from, c.guardianZone)}\nNow: ${at(c.to, c.guardianZone)}\n\nIf this isn't right, just reply and we'll sort it out.\n${sign(c.tutorFirstName)}`,
        };
      case "proposal": {
        const lines = (c.options ?? []).map((o) => `  • ${at(o.startsAt, c.guardianZone)}\n    Choose this time: ${o.url}`).join("\n");
        return {
          subject: `Options for ${child}'s class`,
          body: `Hi ${c.guardianFirstName},\n\nThat exact time isn't available, but these are:\n\n${lines}\n\nEach link works once and expires in 48 hours. Nothing changes until you choose one.\n${sign(c.tutorFirstName)}`,
        };
      }
      case "escalation":
        return {
          subject: `We're looking at ${child}'s class change`,
          body: `Hi ${c.guardianFirstName},\n\nThanks for your message. A member of our team needs to look at this one personally, and will be in touch soon. Your current class time hasn't changed.\n${sign(c.tutorFirstName)}`,
        };
      case "rejected":
        return {
          subject: `About ${child}'s class change`,
          body: `Hi ${c.guardianFirstName},\n\nWe weren't able to make that change.${c.reason ? `\n\n${c.reason}` : ""}\n\nYour current class time stays as it is. Reply to this message if you'd like to talk it through.\n${sign(c.tutorFirstName)}`,
        };
    }
  }

  if (role === "tutor") {
    if (kind === "applied" || kind === "confirmed") {
      return {
        subject: `Class with ${child} moved to ${at(c.to, c.tutorZone)}`,
        body: `Hi ${c.tutorFirstName},\n\n${child}'s class has been moved at the family's request.\n\nWas: ${at(c.from, c.tutorZone)}\nNow: ${at(c.to, c.tutorZone)}\n\nYour calendar is updated.\n${sign(c.tutorFirstName)}`,
      };
    }
    return null;
  }

  // ops: an in-app note, not an email
  if (kind === "escalation") {
    return { subject: `Needs a person: ${child}'s class change`, body: c.reason ?? "The automatic check could not decide." };
  }
  return null;
}
