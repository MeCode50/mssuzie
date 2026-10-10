"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/states";
import { apiFetch, ApiClientError } from "@/lib/api-client";

const PHRASE = "reset demo data";

/** Ops-only: put the fictional learners, timetable and requests back to the start. Asks you to type the phrase first. */
export function ResetDemo() {
  const dialog = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setText("");
    setError(null);
    dialog.current?.showModal();
  };
  const close = () => dialog.current?.close();

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/demo/reset", { method: "POST", json: { confirm: text } });
      // A full reload on purpose: every screen holds state about requests and runs that no longer exist.
      window.location.assign("/reschedules");
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={open} data-testid="reset-demo" className="rounded-full px-3 py-2 text-sm font-semibold text-muted hover:bg-accent-soft hover:text-ink">Reset demo</button>
      <dialog ref={dialog} aria-labelledby={`${inputId}-title`} className="m-auto w-[min(92vw,28rem)] rounded-card border border-line bg-surface p-6 text-ink shadow-card backdrop:bg-black/40">
        <h2 id={`${inputId}-title`} className="text-lg font-extrabold">Reset the demo?</h2>
        <p className="mt-2 text-muted">This removes every request, session, alert and run, and puts the fictional learners and this week&apos;s timetable back as they started. Sign-ins are not affected.</p>
        <label htmlFor={inputId} className="mt-4 block text-sm font-semibold">Type <span className="font-mono">{PHRASE}</span> to confirm</label>
        <input id={inputId} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" className="mt-1.5 block min-h-11 w-full rounded-xl border border-field bg-surface px-3" data-testid="reset-confirm" />
        {error ? <div className="mt-3"><InlineError>{error}</InlineError></div> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={reset} loading={busy} disabled={text.trim().toLowerCase() !== PHRASE} data-testid="reset-go">Reset</Button>
        </div>
      </dialog>
    </>
  );
}
