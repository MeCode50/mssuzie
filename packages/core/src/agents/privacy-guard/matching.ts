const DIACRITIC_VARIANTS: Record<string, string> = {
  a: "aàáâãäåā", e: "eèéêëē", i: "iìíîïī", o: "oòóôõöøō",
  u: "uùúûüū", n: "nñ", c: "cç", s: "sš", z: "zž", y: "yýÿ",
};

const WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;

export function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/g, "'").trim();
}

function escapeChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`);
}

function charPattern(ch: string): string {
  if (/\s/.test(ch)) return String.raw`\s+`;
  if (ch === "'" || ch === "’") return "['’]";
  const variants = DIACRITIC_VARIANTS[fold(ch)];
  return variants ? `[${variants}]` : escapeChar(ch);
}

/** Case-, accent- and whitespace-insensitive whole-word pattern for a name/term. */
export function termRegex(term: string): RegExp {
  const body = [...term.normalize("NFC").trim()].map(charPattern).join("");
  return new RegExp(`${WORD_BEFORE}${body}${WORD_AFTER}`, "giu");
}

export interface Span {
  start: number;
  end: number;
}

export function findAll(text: string, re: RegExp): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(re)) {
    if (m.index !== undefined && m[0].length > 0) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

export const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;

const PHONE_CANDIDATE = /(?<![\w.])\+?\(?\d[\d\s().-]{6,}\d(?!\w)/g;
const US_STYLE = /^\d{3}[-. ]\d{3}[-. ]\d{4}$/;

/** True for strings that look like phone numbers; rejects score lists and dates. */
export function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return false;
  const trimmed = candidate.trim();
  if (/^[+(0]/.test(trimmed) || US_STYLE.test(trimmed)) return true;
  return /^\d{10,15}$/.test(trimmed);
}

export function findPhones(text: string): (Span & { digits: string })[] {
  const out: (Span & { digits: string })[] = [];
  for (const m of text.matchAll(PHONE_CANDIDATE)) {
    const raw = m[0];
    if (m.index === undefined || !looksLikePhone(raw)) continue;
    const trimmed = raw.replace(/[\s.-]+$/, "");
    out.push({ start: m.index, end: m.index + trimmed.length, digits: trimmed.replace(/\D/g, "") });
  }
  return out;
}

/** Spans of existing tokens, which later passes must never touch. */
export function tokenSpans(text: string): Span[] {
  return findAll(text, /\[[A-Z]+_\d+\]/g);
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}
