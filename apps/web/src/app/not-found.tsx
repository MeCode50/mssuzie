import Link from "next/link";
import { Card } from "@/components/ui/card";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-16">
      <Card className="text-center">
        <h1 className="text-xl font-extrabold">We couldn&apos;t find that page</h1>
        <p className="mt-2 text-muted">It may have been moved, or you may not have access to it.</p>
        <Link href="/" className="mt-5 inline-flex min-h-11 items-center rounded-full bg-accent-strong px-5 font-semibold text-white hover:bg-[#9a4315]">Go to the home screen</Link>
      </Card>
    </main>
  );
}
