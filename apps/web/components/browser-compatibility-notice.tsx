"use client";

import { PATIO_MEDIA_TYPE } from "@patio/config";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const DISMISSED_KEY = "patio:compatibility-notice-dismissed";
const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod/i;
const APPLE_MOBILE_USER_AGENT = /iPhone|iPad|iPod/i;

function supportsMediaSource(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported(PATIO_MEDIA_TYPE)
  );
}

function supportsRecording(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported(PATIO_MEDIA_TYPE)
  );
}

function isMobileBrowser(): boolean {
  const navigatorWithHints = navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  return (
    navigatorWithHints.userAgentData?.mobile === true ||
    MOBILE_USER_AGENT.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isAppleMobileBrowser(): boolean {
  return (
    APPLE_MOBILE_USER_AGENT.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function compatibilityMessage(pathname: string): string | null {
  const casting = pathname === "/live/cast";
  const mobile = isMobileBrowser();

  if (casting && !supportsRecording()) {
    return "This browser cannot record Patio audio. Try a wallet browser on Android or desktop Chrome.";
  }
  if (!casting && !supportsMediaSource()) {
    return "This browser cannot play Patio live audio yet. Try Chrome on Android or desktop.";
  }
  if (!mobile) return null;
  if (isAppleMobileBrowser()) {
    return "iPhone and iPad support is experimental. Keep Patio open and the screen awake.";
  }
  return casting
    ? "Mobile broadcast beta. Use Rabby or MetaMask's browser and keep the screen awake."
    : "Mobile listening beta. Keep this tab open and the screen awake.";
}

export function BrowserCompatibilityNotice() {
  const pathname = usePathname();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStorage.getItem(DISMISSED_KEY) === "true") return;
    setMessage(compatibilityMessage(pathname));
  }, [pathname]);

  if (!message) return null;

  return (
    <aside className="compatibility-notice" aria-label="Browser compatibility">
      <span aria-hidden="true" />
      <p>{message}</p>
      <button
        type="button"
        aria-label="Dismiss browser compatibility notice"
        onClick={() => {
          sessionStorage.setItem(DISMISSED_KEY, "true");
          setMessage(null);
        }}
      >
        ×
      </button>
    </aside>
  );
}
