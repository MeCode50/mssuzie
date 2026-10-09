import { ShieldIcon } from "@/components/ui/icons";

/** Shown on every screen, including login and error pages. */
export function DemoBanner() {
  return (
    <div role="note" className="bg-banner text-ink">
      <p className="mx-auto flex max-w-6xl items-start gap-2 px-4 py-2 text-sm font-semibold sm:items-center sm:px-6">
        <ShieldIcon className="mt-0.5 size-4 shrink-0 sm:mt-0" />
        <span>Demo environment: fictional learners only. Please do not enter real children&apos;s data.</span>
      </p>
    </div>
  );
}
