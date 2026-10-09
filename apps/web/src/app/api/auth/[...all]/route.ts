import { toNextJsHandler } from "better-auth/next-js";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Better Auth runs its own origin/CSRF and rate-limit checks, so our same-origin wrapper is skipped.
const run = (method: "GET" | "POST") =>
  handle(async ({ req, c }) => toNextJsHandler(c.auth)[method](req), { skipOriginCheck: true });

export const GET = run("GET");
export const POST = run("POST");
