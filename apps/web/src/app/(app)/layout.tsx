import type { ReactNode } from "react";
import { AppHeader } from "@/components/shell/app-header";
import { requirePageActor } from "@/lib/page-session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requirePageActor();
  return (
    <>
      <AppHeader actor={actor} />
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>
    </>
  );
}
