import { toNextJsHandler } from "better-auth/next-js";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Better Auth runs its own origin/CSRF and rate-limit checks, so our same-origin wrapper is skipped.
// Its login throttle keys on the client address, so give it the address we trust (never a client-sent one).
const run = (method: "GET" | "POST") =>
  handle(
    async ({ req, c, ip }) => {
      const headers = new Headers(req.headers);
      headers.set("x-client-ip", ip);
      return toNextJsHandler(c.auth)[method](new Request(req, { headers }));
    },
    { skipOriginCheck: true },
  );

export const GET = run("GET");
export const POST = run("POST");
