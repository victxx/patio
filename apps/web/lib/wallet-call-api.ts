import {
  applyWalletCallBatchStatus,
  assertReviewedWalletCallBatchPlan,
  atomicBatchAvailability,
  isTerminalWalletCallBatch,
  parseWalletCallCapabilities,
  submittedWalletCallBatchRecord,
  uncertainWalletCallBatchRecord,
  unavailableWalletCallCapabilities,
  WALLET_CALL_API_VERSION,
  type WalletCallBatchPlan,
  type WalletCallBatchRecord,
  type WalletCallCapabilitySnapshot,
} from "@patio/wallet-core";
import { patioNetworkByChainId } from "@patio/config";
import { getAddress, numberToHex, type Address } from "viem";

import {
  providerErrorCodes,
  providerErrorMessage,
  type EthereumProvider,
} from "./wallet";

const CAPABILITY_TIMEOUT_MS = 4_000;
const providerSessionIds = new WeakMap<object, string>();
let providerSessionCounter = 0;

export function walletProviderSessionId(provider: EthereumProvider): string {
  const key = provider as object;
  const existing = providerSessionIds.get(key);
  if (existing) return existing;
  const next = `wallet-session-${++providerSessionCounter}`;
  providerSessionIds.set(key, next);
  return next;
}

function isMethodUnavailable(cause: unknown): boolean {
  const codes = providerErrorCodes(cause);
  const message = providerErrorMessage(cause).toLowerCase();
  return (
    codes.includes(4200) ||
    codes.includes(-32601) ||
    message.includes("method not found") ||
    message.includes("unsupported method") ||
    message.includes("not supported")
  );
}

function isUnauthorized(cause: unknown): boolean {
  return providerErrorCodes(cause).includes(4100);
}

function isUserRejected(cause: unknown): boolean {
  return (
    providerErrorCodes(cause).includes(4001) ||
    providerErrorMessage(cause).toLowerCase().includes("user rejected")
  );
}

function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "TimeoutError";
}

