import Link from "next/link";
import type { Actor } from "@/lib/session";
import { UserMenu } from "./user-menu";

export function AppHeader({ actor }: { actor: Actor }) {
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 rounded-md text-lg font-extrabold tracking-tight">
            <span aria-hidden="true" className="inline-block size-3 rounded-full bg-accent" />
            MsSuzie <span className="font-semibold text-muted">Copilot</span>
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <Link href="/sessions/new" className="rounded-full px-3 py-2 text-sm font-semibold hover:bg-accent-soft">
              New session
            </Link>
          </nav>
        </div>
        <UserMenu name={actor.name} role={actor.role} />
      </div>
    </header>
  );
}
