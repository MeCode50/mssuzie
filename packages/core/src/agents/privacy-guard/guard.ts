import type { LlmUsage } from "../../llm/structured.js";
import { applyFindings, type PiiDetector } from "./llm-pass.js";
import { findResidualKnownPii, neutraliseTokens, redactWithCode } from "./code-pass.js";
import { TokenRegistry } from "./registry.js";
import {
  GuardError, GuardOutputSchema, MAX_NOTES_CHARS,
  type GuardOutput, type KnownEntities, type TokenMap,
} from "./types.js";

export interface GuardResult {
  /** Safe to store in run_steps.output_json and to send to models. */
  output: GuardOutput;
  /** Sensitive. Encrypt before storing; never log; never send to a model. */
  tokenMap: TokenMap;
  llmUsage: LlmUsage | null;
}

export interface GuardInput {
  notes: string;
  known: KnownEntities;
  detector: PiiDetector;
}

function validateNotes(notes: string): string {
  const text = notes.normalize("NFC").trim();
  if (text.length === 0) throw new GuardError("NOTES_EMPTY", "Session notes are empty.");
  if (text.length > MAX_NOTES_CHARS) {
    throw new GuardError("NOTES_TOO_LONG", `Session notes exceed ${MAX_NOTES_CHARS} characters.`);
  }
  return text;
}

/**
 * Privacy Guard: code first (contacts + every known name), then a small-model pass over the
 * ALREADY-redacted text for anything missed, then a final leak check. Fails closed: if the model
 * pass fails, no redacted notes are produced and nothing downstream can run.
 */
export async function runPrivacyGuard(input: GuardInput): Promise<GuardResult> {
  const original = validateNotes(input.notes);
  const registry = new TokenRegistry();
  const afterCode = redactWithCode(neutraliseTokens(original), input.known, registry);

  let detection;
  try {
    detection = await input.detector(afterCode);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GuardError("LLM_PASS_FAILED", `Privacy model pass failed; refusing to continue: ${reason}`);
  }

  const applied = applyFindings(afterCode, detection.findings, registry);
  const leaks = findResidualKnownPii(applied.text, input.known);
  if (leaks.length > 0) throw new GuardError("RESIDUAL_PII", `Redaction check failed: ${leaks.join("; ")}`);

  const output = GuardOutputSchema.parse({
    redactedNotes: applied.text,
    redactionLog: registry.getLog(),
    llmFindingsIgnored: applied.ignored,
  });
  return { output, tokenMap: registry.getTokenMap(), llmUsage: detection.usage };
}
