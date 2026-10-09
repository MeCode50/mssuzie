import { applyMatches, type Match } from "./apply";
import { EMAIL_RE, fold, findAll, findPhones, overlaps, termRegex, tokenSpans } from "./matching";
import type { TokenRegistry } from "./registry";
import { buildTargets } from "./targets";
import { TOKEN_PATTERN, type KnownEntities } from "./types";

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

/**
 * Final check for a text that has had real names put back (the parent update). Allowed: the
 * first names we restored on purpose. Not allowed: any contact detail, school, city, surname,
 * or full name. Returns category-only descriptions, never the matched text.
 */
export function findUnexpectedPii(text: string, known: KnownEntities, allowedFirstNames: string[]): string[] {
  const allowed = new Set(allowedFirstNames.map(fold));
  const leaks: string[] = [];
  for (const m of collectMatches(text, known)) {
    const isPerson = m.category === "CHILD" || m.category === "GUARDIAN" || m.category === "TUTOR";
    if (isPerson && allowed.has(fold(text.slice(m.start, m.end)))) continue;
    leaks.push(`${m.category} found in draft`);
  }
  return [...new Set(leaks)];
}
