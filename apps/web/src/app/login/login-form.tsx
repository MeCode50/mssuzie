"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/states";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "mt-1.5 block min-h-11 w-full rounded-xl border border-field bg-surface px-4 text-base placeholder:text-muted";

function messageFor(status: number | undefined): string {
  if (status === 401 || status === 400 || status === 422) return "That email and password don't match. Please check them and try again.";
  if (status === 429) return "Too many sign-in attempts. Please wait a minute and try again.";
  return "We couldn't sign you in right now. Please try again in a moment.";
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await authClient.signIn.email({
        email: String(form.get("email") ?? "").trim(), password: String(form.get("password") ?? ""),
      });
      if (failure) {
        setError(messageFor(failure.status));
        setBusy(false);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError(messageFor(undefined));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div>
        <label htmlFor={emailId} className="font-semibold">Email</label>
        <input id={emailId} name="email" type="email" autoComplete="username" required autoFocus className={inputClass} placeholder="you@mssuzie.com" />
      </div>
      <div>
        <label htmlFor={passwordId} className="font-semibold">Password</label>
        <div className="relative">
          <input id={passwordId} name="password" type={show ? "text" : "password"} autoComplete="current-password" required className={`${inputClass} pr-24`} />
          <button
            type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
            className="absolute right-2 top-1/2 mt-0.5 -translate-y-1/2 rounded-full px-3 py-1.5 text-sm font-semibold text-accent-strong hover:bg-accent-soft"
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      <div aria-live="polite">{error ? <InlineError>{error}</InlineError> : null}</div>
      <Button type="submit" loading={busy} className="w-full">Sign in</Button>
    </form>
  );
}
