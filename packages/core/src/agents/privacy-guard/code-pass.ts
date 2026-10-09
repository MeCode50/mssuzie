import { applyMatches, type Match } from "./apply.js";
import { EMAIL_RE, findAll, findPhones, overlaps, termRegex, tokenSpans } from "./matching.js";
import type { TokenRegistry } from "./registry.js";
import { buildTargets } from "./targets.js";
import { TOKEN_PATTERN, type KnownEntities } from "./types.js";

/** Stop notes from smuggling in fake tokens that a later restore step might trust. */
export function neutraliseTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, "($1_$2)");
}

function collectMatches(text: string, known: KnownEntities): Match[] {
  const matches: Match[] = [];
  for (const s of findAll(text, EMAIL_RE)) {
    const original = text.slice(s.start, s.end);
    matches.push({ ...s, priority: 0, category: "EMAIL", key: original.toLowerCase(), original });
  }
  for (const s of findPhones(text)) {
    matches.push({
      start: s.start, end: s.end, priority: 1, category: "PHONE", key: s.digits,
      original: text.slice(s.start, s.end),
    });
  }
  for (const t of buildTargets(known)) {
    for (const s of findAll(text, termRegex(t.surface))) {
      matches.push({ ...s, priority: 2, category: t.category, key: t.entityKey, original: t.canonical });
    }
  }
  return matches;
}

/** Deterministic pass: contacts by pattern, then every known name/school/city. */
export function redactWithCode(text: string, known: KnownEntities, registry: TokenRegistry): string {
  return applyMatches(text, collectMatches(text, known), registry, "code");
}

/** Contacts the guardian record holds, as digit strings / lowercase emails. */
function knownContactKeys(known: KnownEntities): Set<string> {
  return new Set([
    ...known.guardianEmails.map((e) => e.toLowerCase()),
    ...known.guardianPhones.map((p) => p.replace(/\D/g, "")),
  ]);
}

/** Defence in depth: after redaction nothing we know about may remain. Returns what leaked. */
export function findResidualKnownPii(text: string, known: KnownEntities): string[] {
  const protectedSpans = tokenSpans(text);
  const contacts = knownContactKeys(known);
  const leaks: string[] = [];
  for (const m of collectMatches(text, known)) {
    if (protectedSpans.some((p) => overlaps(p, m))) continue;
    leaks.push(m.category);
  }
  for (const phone of findPhones(text)) {
    if (contacts.has(phone.digits)) leaks.push("PHONE");
  }
  return [...new Set(leaks)].map((c) => `${c} remained after redaction`);
}
