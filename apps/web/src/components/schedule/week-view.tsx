"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { InlineError } from "@/components/ui/states";
import { ApiClientError, fetchSchedule } from "@/lib/api-client";
import type { BookingView } from "@/lib/reschedule-types";
import { dayKey, dayLabel, timeLabel, weekBounds } from "@/lib/week";

const ZONES = [
  { id: "Africa/Lagos", label: "Lagos (tutors)" },
  { id: "Europe/London", label: "London" },
  { id: "America/Chicago", label: "Chicago" },
  { id: "Europe/Lisbon", label: "Lisbon" },
] as const;

const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : "We couldn't load the schedule.");

export function WeekView({ initialZone }: { initialZone: string }) {
  const zoneId = useId();
  const tutorId = useId();
  const [zone, setZone] = useState<string>(initialZone);
  const [offset, setOffset] = useState(0);
  const [tutor, setTutor] = useState("all");
  const [bookings, setBookings] = useState<BookingView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const week = useMemo(() => weekBounds(new Date(), zone, offset), [zone, offset]);
  const todayKey = dayKey(new Date(), zone);

  useEffect(() => {
    let alive = true;
    setBookings(null);
    fetchSchedule(week.start.toISOString(), week.end.toISOString())
      .then((d) => alive && (setBookings(d.bookings), setError(null)))
      .catch((e: unknown) => alive && setError(messageOf(e)));
    return () => void (alive = false);
  }, [week]);

  const tutors = useMemo(() => [...new Map((bookings ?? []).map((b) => [b.tutor.id, b.tutor.name])).entries()], [bookings]);
  const visible = (bookings ?? []).filter((b) => tutor === "all" || b.tutor.id === tutor);
  const byDay = new Map<string, BookingView[]>();
  for (const b of visible) {
    const k = dayKey(new Date(b.startsAt), zone);
    byDay.set(k, [...(byDay.get(k) ?? []), b]);
  }
  const movedCount = visible.filter((b) => b.moved).length;
  const first = dayLabel(week.days[0]!);
  const last = dayLabel(week.days[6]!);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Schedule</h1>
          <p className="mt-1 text-muted">Every class this week. Classes moved by the agents or by Ops are highlighted.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={zoneId} className="block text-sm font-semibold">Show times in</label>
            <select id={zoneId} value={zone} onChange={(e) => setZone(e.target.value)} className="mt-1 min-h-11 rounded-xl border border-field bg-surface px-3" data-testid="zone-select">
              {ZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
              {!ZONES.some((z) => z.id === initialZone) ? <option value={initialZone}>My time ({initialZone})</option> : null}
            </select>
          </div>
          <div>
            <label htmlFor={tutorId} className="block text-sm font-semibold">Tutor</label>
            <select id={tutorId} value={tutor} onChange={(e) => setTutor(e.target.value)} className="mt-1 min-h-11 rounded-xl border border-field bg-surface px-3">
              <option value="all">Everyone</option>
              {tutors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => setOffset((o) => o - 1)} aria-label="Previous week">← Previous</Button>
        <p className="min-w-44 text-center font-bold" data-testid="week-label">{first.date} – {last.date}</p>
        <Button variant="secondary" size="sm" onClick={() => setOffset((o) => o + 1)} aria-label="Next week">Next →</Button>
        {offset !== 0 ? <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>This week</Button> : null}
        {bookings ? <p className="text-sm text-muted" data-testid="week-summary">{visible.length} classes{movedCount ? ` · ${movedCount} moved` : ""}</p> : null}
      </div>

      {error ? <div className="mt-4"><InlineError>{error}</InlineError></div> : null}

      <ol className="mt-5 grid gap-3 md:grid-cols-7" aria-label="Days of the week" data-testid="week-grid">
        {week.days.map((key) => {
          const label = dayLabel(key);
          const items = byDay.get(key) ?? [];
          return (
            <li key={key} className={cn("rounded-2xl border bg-surface p-3", key === todayKey ? "border-accent ring-2 ring-accent-soft" : "border-line")} data-testid={`day-${key}`}>
              <h2 className="text-sm font-bold">{label.weekday} <span className="font-normal text-muted whitespace-nowrap">{label.date}</span>{key === todayKey ? <span className="mt-1 block w-fit rounded-full bg-accent-soft px-2 py-0.5 text-xs font-bold text-accent-strong">Today</span> : null}</h2>
              {bookings === null ? <p className="mt-2 text-sm text-muted">Loading…</p> : items.length === 0 ? <p className="mt-2 text-sm text-muted">No classes</p> : (
                <ul className="mt-2 space-y-2">
                  {items.map((b) => {
                    const start = new Date(b.startsAt);
                    return (
                      <li key={b.id} data-testid="booking" data-moved={b.moved ? "yes" : "no"} className={cn("rounded-xl p-2.5 text-sm", b.moved ? "border-2 border-accent bg-accent-soft" : "bg-idle-bg")}>
                        <p className="font-bold tabular-nums">{timeLabel(start, zone)}</p>
                        <p className="font-semibold">{b.learner.displayName.split(" ")[0]}</p>
                        <p className="text-muted">{b.tutor.name.split(" ")[0]} · {b.durationMin} min</p>
                        {b.moved ? (
                          <p className="mt-1 text-xs font-semibold text-accent-strong">
                            Moved from {timeLabel(new Date(b.moved.from), zone)}, {new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(new Date(b.moved.from))}
                            {" · "}<Link href={`/reschedules/${b.moved.requestId}`} className="underline">see why</Link>
                          </p>
                        ) : null}
                        {b.moved && !b.calendarSynced ? <p className="mt-1 text-xs font-semibold text-warn">Calendar not updated</p> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
