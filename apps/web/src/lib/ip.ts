/**
 * Client IP for rate limiting. Prefer headers the hosting platform sets itself (they cannot be
 * forged by the client behind that platform); fall back to the first X-Forwarded-For hop.
 */
export function getClientIp(headers: Headers): string {
  const platform = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (platform) return platform.split(",")[0]?.trim() || "unknown";
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
