import type { ReactNode } from "react";
import { Card } from "./card";
import { AlertIcon } from "./icons";

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Card className="text-center">
      <h2 className="text-lg font-bold">{title}</h2>
      {children ? <p className="mx-auto mt-2 max-w-md text-muted">{children}</p> : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </Card>
  );
}

/** A plain-language error, announced to assistive technology. */
export function InlineError({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-2xl bg-bad-bg p-4 text-bad">
      <AlertIcon className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{children}</p>
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}
