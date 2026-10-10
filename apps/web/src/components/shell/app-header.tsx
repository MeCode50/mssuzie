import Link from "next/link";
import type { Actor } from "@/lib/session";
import { MainNav } from "./main-nav";
import { UserMenu } from "./user-menu";

export function AppHeader({ actor }: { actor: Actor }) {
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <Link href="/reschedules" className="flex items-center gap-2 rounded-md text-lg font-extrabold tracking-tight">
            <span aria-hidden="true" className="inline-block size-3 rounded-full bg-accent" />
            MsSuzie <span className="font-semibold text-muted">Copilot</span>
          </Link>
          <MainNav role={actor.role} />
        </div>
        <UserMenu name={actor.name} role={actor.role} />
      </div>
    </header>
  );
}
