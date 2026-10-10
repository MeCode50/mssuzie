"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";

const ITEMS = [
  { href: "/reschedules", label: "Reschedules", ops: false },
  { href: "/schedule", label: "Schedule", ops: false },
  { href: "/learners", label: "Learners", ops: false },
  { href: "/alerts", label: "Alerts", ops: true },
  { href: "/sessions/new", label: "Session Copilot", ops: false },
] as const;

export function MainNav({ role }: { role: "ops" | "tutor" }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      {ITEMS.filter((i) => role === "ops" || !i.ops).map((i) => {
        const current = path === i.href || path.startsWith(`${i.href}/`) || (i.href === "/sessions/new" && path.startsWith("/runs"));
        return (
          <Link key={i.href} href={i.href} aria-current={current ? "page" : undefined} className={cn("rounded-full px-3 py-2 text-sm font-semibold hover:bg-accent-soft", current && "bg-accent-soft text-accent-strong")}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
