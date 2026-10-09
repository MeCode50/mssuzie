import type { Metadata, Viewport } from "next";
import { Nunito_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { DemoBanner } from "@/components/shell/demo-banner";
import "./globals.css";

const font = Nunito_Sans({ subsets: ["latin"], variable: "--font-nunito", display: "swap" });

export const metadata: Metadata = {
  title: { default: "MsSuzie Session Copilot", template: "%s · MsSuzie Copilot" },
  description: "Turn tutor session notes into progress data, a learning plan and a parent update draft.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#fbf6ee" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={font.variable}>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:font-semibold">
          Skip to content
        </a>
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
