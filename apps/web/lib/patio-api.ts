import type { Address, Hex } from "viem";

export type BroadcastStatus = "waiting" | "live" | "ended";

export interface BroadcastSummary {
  id: Hex;
  operator: Address;
  sessionAddress: Address;
  streamId: Hex;
  chainId: number;
  status: BroadcastStatus;
  recoveredPackets: number;
  createdAt: string;
  lastObservedAt: string | null;
  endedAt: string | null;
}

export interface FeePlanResponse {
  baseFeePerGasWei: string;
  mediaFeeLadderWei: string[];
  mediaPriorityFeeLadderWei: string[];
  sealMaxFeePerGasWei: string;
  sealPriorityFeePerGasWei: string;
  cleanupCostWei: string;
  mediaPeakCostWei: string;
  maximumExposureWei: string;
  windows: number;
  affordableDurationSeconds: number;
  canStart: boolean;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

export async function patioFetch<T>(
  input: URL | string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody & T;
  if (!response.ok) {
    throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  }
  return body;
}

export function websocketUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
