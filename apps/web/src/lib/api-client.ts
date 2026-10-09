/** Browser-side API helpers. Every failure becomes a short, kind, plain-language message. */

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

const OFFLINE = "We can't reach MsSuzie right now. Please check your connection and try again.";

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const { json, idempotencyKey, headers, ...rest } = init;
  const h = new Headers(headers);
  if (json !== undefined) h.set("content-type", "application/json");
  if (idempotencyKey) h.set("idempotency-key", idempotencyKey);
  let res: Response;
  try {
    res = await fetch(path, { ...rest, headers: h, body: json !== undefined ? JSON.stringify(json) : rest.body, credentials: "same-origin" });
  } catch {
    throw new ApiClientError(0, "offline", OFFLINE);
  }
  if (res.ok) return (await res.json()) as T;
  let message = "Something went wrong. Please try again.";
  let code = "unknown";
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    message = body.error?.message ?? message;
    code = body.error?.code ?? code;
  } catch {
    /* non-JSON error body: keep the generic message */
  }
  if (res.status === 401) message = "Your session has ended. Please sign in again.";
  throw new ApiClientError(res.status, code, message);
}

export interface CreatedRun {
  runId: string;
  sessionId: string;
  status: string;
  idempotentReplay: boolean;
}

export const createRun = (input: { learnerId: string; notes: string }, idempotencyKey: string) =>
  apiFetch<CreatedRun>("/api/sessions", { method: "POST", json: input, idempotencyKey });

export const retryRun = (runId: string) => apiFetch<{ runId: string; status: string }>(`/api/runs/${runId}/retry`, { method: "POST", json: {} });

export const approveParentUpdate = (id: string) =>
  apiFetch<{ id: string; status: string; approvedAt: string; approvedBy: string }>(`/api/parent-updates/${id}/approve`, { method: "POST", json: {} });

/**
 * One idempotency key per distinct request. The same learner + notes reuse the key (a double click or
 * a retry after a network error can never create two runs); changed content gets a fresh key.
 */
export function makeKeyKeeper(newKey: () => string = () => crypto.randomUUID()) {
  let last: { fingerprint: string; key: string } | null = null;
  return (learnerId: string, notes: string): string => {
    const fingerprint = `${learnerId}\n${notes}`;
    if (!last || last.fingerprint !== fingerprint) last = { fingerprint, key: newKey() };
    return last.key;
  };
}
