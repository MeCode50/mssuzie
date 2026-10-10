import type { Metadata } from "next";
import { AcceptButton } from "@/components/accept/accept-button";
import { Card } from "@/components/ui/card";
import { previewAccept } from "@/lib/accept";
import { getContainer } from "@/lib/container";

export const metadata: Metadata = { title: "Choose a class time" };
export const dynamic = "force-dynamic";

/** The page a parent reaches from the email. Opening it changes nothing: only the button does. */
export default async function AcceptPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const preview = token ? await previewAccept(getContainer(), token) : { valid: false as const, message: "This link isn't valid. Please reply to our email and we'll help you." };

  return (
    <main id="main" className="mx-auto flex min-h-[70dvh] w-full max-w-lg flex-col justify-center px-4 py-10">
      <p className="mb-6 flex items-center justify-center gap-2 text-2xl font-extrabold tracking-tight">
        <span aria-hidden="true" className="inline-block size-3.5 rounded-full bg-accent" />
        MsSuzie
      </p>
      <Card>
        {preview.valid ? (
          <>
            <h1 className="text-xl font-extrabold">Hi {preview.guardianFirstName}, move {preview.learnerFirstName}&apos;s class?</h1>
            <dl className="mt-4 space-y-3">
              {preview.currentTime ? (
                <div className="rounded-2xl bg-idle-bg p-4">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Now</dt>
                  <dd className="font-bold">{preview.currentTime}</dd>
                </div>
              ) : null}
              <div className="rounded-2xl bg-ok-bg p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">New time (your time zone)</dt>
                <dd className="font-bold" data-testid="new-time">{preview.newTime}</dd>
              </div>
            </dl>
            <p className="mt-4 text-muted">With {preview.tutorFirstName}. This link works once.</p>
            <div className="mt-5">
              <AcceptButton token={token!} learner={preview.learnerFirstName} newTime={preview.newTime} />
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-extrabold">We couldn&apos;t use this link</h1>
            <p className="mt-2 text-muted" data-testid="accept-problem">{preview.message}</p>
          </>
        )}
      </Card>
    </main>
  );
}
