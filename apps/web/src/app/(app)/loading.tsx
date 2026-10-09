import { Skeleton } from "@/components/ui/skeleton";

/** Shown while a page loads. The status line tells assistive technology what is happening. */
export default function Loading() {
  return (
    <div>
      <p role="status" className="sr-only">Loading…</p>
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-3 h-5 w-96 max-w-full" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Skeleton className="h-96 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    </div>
  );
}
