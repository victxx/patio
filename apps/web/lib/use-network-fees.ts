"use client";
import { useSyncExternalStore } from "react";
import type { DirectRpcConfig } from "./direct-hoodi";
import { EMPTY_FEES, networkFeeReader } from "./network-fees";
export function useNetworkFees(config: DirectRpcConfig, chainId: number) {
  const reader = networkFeeReader(config, chainId);
  const state = useSyncExternalStore(
    reader.subscribe,
    reader.snapshot,
    () => EMPTY_FEES,
  );
  return { ...state, refresh: reader.refresh };
}
