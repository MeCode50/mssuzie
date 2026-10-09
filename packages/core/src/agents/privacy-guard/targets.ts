import type { TokenRegistry } from "./registry";
import type { KnownEntities, TokenCategory } from "./types";

export interface Target {
  surface: string;
  category: TokenCategory;
  entityKey: string;
  canonical: string;
}

const NAME_PARTICLES = new Set(["de", "da", "di", "do", "dos", "van", "von", "la", "le", "el", "al", "bin", "bint"]);
const GENERIC_SUFFIXES = new Set([
  "primary", "school", "academy", "college", "high", "junior", "infants", "secondary", "nursery",
]);

function personTargets(
  fullName: string, category: TokenCategory, entityKey: string,
): Target[] {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const canonical = parts[0] ?? fullName;
  const surfaces = new Set<string>([fullName.trim()]);
  for (const p of parts) {
    if (p.length >= 2 && !NAME_PARTICLES.has(p.toLowerCase())) surfaces.add(p);
  }
  return [...surfaces].map((surface) => ({ surface, category, entityKey, canonical }));
}

function placeTargets(name: string, category: TokenCategory, entityKey: string): Target[] {
  const words = name.trim().split(/\s+/);
  const surfaces = new Set<string>([name.trim()]);
  const last = words.at(-1)?.toLowerCase() ?? "";
  if (words.length > 1 && GENERIC_SUFFIXES.has(last)) {
    const short = words.slice(0, -1).join(" ");
    if (short.length >= 4) surfaces.add(short);
  }
  return [...surfaces].map((surface) => ({ surface, category, entityKey, canonical: name.trim() }));
}

/**
 * Every surface form we know must be redacted. Order matters for ambiguous surfaces (a shared
 * surname): guardians first, so "Mrs Okafor" maps to the guardian, not the child.
 */
export function buildTargets(known: KnownEntities): Target[] {
  const targets: Target[] = [];
  known.guardianNames.forEach((n, i) => targets.push(...personTargets(n, "GUARDIAN", `guardian:${i}`)));
  targets.push(...personTargets(known.tutorName, "TUTOR", "tutor"));
  targets.push(...personTargets(known.learnerName, "CHILD", "child"));
  known.schools.forEach((s, i) => targets.push(...placeTargets(s, "SCHOOL", `school:${i}`)));
  known.cities.forEach((c, i) => targets.push(...placeTargets(c, "CITY", `city:${i}`)));

  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = t.surface.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Hand out tokens for every known entity up front, by record order: the child is always [CHILD_1],
 * the first guardian [GUARDIAN_1], and so on, whether or not the notes mention them. Downstream
 * agents can then rely on these tokens, and every field redacted for a run numbers them the same.
 */
export function preregisterKnown(registry: TokenRegistry, known: KnownEntities): void {
  const first = (full: string) => full.trim().split(/\s+/)[0] ?? full;
  registry.tokenFor("CHILD", "child", first(known.learnerName), "code");
  known.guardianNames.forEach((n, i) => registry.tokenFor("GUARDIAN", `guardian:${i}`, first(n), "code"));
  registry.tokenFor("TUTOR", "tutor", first(known.tutorName), "code");
  known.schools.forEach((s, i) => registry.tokenFor("SCHOOL", `school:${i}`, s.trim(), "code"));
  known.cities.forEach((c, i) => registry.tokenFor("CITY", `city:${i}`, c.trim(), "code"));
}
