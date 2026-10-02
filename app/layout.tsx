import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Inter, for the reason it is usually chosen: it was drawn for small sizes on
// screen, and most of what this app shows is a time, a name and an amount read
// quickly on a phone. Its tabular figures keep the money column from shifting
// as the digits change.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mr Clean & Clean — Ops",
  description: "Internal appointment and staff operations system.",
};

// Tells the phone to paint its status bar brand navy instead of white, so the
// app does not end at a seam halfway up the screen.
export const viewport: Viewport = {
  themeColor: "#193498",
  width: "device-width",
  initialScale: 1,
  // Not maximumScale/userScalable: pinch zoom is how someone reads an address
  // in bright sun, and disabling it is an accessibility failure.
};

// Function region (Singapore, closest to Kuala Lumpur — Blueprint v0.2
// §B) is set via vercel.json's "regions" field, not a route export — the
// Next.js `preferredRegion` export is deprecated as of Next.js 16.

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
