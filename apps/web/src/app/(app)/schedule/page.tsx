import type { Metadata } from "next";
import { WeekView } from "@/components/schedule/week-view";
import { requirePageActor } from "@/lib/page-session";

export const metadata: Metadata = { title: "Schedule" };
export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  await requirePageActor();
  return <WeekView initialZone="Africa/Lagos" />;
}
