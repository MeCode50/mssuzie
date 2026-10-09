import { MAX_NOTES_CHARS } from "@mssuzie/core";
import { z } from "zod";

export const UuidSchema = z.string().uuid();

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

const DAY_MS = 86_400_000;

export const CreateSessionSchema = z.object({
  learnerId: UuidSchema,
  notes: z
    .string()
    .transform((s) => s.normalize("NFC").replace(/\u0000/g, "").trim())
    .pipe(
      z
        .string()
        .min(1, "Please paste the session notes.")
        .max(MAX_NOTES_CHARS, `Notes can be at most ${MAX_NOTES_CHARS.toLocaleString("en-US")} characters.`),
    ),
  heldAt: z
    .string()
    .datetime({ message: "heldAt must be an ISO date-time" })
    .transform((s) => new Date(s))
    .refine((d) => d.getTime() > Date.now() - 30 * DAY_MS && d.getTime() < Date.now() + 3_600_000, {
      message: "The session date must be within the last 30 days.",
    })
    .optional(),
  durationMin: z.number().int().min(5).max(240).optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;
