export const MAX_NOTES = 8000;

export type CounterTone = "ok" | "near" | "over";

export function counterState(length: number, max = MAX_NOTES): { tone: CounterTone; text: string; announce: string } {
  const label = `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`;
  if (length > max) {
    const over = length - max;
    return { tone: "over", text: `${label} · ${over.toLocaleString("en-US")} over the limit`, announce: `${over.toLocaleString("en-US")} characters over the limit. Please shorten the notes.` };
  }
  if (length >= max * 0.9) {
    const left = max - length;
    return { tone: "near", text: `${label} · ${left.toLocaleString("en-US")} left`, announce: `${left.toLocaleString("en-US")} characters left.` };
  }
  return { tone: "ok", text: label, announce: "" };
}
