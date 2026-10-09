import { TOKEN_PATTERN, type TokenCategory, type TokenMap } from "./types.js";

/** Categories that may be put back into the parent-facing update. Contacts and schools never are. */
export const REINSERTABLE_CATEGORIES: readonly TokenCategory[] = ["CHILD", "GUARDIAN", "TUTOR"];

export function detokenize(
  text: string,
  tokenMap: TokenMap,
  categories: readonly TokenCategory[] = REINSERTABLE_CATEGORIES,
): { text: string; replaced: number } {
  let replaced = 0;
  const out = text.replace(TOKEN_PATTERN, (whole, category: string, _n: string) => {
    const original = tokenMap[whole];
    if (original === undefined || !categories.includes(category as TokenCategory)) return whole;
    replaced += 1;
    return original;
  });
  return { text: out, replaced };
}

/** Any token left in text (restored or not) is a defect for a parent-facing draft. */
export function findResidualTokens(text: string): string[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((m) => m[0]);
}
