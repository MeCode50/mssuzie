import { z } from "zod";
import { humanize } from "@/lib/display";
import { handle, json } from "@/lib/http";
import { requireOps } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  status: z.enum(["open", "resolved", "all"], { message: "status must be open, resolved or all" }).default("open"),
});

/** The alerts inbox (ops): refund-risk alerts with reason and intervention, high severity first. */
export const GET = handle(async (ctx) => {
  await requireOps(ctx);
  const { status } = QuerySchema.parse({ status: new URL(ctx.req.url).searchParams.get("status") ?? undefined });
  const { prisma } = ctx.c;

  const [rows, openCount] = await Promise.all([
    prisma.alert.findMany({
      where: status === "all" ? {} : { status },
      include: { learner: { select: { id: true, displayName: true, currentStatus: true, tutor: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.alert.count({ where: { status: "open" } }),
  ]);
  const alerts = rows
    .sort((a, b) => Number(b.severity === "high") - Number(a.severity === "high") || b.createdAt.getTime() - a.createdAt.getTime())
    .map((a) => ({
      id: a.id, type: a.type, severity: a.severity, status: a.status, createdAt: a.createdAt, runId: a.runId,
      reason: humanize(a.reason), intervention: humanize(a.intervention),
      resolvedAt: a.resolvedAt, resolutionNote: a.resolutionNote,
      learner: { id: a.learner.id, displayName: a.learner.displayName, status: a.learner.currentStatus, tutorName: a.learner.tutor.name },
    }));
  return json({ alerts, openCount });
});
