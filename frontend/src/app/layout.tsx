import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PulseLens",
  description: "AI incident war-room demo with evidence-cited telemetry analysis."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
