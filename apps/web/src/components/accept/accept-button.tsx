"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";
import { InlineError } from "@/components/ui/states";
import { acceptLink, ApiClientError } from "@/lib/api-client";

export function AcceptButton({ token, learner, newTime }: { token: string; learner: string; newTime: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptLink(token);
      setDone(res.newTime);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Something went wrong. Please reply to our email and we'll help.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" data-testid="accepted" className="rounded-2xl bg-ok-bg p-5 text-ok">
        <p className="flex items-center gap-2 text-lg font-extrabold"><CheckIcon className="size-5" /> All done</p>
        <p className="mt-1 font-semibold">{learner}&apos;s class is now {done}. We&apos;ve emailed you and the tutor a confirmation.</p>
      </div>
    );
  }
  return (
    <div>
      {error ? <div className="mb-4"><InlineError>{error}</InlineError></div> : null}
      <Button onClick={accept} loading={busy} data-testid="accept-button" className="w-full sm:w-auto">Yes, move {learner}&apos;s class to {newTime}</Button>
      <p className="mt-3 text-sm text-muted">Nothing changes until you press the button.</p>
    </div>
  );
}
