"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function UserMenu({ name, role }: { name: string; role: "ops" | "tutor" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right leading-tight sm:block">
        <p className="text-sm font-bold">{name}</p>
        <p className="text-xs text-muted">{role === "ops" ? "MsSuzie ops" : "Tutor"}</p>
      </div>
      <Button variant="secondary" size="sm" loading={busy} onClick={signOut} aria-label={`Sign out ${name}`}>
        Sign out
      </Button>
    </div>
  );
}
