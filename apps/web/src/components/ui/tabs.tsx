"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

/** Accessible tabs: roving focus with Arrow/Home/End keys, only the active panel is in the tab order. */
export function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const base = useId();
  const [active, setActive] = useState(initial && tabs.some((t) => t.id === initial) ? initial : tabs[0]?.id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKey(e: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : e.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    setActive(id);
    refs.current[id]?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label="Run results" className="flex gap-1 overflow-x-auto border-b border-line pb-px">
        {tabs.map((t, i) => (
          <button
            key={t.id} ref={(el) => void (refs.current[t.id] = el)} type="button" role="tab" id={`${base}-tab-${t.id}`}
            aria-selected={active === t.id} aria-controls={`${base}-panel-${t.id}`} tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)} onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "min-h-11 shrink-0 rounded-t-xl px-4 font-semibold transition-colors",
              active === t.id ? "border-b-4 border-accent-strong text-ink" : "border-b-4 border-transparent text-muted hover:bg-accent-soft hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`${base}-panel-${t.id}`} aria-labelledby={`${base}-tab-${t.id}`} hidden={active !== t.id} tabIndex={0} className="pt-5 outline-offset-4">
          {active === t.id ? t.content : null}
        </div>
      ))}
    </div>
  );
}
