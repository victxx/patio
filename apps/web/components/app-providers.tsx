"use client";

import type { ReactNode } from "react";

import { BrowserCompatibilityNotice } from "./browser-compatibility-notice";
import { WalletSessionProvider } from "./wallet-session";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <WalletSessionProvider>
      {children}
      <BrowserCompatibilityNotice />
    </WalletSessionProvider>
  );
}
