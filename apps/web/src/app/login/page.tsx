import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { getPageActor } from "@/lib/page-session";
import { safeNext } from "@/lib/safe-next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await getPageActor()) redirect(next);

  return (
    <main id="main" className="mx-auto flex min-h-[70dvh] w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <p className="flex items-center justify-center gap-2 text-2xl font-extrabold tracking-tight">
          <span aria-hidden="true" className="inline-block size-3.5 rounded-full bg-accent" />
          MsSuzie <span className="font-semibold text-muted">Copilot</span>
        </p>
        <h1 className="mt-4 text-xl font-bold">Welcome back</h1>
        <p className="mt-1 text-muted">Sign in to turn session notes into progress, plans and parent updates.</p>
      </div>
      <Card>
        <LoginForm next={next} />
      </Card>
      <p className="mt-5 text-center text-sm text-muted">Accounts are created by the MsSuzie team. There is no public sign-up.</p>
    </main>
  );
}
