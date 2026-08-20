import type { Metadata, Viewport } from "next";
import { DM_Sans, Manrope } from "next/font/google";

import "./globals.css";

const display = Manrope({
  variable: "--font-display",
  subsets: ["latin"],
});

const body = DM_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Angry Cat Oral Boards",
  description: "Voice-first pediatric dentistry oral-board practice.",
  applicationName: "Angry Cat Oral Boards",
  referrer: "strict-origin-when-cross-origin",
  icons: {
    icon: "/icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#09172e",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable}`}>{children}</body>
    </html>
  );
}
