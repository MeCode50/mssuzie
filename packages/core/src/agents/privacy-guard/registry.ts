import type { RedactionLogEntry, TokenCategory, TokenMap } from "./types.js";

interface LogState {
  category: TokenCategory;
  source: "code" | "llm";
  occurrences: number;
}

/** Hands out stable tokens: the same entity always gets the same token within one run. */
export class TokenRegistry {
  private readonly counters = new Map<TokenCategory, number>();
  private readonly tokenByKey = new Map<string, string>();
  private readonly tokenMap: TokenMap = {};
  private readonly log = new Map<string, LogState>();

  tokenFor(category: TokenCategory, key: string, original: string, source: "code" | "llm"): string {
    const fullKey = `${category}:${key}`;
    const existing = this.tokenByKey.get(fullKey);
    if (existing) return existing;
    const n = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, n);
    const token = `[${category}_${n}]`;
    this.tokenByKey.set(fullKey, token);
    this.tokenMap[token] = original;
    this.log.set(token, { category, source, occurrences: 0 });
    return token;
  }

  count(token: string): void {
    const entry = this.log.get(token);
    if (entry) entry.occurrences += 1;
  }

  getTokenMap(): TokenMap {
    return { ...this.tokenMap };
  }

  getLog(): RedactionLogEntry[] {
    return [...this.log.entries()]
      .filter(([, v]) => v.occurrences > 0)
      .map(([token, v]) => ({ token, ...v }));
  }
}
