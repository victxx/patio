"use client";

import { formatGwei } from "viem";
import { useNetworkFees } from "../lib/use-network-fees";
import type { CSSProperties } from "react";

import { PATIO_NETWORK_PROFILES } from "@patio/config";

import {
  networkRuntimeById,
  type PatioNetworkRuntimeConfig,
} from "../lib/network-runtime";
import { useWalletSession } from "./wallet-session";

const HEADER_GLASS_STYLE = {
  backdropFilter: "blur(5px) saturate(108%)",
  WebkitBackdropFilter: "blur(5px) saturate(108%)",
} satisfies CSSProperties;

function formatGas(wei: bigint): string {
  const gwei = Number(formatGwei(wei));
  if (gwei < 0.01) return "<0.01";
  if (gwei < 10) return gwei.toFixed(2).replace(/\.00$/, "");
  return gwei.toFixed(1).replace(/\.0$/, "");
}

export function LiveGasIndicator({
  networkConfigs,
}: {
  networkConfigs: readonly PatioNetworkRuntimeConfig[];
}) {
  const { networkId } = useWalletSession();
  const profile = PATIO_NETWORK_PROFILES[networkId];
  const rpc = networkRuntimeById(networkConfigs, networkId)?.relayRpc ?? {
    url: "",
  };
  const quote = useNetworkFees(rpc, profile.chainId);
  const gas =
    quote.fees && !quote.error
      ? formatGas(quote.fees.baseFeePerGasWei + quote.fees.priorityFeePerGasWei)
      : null;

  return (
    <span
      className={`gas-indicator${gas ? " is-live" : ""}`}
      aria-label={
        gas
          ? `Current ${profile.name} gas ${gas} gwei`
          : `${profile.name} gas unavailable`
      }
      title={`Current ${profile.name} base fee plus priority fee`}
      style={HEADER_GLASS_STYLE}
    >
      <span className="gas-indicator__dot" aria-hidden="true" />
      <span className="gas-indicator__value">{gas ?? "—"}</span>
      <span className="gas-indicator__unit">gwei</span>
    </span>
  );
}
