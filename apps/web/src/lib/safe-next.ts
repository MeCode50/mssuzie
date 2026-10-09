/** Only same-site relative paths may be used as a post-login destination (no open redirects). */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.includes("://")) return "/";
  if (value.startsWith("/login")) return "/";
  return value;
}
