"use client";

import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/states";

export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <InlineError action={<Button variant="secondary" size="sm" onClick={reset}>Try again</Button>}>
        Something went wrong while loading this page. Your work is safe, so please try again.
      </InlineError>
    </div>
  );
}
