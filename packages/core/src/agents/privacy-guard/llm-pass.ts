import { z } from "zod";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../../llm/untrusted";
import { runStructured, type LlmExecutor, type LlmUsage } from "../../llm/structured";
import { applyMatches, type Match } from "./apply";
import { fold, findAll, overlaps, termRegex, tokenSpans } from "./matching";
import type { TokenRegistry } from "./registry";
import type { TokenCategory } from "./types";

export const FindingSchema = z.object({
  text: z.string(),
  category: z.enum(["person", "school", "organisation", "location", "contact", "other"]),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsOutputSchema = z.object({
  findings: z.array(FindingSchema).max(50),
});

export interface DetectionResult {
  findings: Finding[];
  usage: LlmUsage;
}

/** Receives ONLY already-redacted text. Swapped for a fake in tests. */
export type PiiDetector = (redactedText: string) => Promise<DetectionResult>;

const INSTRUCTIONS = `You are a privacy filter for children's tutoring notes.
Names of the child, family, tutor, school and city, and all emails and phone numbers, have ALREADY been replaced by tokens such as [CHILD_1] or [SCHOOL_1].
Your only job is to list any REMAINING text that could identify a real person or place: personal names (teachers, friends, siblings, relatives, other pupils), schools, nurseries, clubs, employers, towns, streets, addresses, postcodes, social media handles, usernames, dates of birth.
Rules:
- Copy each finding EXACTLY as written in the notes (same spelling and capitalisation).
- Never list tokens in square brackets.
- Do not list generic words, school subjects, topics, skills, games, books, TV shows, brands or fictional characters.
- If nothing identifying remains, return an empty list.
${UNTRUSTED_DATA_RULE}`;

export function createLlmPiiDetector(
  execute: LlmExecutor,
  options: { model: string; maxTokens?: number },
): PiiDetector {
  return async (redactedText) => {
    const { output, usage } = await runStructured(execute, {
      name: "privacy_guard",
      instructions: INSTRUCTIONS,
      model: options.model,
      maxTokens: options.maxTokens ?? 800,
      schema: FindingsOutputSchema,
      input: `Find any remaining identifying text in these notes.\n\n${wrapUntrusted("tutor_notes", redactedText)}`,
    });
    return { findings: output.findings, usage };
  };
}

/** String-length limits live here, not in the schema, to keep the model-facing JSON schema strict-mode safe. */
function isUsableFinding(text: string): boolean {
  return text.length >= 2 && text.length <= 80 && !text.includes("[") && !text.includes("]");
}

const CATEGORY_MAP: Record<Finding["category"], TokenCategory> = {
  person: "PERSON", school: "SCHOOL", organisation: "ORG",
  location: "LOCATION", contact: "OTHER", other: "OTHER",
};

/**
 * Apply model findings. The model never edits the notes: we only redact exact, verbatim matches
 * that do not touch an existing token, so hallucinated or injected findings are inert.
 */
export function applyFindings(
  text: string,
  findings: Finding[],
  registry: TokenRegistry,
): { text: string; ignored: number } {
  const protectedSpans = tokenSpans(text);
  const matches: Match[] = [];
  let ignored = 0;
  const unique = new Map(findings.map((f) => [fold(f.text), f]));
  for (const [key, f] of unique) {
    const spans = !isUsableFinding(f.text)
      ? []
      : findAll(text, termRegex(f.text)).filter((s) => !protectedSpans.some((p) => overlaps(p, s)));
    if (spans.length === 0) ignored += 1;
    for (const s of spans) {
      matches.push({ ...s, priority: 3, category: CATEGORY_MAP[f.category], key, original: f.text });
    }
  }
  return { text: applyMatches(text, matches, registry, "llm"), ignored };
}
