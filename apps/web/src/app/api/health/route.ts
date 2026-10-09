import { handle, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + database reachability. No auth and no version details. */
export const GET = handle(
  async ({ c }) => {
    try {
      await c.prisma.$queryRaw`SELECT 1`;
      return json({ status: "ok", db: "ok", time: new Date().toISOString() });
    } catch {
      return json({ status: "degraded", db: "down", time: new Date().toISOString() }, { status: 503 });
    }
  },
  { skipOriginCheck: true },
);
