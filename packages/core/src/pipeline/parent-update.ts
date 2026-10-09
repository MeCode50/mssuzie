import {
  detokenize, findResidualTokens, findUnexpectedPii,
  type KnownEntities, type TokenMap,
} from "../agents/privacy-guard/index.js";
import type { ParentReport } from "../schemas/index.js";

/** Tokenised draft; the greeting and sign-off are fixed text, not model output. */
export function assembleTemplate(r: ParentReport): string {
  return [
    "Hi [GUARDIAN_1],",
    "",
    r.headline.trim(),
    "",
    "What went well:",
    ...r.wins.map((w) => `- ${w.trim()}`),
    "",
    `Focus for the next two weeks: ${r.focusNext.trim()}`,
    "",
    `One thing to try at home: ${r.oneThingAtHome.trim()}`,
    "",
    "Warm regards,",
    "The MsSuzie team",
  ].join("\n");
}

export type FinalizeResult = { ok: true; body: string } | { ok: false; problems: string[] };

/**
 * Put real names back ONLY into the parent update, then verify: no token left, no contact
 * detail, school, city, surname or other name. The check runs on the final text.
 */
export function finalizeParentUpdate(template: string, tokenMap: TokenMap, known: KnownEntities): FinalizeResult {
  const { text } = detokenize(template, tokenMap);
  const restored = Object.entries(tokenMap)
    .filter(([token]) => /^\[(CHILD|GUARDIAN|TUTOR)_\d+\]$/.test(token))
    .map(([, name]) => name);
  const problems = [
    ...findResidualTokens(text).map((t) => `unresolved token ${t}`),
    ...findUnexpectedPii(text, known, restored),
  ];
  return problems.length === 0 ? { ok: true, body: text } : { ok: false, problems };
}
