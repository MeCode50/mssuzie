import { redirect } from "next/navigation";

// The dashboard arrives with the next build step; until then, the main task is the home screen.
export default function Home() {
  redirect("/sessions/new");
}
