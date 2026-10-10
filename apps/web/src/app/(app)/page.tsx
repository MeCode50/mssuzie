import { redirect } from "next/navigation";

// Rescheduling is the main demo; Session Copilot stays one click away in the navigation.
export default function Home() {
  redirect("/reschedules");
}
