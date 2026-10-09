import { z } from "zod";

export const TOKEN_CATEGORIES = [
  "CHILD", "GUARDIAN", "TUTOR", "SCHOOL", "CITY",
  "EMAIL", "PHONE", "PERSON", "ORG", "LOCATION", "OTHER",
] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/** Matches tokens such as [CHILD_1]. Used for restoring, neutralising and leak checks. */
export const TOKEN_PATTERN = /\[([A-Z]+)_(\d+)\]/g;

export const MAX_NOTES_CHARS = 8000;

export const RedactionLogEntrySchema = z.object({
  token: z.string().regex(/^\[[A-Z]+_\d+\]$/),
  category: z.enum(TOKEN_CATEGORIES),
  source: z.enum(["code", "llm"]),
  occurrences: z.number().int().positive(),
});
export type RedactionLogEntry = z.infer<typeof RedactionLogEntrySchema>;

/** What is stored in run_steps.output_json. Deliberately contains no original values. */
export const GuardOutputSchema = z.object({
  redactedNotes: z.string().min(1).max(MAX_NOTES_CHARS * 2),
  redactionLog: z.array(RedactionLogEntrySchema),
  llmFindingsIgnored: z.number().int().nonnegative(),
});
export type GuardOutput = z.infer<typeof GuardOutputSchema>;

/** token -> original value. Sensitive: encrypt before storing, never log, never send to a model. */
export const TokenMapSchema = z.record(z.string().regex(/^\[[A-Z]+_\d+\]$/), z.string());
export type TokenMap = z.infer<typeof TokenMapSchema>;

export interface KnownEntities {
  learnerName: string;
  guardianNames: string[];
  guardianEmails: string[];
  guardianPhones: string[];
  tutorName: string;
  schools: string[];
  cities: string[];
}

export class GuardError extends Error {
  constructor(
    readonly code: "NOTES_EMPTY" | "NOTES_TOO_LONG" | "LLM_PASS_FAILED" | "RESIDUAL_PII",
    message: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
}