async function requestWithTimeout(
  provider: EthereumProvider,
  request: { method: string; params?: unknown[] },
  timeoutMs = CAPABILITY_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.request(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${request.method} timed out.`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read-only EIP-5792 discovery for the account that is already connected. */
export async function discoverWalletCallCapabilities(input: {
  provider: EthereumProvider;
  providerSessionId: string;
  account: Address;
  chainId: number;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<WalletCallCapabilitySnapshot> {
  const nowMs = input.nowMs ?? Date.now();
  try {
    const response = await requestWithTimeout(
      input.provider,
      {
        method: "wallet_getCapabilities",
        params: [getAddress(input.account), [numberToHex(input.chainId)]],
      },
      input.timeoutMs,
    );
    return parseWalletCallCapabilities({
      response,
      providerSessionId: input.providerSessionId,
      account: input.account,
      chainId: input.chainId,
      observedAtMs: nowMs,
    });
  } catch (cause) {
    return unavailableWalletCallCapabilities({
      providerSessionId: input.providerSessionId,
      account: input.account,
      chainId: input.chainId,
      observedAtMs: nowMs,
      availability: isMethodUnavailable(cause)
        ? "unavailable"
        : isUnauthorized(cause)
          ? "unauthorized"
          : "temporary-failure",
      detail: isTimeout(cause)
        ? "Wallet Call API capability check timed out; support is unknown."
        : providerErrorMessage(cause) ||
          "Wallet Call API capability check could not be completed.",
    });
  }
}

function matchingContext(input: {
  plan: WalletCallBatchPlan;
  providerSessionId: string;
  connectedAccount: Address;
  connectedChainId: number;
  nowMs: number;
}): string | null {
  try {
    assertReviewedWalletCallBatchPlan(input.plan, input.nowMs);
  } catch (cause) {
    return cause instanceof Error
      ? cause.message
      : "Wallet Call API plan is invalid.";
  }
  if (input.plan.providerSessionId !== input.providerSessionId) {
    return "Wallet provider changed; prepare this batch again.";
  }
  if (input.plan.chainId !== input.connectedChainId) {
    return "Wallet network changed; prepare this batch again.";
  }
  if (
    input.plan.account.toLowerCase() !== input.connectedAccount.toLowerCase()
  ) {
    return "Connected wallet account changed; prepare this batch again.";
  }
  return null;
}

function sendCallsRequest(plan: WalletCallBatchPlan) {
  return {
    version: WALLET_CALL_API_VERSION,
    id: plan.requestId,
    from: plan.account,
    chainId: numberToHex(plan.chainId),
    atomicRequired: true,
    calls: plan.calls.map((call) => ({
      to: call.to,
      data: call.data ?? "0x",
      value: numberToHex(call.valueWei ?? 0n),
    })),
  } as const;
}

function returnedBatchId(value: unknown): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  const id = (value as { id: string }).id;
  return id.length > 0 && new TextEncoder().encode(id).byteLength <= 4096
    ? id
    : null;
}

export type WalletCallDispatchResult =
  | { kind: "submitted"; record: WalletCallBatchRecord }
  | { kind: "unavailable"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "uncertain"; record: WalletCallBatchRecord; reason: string }
  | { kind: "failed"; reason: string };

/**
 * The only dispatcher. It has no production caller in Prompt #8; it is kept
 * separate so a future reviewed feature can explicitly authorize one attempt.
 */
export async function dispatchReviewedWalletCallBatch(input: {
  plan: WalletCallBatchPlan;
  provider: EthereumProvider;
  providerSessionId: string;
  connectedAccount: Address;
  connectedChainId: number;
  networkEnabled: boolean;
  explicitAuthorization: true;
  nowMs?: number;
  capabilityTimeoutMs?: number;
  submissionTimeoutMs?: number;
}): Promise<WalletCallDispatchResult> {
  const nowMs = input.nowMs ?? Date.now();
  if (
    !input.networkEnabled ||
    patioNetworkByChainId(input.connectedChainId)?.safety.enabled !== true
  ) {
    return {
      kind: "unavailable",
      reason: "This Patio network is not enabled.",
    };
  }
  const contextError = matchingContext({ ...input, nowMs });
  if (contextError) return { kind: "unavailable", reason: contextError };

  const capabilities = await discoverWalletCallCapabilities({
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    account: input.connectedAccount,
    chainId: input.connectedChainId,
    nowMs,
    ...(input.capabilityTimeoutMs === undefined
      ? {}
      : { timeoutMs: input.capabilityTimeoutMs }),
  });
  const available = atomicBatchAvailability(capabilities);
  if (!available.allowed) {
    return {
      kind: "unavailable",
      reason:
        available.reason ?? "Atomic Wallet Call API execution is unavailable.",
    };
  }

  try {
    // Exactly one request per explicit authorization. No fallback or retry.
    const response = await requestWithTimeout(
      input.provider,
      {
        method: "wallet_sendCalls",
        params: [sendCallsRequest(input.plan)],
      },
      input.submissionTimeoutMs ?? CAPABILITY_TIMEOUT_MS,
    );
    const walletBatchId = returnedBatchId(response);
    if (!walletBatchId || walletBatchId !== input.plan.requestId) {
      const record = uncertainWalletCallBatchRecord({
        plan: input.plan,
        nowMs,
        detail:
          "Wallet returned an unexpected batch identifier; submission outcome is uncertain.",
        ...(walletBatchId ? { walletBatchId } : {}),
      });
      return {
        kind: "uncertain",
        record,
        reason: record.detail ?? "Unknown submission outcome.",
      };
    }
    return {
      kind: "submitted",
      record: submittedWalletCallBatchRecord({
        plan: input.plan,
        walletBatchId,
        nowMs,
      }),
    };
  } catch (cause) {
    const message =
      providerErrorMessage(cause) ||
      "Wallet Call API submission did not return a result.";
    if (isUserRejected(cause)) return { kind: "rejected", reason: message };
    if (isMethodUnavailable(cause)) return { kind: "failed", reason: message };
    const record = uncertainWalletCallBatchRecord({
      plan: input.plan,
      nowMs,
      detail: isTimeout(cause)
        ? "Wallet Call API submission timed out; it may still have reached the wallet."
        : "Wallet Call API submission outcome is uncertain; do not resend automatically.",
    });
    return { kind: "uncertain", record, reason: message };
  }
}

export type WalletCallStatusResult =
  | { kind: "updated"; record: WalletCallBatchRecord }
  | { kind: "unknown"; reason: string }
  | { kind: "unavailable"; reason: string };

export async function readWalletCallBatchStatus(input: {
  record: WalletCallBatchRecord;
  provider: EthereumProvider;
  providerSessionId: string;
  connectedAccount: Address;
  connectedChainId: number;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<WalletCallStatusResult> {
  if (!input.record.walletBatchId) {
    return {
      kind: "unknown",
      reason: "This uncertain batch has no confirmed wallet batch ID.",
    };
  }
  if (
    input.record.providerSessionId !== input.providerSessionId ||
    input.record.account.toLowerCase() !==
      input.connectedAccount.toLowerCase() ||
    input.record.chainId !== input.connectedChainId
  ) {
    return {
      kind: "unavailable",
      reason: "Batch belongs to a different wallet connection.",
    };
  }
  try {
    const response = await requestWithTimeout(
      input.provider,
      { method: "wallet_getCallsStatus", params: [input.record.walletBatchId] },
      input.timeoutMs,
    );
    return {
      kind: "updated",
      record: applyWalletCallBatchStatus({
        record: input.record,
        response,
        observedAtMs: input.nowMs ?? Date.now(),
      }),
    };
  } catch (cause) {
    return {
      kind: "unknown",
      reason:
        providerErrorMessage(cause) ||
        "Wallet Call API status is unavailable; batch outcome remains unknown.",
    };
  }
}

/** User-triggered wallet UI only; never called by effects or polling. */
export async function showWalletCallBatchStatus(input: {
  record: WalletCallBatchRecord;
  provider: EthereumProvider;
  providerSessionId: string;
  connectedAccount: Address;
  connectedChainId: number;
}): Promise<void> {
  if (!input.record.walletBatchId) {
    throw new Error("This batch has no confirmed wallet batch ID.");
  }
  if (
    input.record.providerSessionId !== input.providerSessionId ||
    input.record.account.toLowerCase() !==
      input.connectedAccount.toLowerCase() ||
    input.record.chainId !== input.connectedChainId
  ) {
    throw new Error("Batch belongs to a different wallet connection.");
  }
  await input.provider.request({
    method: "wallet_showCallsStatus",
    params: [input.record.walletBatchId],
  });
}

/** Bounded, cancellable local watcher. It never resubmits a batch. */
export function watchWalletCallBatchStatus(input: {
  read: () => Promise<WalletCallStatusResult>;
  onUpdate: (result: WalletCallStatusResult) => void;
  intervalsMs?: readonly number[];
}): () => void {
  const intervals = input.intervalsMs ?? [500, 1_000, 2_000, 4_000];
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;
  const poll = async () => {
    if (!active) return;
    const result = await input.read();
    if (!active) return;
    input.onUpdate(result);
    if (result.kind === "updated" && isTerminalWalletCallBatch(result.record)) {
      active = false;
      return;
    }
    timer = setTimeout(
      () => {
        void poll();
      },
      intervals[Math.min(index++, intervals.length - 1)] ?? 4_000,
    );
  };
  void poll();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}
