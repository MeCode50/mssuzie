export type LlmFailureKind = "rate_limited" | "unavailable" | "timeout" | "auth" | "bad_request" | "unknown";

const MESSAGES: Record<LlmFailureKind, string> = {
  rate_limited: "The AI service hit its rate limit or quota. Please try again in a few minutes.",
  unavailable: "The AI service is busy or unavailable right now. Please retry shortly.",
  timeout: "The AI service took too long to answer. Please retry.",
  auth: "The AI service rejected our credentials. An admin needs to check the API key.",
  bad_request: "The AI service rejected the request.",
  unknown: "The AI service returned an unexpected error.",
};

/** A model-provider failure with a message that is safe to show to ops staff. */
export class LlmServiceError extends Error {
  constructor(
    readonly kind: LlmFailureKind,
    readonly status?: number,
  ) {
    super(`${MESSAGES[kind]}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "LlmServiceError";
  }
}

export function kindForStatus(status: number): LlmFailureKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** Find an LlmServiceError anywhere in an error's cause chain (the OpenAI client wraps fetch errors). */
export function findServiceError(err: unknown): LlmServiceError | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof LlmServiceError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
