const WORDS: Record<string, string> = {
  CHILD: "the learner", GUARDIAN: "their parent", TUTOR: "the tutor", SCHOOL: "their school", CITY: "their town",
};

/** Placeholder tokens (what the models saw) become plain words for people reading the UI. */
export function humanizeTokens(text: string): string {
  return text.replace(/\[([A-Z]+)_\d+\]/g, (_whole, category: string) => WORDS[category] ?? "someone");
}

/** Deep-map every string in a JSON-like value through humanizeTokens. */
export function humanize<T>(value: T): T {
  if (typeof value === "string") return humanizeTokens(value) as T;
  if (Array.isArray(value)) return value.map((v) => humanize(v)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, humanize(v)])) as T;
  }
  return value;
}
