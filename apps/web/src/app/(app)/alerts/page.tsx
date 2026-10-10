import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertsView } from "@/components/alerts/alerts-view";
import { requirePageActor } from "@/lib/page-session";

export const metadata: Metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const actor = await requirePageActor();
  if (actor.role !== "ops") redirect("/reschedules");
  return <AlertsView />;
}
