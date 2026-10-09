import { overlaps, type Span } from "./matching";
import type { TokenRegistry } from "./registry";
import type { TokenCategory } from "./types";

export interface Match extends Span {
  priority: number;
  category: TokenCategory;
  key: string;
  original: string;
}

/** Lower priority wins; ties go to the longer match. Overlapping losers are dropped. */
export function resolveOverlaps(matches: Match[]): Match[] {
  const ranked = [...matches].sort(
    (a, b) => a.priority - b.priority || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const accepted: Match[] = [];
  for (const m of ranked) {
    if (!accepted.some((a) => overlaps(a, m))) accepted.push(m);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/**
 * Replace all matches in ONE pass over the original text, so inserted tokens can never be
 * matched again. Tokens are numbered in order of appearance.
 */
export function applyMatches(
  text: string,
  matches: Match[],
  registry: TokenRegistry,
  source: "code" | "llm",
): string {
  let out = "";
  let cursor = 0;
  for (const m of resolveOverlaps(matches)) {
    const token = registry.tokenFor(m.category, m.key, m.original, source);
    registry.count(token);
    out += text.slice(cursor, m.start) + token;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}
