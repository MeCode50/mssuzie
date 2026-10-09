export type ErrorCode =
  | "unauthenticated" | "forbidden" | "forbidden_origin" | "not_found" | "validation_failed"
  | "payload_too_large" | "unsupported_media_type" | "idempotency_key_required" | "idempotency_conflict"
  | "conflict" | "rate_limited" | "daily_budget_reached" | "internal_error";

/** An error whose message is safe and kind to show a user. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const errors = {
  unauthenticated: () => new ApiError(401, "unauthenticated", "Please sign in to continue."),
  forbidden: (message = "You don't have access to this.") => new ApiError(403, "forbidden", message),
  notFound: (what = "That item") => new ApiError(404, "not_found", `${what} could not be found.`),
  validation: (message: string, details?: unknown) => new ApiError(400, "validation_failed", message, {}, details),
  conflict: (message: string) => new ApiError(409, "conflict", message),
  rateLimited: (message: string, retryAfterSec: number) =>
    new ApiError(429, "rate_limited", message, { "retry-after": String(retryAfterSec) }),
};
