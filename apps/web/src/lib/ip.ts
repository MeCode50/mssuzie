/**
 * Client IP for rate limiting, behind a reverse proxy (Coolify's Traefik).
 *
 * A client can put anything it likes in X-Forwarded-For, but each trusted proxy APPENDS the address it
 * actually saw. So the leftmost entries are attacker-controlled and the entry `proxyHops` from the right
 * is the real client. Without X-Forwarded-For (local runs, tests) X-Real-IP is used.
 */
export function getClientIp(headers: Headers, proxyHops = 1): string {
  const hops = headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  if (hops.length > 0) return hops[Math.max(0, hops.length - Math.max(1, proxyHops))] ?? "unknown";
  return headers.get("x-real-ip")?.split(",")[0]?.trim() || "unknown";
}
