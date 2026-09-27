"use client";

import {
  atomicBatchAvailability,
  type WalletCallCapabilitySnapshot,
} from "@patio/wallet-core";
import { useEffect, useState } from "react";

import {
  discoverWalletCallCapabilities,
  walletProviderSessionId,
} from "../lib/wallet-call-api";
import type { ConnectedWallet } from "../lib/wallet";

const CAPABILITY_CACHE_TTL_MS = 30_000;
const capabilityCache = new Map<string, WalletCallCapabilitySnapshot>();

function snapshotKey(
  sessionId: string,
  account: string,
  chainId: number,
): string {
  return `${sessionId}:${account.toLowerCase()}:${chainId}`;
}

function atomicLabel(snapshot: WalletCallCapabilitySnapshot): string {
  if (snapshot.atomic === "supported") return "supported";
  if (snapshot.atomic === "ready") return "upgrade required";
  if (snapshot.atomic === "unsupported") return "unavailable";
  return "unknown";
}

export function WalletCallCapabilities({
  wallet,
  chainId,
  networkName,
}: {
  wallet: ConnectedWallet;
  chainId: number;
  networkName: string;
}) {
  const sessionId = walletProviderSessionId(wallet.provider);
  const key = snapshotKey(sessionId, wallet.address, chainId);
  const [snapshot, setSnapshot] = useState<WalletCallCapabilitySnapshot | null>(
    () => capabilityCache.get(key) ?? null,
  );

  useEffect(() => {
    let active = true;
    const cached = capabilityCache.get(key);
    if (cached && Date.now() - cached.observedAtMs < CAPABILITY_CACHE_TTL_MS) {
      setSnapshot(cached);
    } else {
      setSnapshot(null);
      const load = async () => {
        const next = await discoverWalletCallCapabilities({
          provider: wallet.provider,
          providerSessionId: sessionId,
          account: wallet.address,
          chainId,
        });
        if (!active) return;
        capabilityCache.set(key, next);
        setSnapshot(next);
      };
      void load();
    }

    const invalidate = () => {
      capabilityCache.delete(key);
      if (active) setSnapshot(null);
    };
    wallet.provider.on?.("accountsChanged", invalidate);
    wallet.provider.on?.("chainChanged", invalidate);
    wallet.provider.on?.("disconnect", invalidate);
    return () => {
      active = false;
      wallet.provider.removeListener?.("accountsChanged", invalidate);
      wallet.provider.removeListener?.("chainChanged", invalidate);
      wallet.provider.removeListener?.("disconnect", invalidate);
    };
  }, [chainId, key, sessionId, wallet.address, wallet.provider]);

  const batch = snapshot ? atomicBatchAvailability(snapshot) : null;
  return (
    <section
      className="wallet-call-capabilities"
      aria-label="Wallet Call API capabilities"
    >
      <h3>Connected wallet</h3>
      <p>Account: {wallet.address}</p>
      <p>Network: {networkName}</p>
      <p>Wallet Call API: {snapshot?.availability ?? "checking"}</p>
      <p>Atomic execution: {snapshot ? atomicLabel(snapshot) : "checking"}</p>
      {snapshot ? (
        <p>
          Checked: {new Date(snapshot.observedAtMs).toLocaleTimeString()} ·{" "}
          {snapshot.evidence.replaceAll("-", " ")}
        </p>
      ) : null}
      {batch && !batch.allowed ? <p>{batch.reason}</p> : null}
    </section>
  );
}
