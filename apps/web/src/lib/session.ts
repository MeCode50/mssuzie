import type { Prisma } from "@mssuzie/core";
import { errors } from "./errors";
import type { RequestContext } from "./http";

export type Role = "ops" | "tutor";

export interface Actor {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** The signed-in user for this request, or a 401. Also stamps userId/role on the access log. */
export async function requireActor(ctx: RequestContext): Promise<Actor> {
  const session = await ctx.c.auth.api.getSession({ headers: ctx.req.headers });
  if (!session) throw errors.unauthenticated();
  const { id, name, email } = session.user;
  const role = (session.user as { role?: string }).role;
  if (role !== "ops" && role !== "tutor") throw errors.forbidden("Your account doesn't have a role yet. Please contact MsSuzie ops.");
  ctx.fields.userId = id;
  ctx.fields.role = role;
  return { id, name, email, role };
}

export async function requireOps(ctx: RequestContext): Promise<Actor> {
  const actor = await requireActor(ctx);
  if (actor.role !== "ops") throw errors.forbidden("Only the MsSuzie ops team can do this.");
  return actor;
}

/** Tutors only ever see their own learners; ops see everyone. */
export function learnerScope(actor: Actor): Prisma.LearnerWhereInput {
  return actor.role === "ops" ? {} : { tutorId: actor.id };
}
