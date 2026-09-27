import type { Metadata, Viewport } from "next";
import { GeistMono, GeistSans } from "geist/font";
import localFont from "next/font/local";
import { GeistPixelSquare } from "geist/font/pixel";
import type { CSSProperties, ReactNode } from "react";

import { AppProviders } from "../components/app-providers";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import "./globals.css";

const terminalGrotesque = localFont({
  src: "./fonts/terminal-grotesque.ttf",
  weight: "400",
  variable: "--font-terminal-grotesque",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Patio",
    template: "%s · Patio",
  },
  description: "Live audio between Ethereum blocks.",
  metadataBase: new URL("https://patiotokyo.vercel.app"),
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0a0808",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable} ${terminalGrotesque.variable}`}
      style={
        {
          // Preserve the existing application-level variable while sourcing
          // the same font from the already-installed local Geist package.
          "--font-geist": "var(--font-geist-sans)",
        } as CSSProperties
      }
    >
      <body>
        <AppProviders>
          <SiteHeader />
          {children}
          <SiteFooter />
        </AppProviders>
      </body>
    </html>
  );
}
