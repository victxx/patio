"use client";

import { PATIO_NETWORK_PROFILES } from "@patio/config";
import { formatEther } from "viem";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  loadBroadcastHistory,
  type BroadcastHistoryEntry,
} from "../lib/broadcast-history";
import { KNOWN_OPERATIONS_STORAGE_KEY } from "../lib/known-operations";
import {
  loadOperationStore,
  type KnownOperation,
  type WalletCallBatchRecord,
} from "@patio/wallet-core";
import { shortAddress } from "../lib/patio-api";
import { WalletHistoryPanel } from "./wallet-history-panel";
import { WalletOperationsPanel } from "./wallet-operations-panel";
import { useWalletSession } from "./wallet-session";

const HEADER_GLASS_STYLE = {
  backdropFilter: "blur(5px) saturate(108%)",
  WebkitBackdropFilter: "blur(5px) saturate(108%)",
} satisfies CSSProperties;

function formatWalletBalance(balanceWei: bigint | null): string {
  if (balanceWei === null) return "…";
  const balance = Number(formatEther(balanceWei));
  if (balance === 0) return "0";
  if (balance < 0.0001) return "<0.0001";
  return balance
    .toFixed(balance < 1 ? 4 : 3)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

export function WalletChip() {
  const {
    wallet,
    balanceWei,
    sessionLocked,
    connecting,
    connect,
    networkId,
    disconnect,
  } = useWalletSession();
  const networkProfile = PATIO_NETWORK_PROFILES[networkId];
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [history, setHistory] = useState<BroadcastHistoryEntry[]>([]);
  const [operations, setOperations] = useState<readonly KnownOperation[]>([]);
  const [callBatches, setCallBatches] = useState<
    readonly WalletCallBatchRecord[]
  >([]);
  const [denied, setDenied] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);

  const label = wallet
    ? `${wallet.name} ${shortAddress(wallet.address)} connected with ${formatWalletBalance(balanceWei)} ${networkProfile.nativeCurrency.symbol} on ${networkProfile.name}`
    : "Wallet disconnected";

  useEffect(() => {
    if (!menuOpen && !historyOpen && !activityOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !controlRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
        setHistoryOpen(false);
        setActivityOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setHistoryOpen(false);
        setActivityOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activityOpen, historyOpen, menuOpen]);

  const showHistory = () => {
    setHistory(loadBroadcastHistory(localStorage));
    setMenuOpen(false);
    setHistoryOpen(true);
  };

  const showActivity = () => {
    const store = loadOperationStore(
      localStorage,
      KNOWN_OPERATIONS_STORAGE_KEY,
    );
    setOperations(store.entries);
    setCallBatches(store.callBatches);
    setMenuOpen(false);
    setActivityOpen(true);
  };

  return (
    <div ref={controlRef} className="wallet-control">
      <span className="visually-hidden" role="status" aria-label={label} />
      {wallet ? (
        <button
          className="wallet-chip is-connected"
          type="button"
          aria-label={`${label}. Open wallet menu`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls="wallet-menu"
          onClick={() => setMenuOpen((open) => !open)}
          style={HEADER_GLASS_STYLE}
        >
          <span className="wallet-chip__address">
            {formatWalletBalance(balanceWei)}{" "}
            {networkProfile.nativeCurrency.symbol}
          </span>
          <span className="wallet-chip__dot" aria-hidden="true" />
          <svg
            className="wallet-chip__chevron"
            viewBox="0 0 12 12"
            aria-hidden="true"
          >
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>
      ) : (
        <button
          className={`wallet-chip is-disconnected${denied ? " is-denied" : ""}`}
          type="button"
          aria-label={label}
          title={label}
          disabled={connecting || sessionLocked}
          onClick={() => {
            setConnectionError(null);
            void connect(networkProfile).catch((cause: unknown) => {
              setDenied(true);
              setConnectionError(
                cause instanceof Error
                  ? cause.message
                  : "Wallet connection failed.",
              );
            });
          }}
          onAnimationEnd={() => setDenied(false)}
          style={HEADER_GLASS_STYLE}
        >
          <span className="wallet-chip__address">
            {connecting ? "Connecting…" : "Wallet"}
          </span>
          <span className="wallet-chip__dot" aria-hidden="true" />
        </button>
      )}
      {connectionError ? (
        <p className="simple-error" role="alert">
          {connectionError}
        </p>
      ) : null}

      {wallet && menuOpen ? (
        <div id="wallet-menu" className="wallet-menu" role="menu">
          <button type="button" role="menuitem" onClick={showHistory}>
            History
          </button>
          <button type="button" role="menuitem" onClick={showActivity}>
            Activity
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={sessionLocked}
            title={
              sessionLocked ? "Stop the broadcast first" : "Disconnect wallet"
            }
            onClick={() => {
              setMenuOpen(false);
              setHistoryOpen(false);
              setActivityOpen(false);
              void disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}

      {wallet && historyOpen ? (
        <WalletHistoryPanel
          history={history}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
      {wallet && activityOpen ? (
        <WalletOperationsPanel
          wallet={wallet}
          networkName={networkProfile.name}
          selectedChainId={networkProfile.chainId}
          operations={operations}
          callBatches={callBatches}
          onClose={() => setActivityOpen(false)}
          onChange={showActivity}
        />
      ) : null}
    </div>
  );
}
