import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// /r/accept is the page a parent reaches from an email link: the single-use signed token is the credential.
const PUBLIC_PATHS = new Set(["/login", "/r/accept"]);

/** Content-Security-Policy with a fresh nonce per request: no inline script is allowed without it. */
export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Tailwind ships a stylesheet; React inline style attributes need 'unsafe-inline' (nonces do not apply to attributes).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/**
 * Runs before every page request (not the API): sets the nonce-based CSP and sends signed-out
 * visitors to the login page. The cookie check is only a fast path; every page still validates the
 * session on the server.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (!PUBLIC_PATHS.has(pathname) && !getSessionCookie(request)) {
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Pages only: skip the API, static assets and image optimisation.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
