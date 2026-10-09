import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getContainer } from "./container";
import type { Actor } from "./session";

/** The signed-in user for a page render, or null. Reads the session cookie via Better Auth. */
export async function getPageActor(): Promise<Actor | null> {
  const session = await getContainer().auth.api.getSession({ headers: await headers() });
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session || (role !== "ops" && role !== "tutor")) return null;
  return { id: session.user.id, name: session.user.name, email: session.user.email, role };
}

/** Pages behind sign-in call this first; a stale or missing session sends the visitor to the login page. */
export async function requirePageActor(): Promise<Actor> {
  const actor = await getPageActor();
  if (!actor) redirect("/login");
  return actor;
}
