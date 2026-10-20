import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "River — a ledger that forgets nothing",
  description:
    "A social network on an append-only chain. Every post, edit and retraction is signed into a block. Nothing is ever deleted.",
  applicationName: "River",
  openGraph: {
    title: "River",
    description: "A social network whose ledger forgets nothing.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#070a0b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
