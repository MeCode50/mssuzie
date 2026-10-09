import { randomUUID } from "node:crypto";
import { errorFields, type Logger } from "@mssuzie/core";
import { ZodError } from "zod";
import { getContainer, type Container } from "./container";
import { ApiError } from "./errors";
import { getClientIp } from "./ip";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RequestContext {
  req: Request;
  params: Record<string, string>;
  c: Container;
  log: Logger;
  requestId: string;
  ip: string;
  /** Handlers add ids (runId, userId) here; they are stamped on the access log line. */
  fields: Record<string, unknown>;
}

export type Handler = (ctx: RequestContext) => Promise<Response>;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, init);
}

export function errorResponse(err: ApiError): Response {
  return Response.json(
    { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
    { status: err.status, headers: err.headers },
  );
}

/**
 * Cross-site request protection for cookie-authenticated endpoints, on top of SameSite=Lax:
 * a state-changing request must come from our own origin (or a non-browser client).
 */
export function assertSameOrigin(req: Request, allowedOrigin: string | undefined): void {
  if (!UNSAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  const own = allowedOrigin ? new URL(allowedOrigin).origin : null;
  if (origin) {
    if (own && origin === own) return;
    throw new ApiError(403, "forbidden_origin", "This request didn't come from the MsSuzie app.");
  }
  if (fetchSite === "cross-site") {
    throw new ApiError(403, "forbidden_origin", "This request didn't come from the MsSuzie app.");
  }
}

function incomingRequestId(req: Request): string {
  const given = req.headers.get("x-request-id");
  return given && /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : randomUUID();
}

function toErrorResponse(err: unknown, log: Logger): Response {
  if (err instanceof ApiError) return errorResponse(err);
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? ` (${first.path.join(".")})` : "";
    return errorResponse(new ApiError(400, "validation_failed", `${first?.message ?? "The request wasn't valid"}${where}.`));
  }
  log.error("unhandled error in route", errorFields(err));
  return errorResponse(new ApiError(500, "internal_error", "Something went wrong on our side. Please try again."));
}

export interface HandleOptions {
  /** Skip the same-origin check (e.g. the auth catch-all, which Better Auth protects itself). */
  skipOriginCheck?: boolean;
}

/**
 * Wrap a route handler: request id, structured access log, same-origin check, plain-language JSON
 * errors with stable codes, and no-store caching. Request bodies are never logged.
 */
export function handle(handler: Handler, options: HandleOptions = {}) {
  return async (
    req: Request,
    routeCtx?: { params?: Promise<Record<string, string | string[] | undefined>> },
  ): Promise<Response> => {
    const started = Date.now();
    const c = getContainer();
    const requestId = incomingRequestId(req);
    const url = new URL(req.url);
    const fields: Record<string, unknown> = {};
    const log = c.logger.child({ requestId });
    let response: Response;
    try {
      if (!options.skipOriginCheck) assertSameOrigin(req, c.env.BETTER_AUTH_URL);
      const params = stringParams(routeCtx?.params ? await routeCtx.params : {});
      response = await handler({ req, params, c, log, requestId, ip: getClientIp(req.headers), fields });
    } catch (err) {
      response = toErrorResponse(err, log);
    }
    response.headers.set("x-request-id", requestId);
    if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
    log.info("request", {
      method: req.method, path: url.pathname, status: response.status, durationMs: Date.now() - started, ...fields,
    });
    return response;
  };
}

/** Dynamic segments (`[id]`) arrive as strings; catch-all segments as arrays, which we do not use. */
function stringParams(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
}
