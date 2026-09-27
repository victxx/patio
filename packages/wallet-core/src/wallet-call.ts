import {
  getAddress,
  isAddress,
  isHex,
  numberToHex,
  type Address,
  type Hex,
} from "viem";

import type {
  KnownOperation,
  WalletCall,
  WalletCallAtomicCapability,
  WalletCallBatchPlan,
  WalletCallBatchRecord,
  WalletCallBatchState,
  WalletCallCapabilitySnapshot,
  WalletCallReceiptSummary,
} from "./types";

export const WALLET_CALL_API_VERSION = "2.0.0" as const;
export const MAX_WALLET_CALLS_PER_BATCH = 20;
export const MAX_WALLET_CALL_REQUEST_BYTES = 32 * 1024;
export const MAX_WALLET_CALL_REVIEW_AGE_MS = 5 * 60 * 1_000;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHexHash(value: unknown): value is Hex {
  return (
    typeof value === "string" && /^0x[\da-f]{64}$/i.test(value) && isHex(value)
  );
}

function parseHexQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[\da-f]+$/i.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedAtomic(value: unknown): {
  status: WalletCallAtomicCapability;
  malformed: boolean;
} {
  if (value === undefined) return { status: "unknown", malformed: false };
  if (!isRecord(value) || typeof value.status !== "string") {
    return { status: "unknown", malformed: true };
  }
  if (
    value.status === "supported" ||
    value.status === "ready" ||
    value.status === "unsupported"
  ) {
    return { status: value.status, malformed: false };
  }
  return { status: "unknown", malformed: true };
}

function capabilityEntry(
  response: UnknownRecord,
  chainId: number,
): UnknownRecord | undefined {
  const expected = numberToHex(chainId).toLowerCase();
  return Object.entries(response).find(
    ([key, value]) => key.toLowerCase() === expected && isRecord(value),
  )?.[1] as UnknownRecord | undefined;
}

/**
 * Parses only the compact EIP-5792 facts Patio needs. `0x0` remains visible
 * as global wallet information but never authorizes a specific chain route.
 */
export function parseWalletCallCapabilities(input: {
  response: unknown;
  providerSessionId: string;
  account: Address;
  chainId: number;
  observedAtMs: number;
}): WalletCallCapabilitySnapshot {
  const base = {
    providerSessionId: input.providerSessionId,
    account: getAddress(input.account),
    chainId: input.chainId,
    observedAtMs: input.observedAtMs,
    evidence: "reported-by-connected-wallet" as const,
  };
  if (!isRecord(input.response)) {
    return {
      ...base,
      availability: "malformed",
      atomic: "unknown",
      globalAtomic: "unknown",
      chainEntryPresent: false,
      globalEntryPresent: false,
      detail: "Wallet returned malformed Wallet Call API capabilities.",
    };
  }

  const chain = capabilityEntry(input.response, input.chainId);
  const global = capabilityEntry(input.response, 0);
  const chainAtomic = normalizedAtomic(chain?.atomic);
  const globalAtomic = normalizedAtomic(global?.atomic);
  const malformed = chainAtomic.malformed || globalAtomic.malformed;
  return {
    ...base,
    availability: malformed ? "malformed" : "available",
    atomic: chainAtomic.status,
    globalAtomic: globalAtomic.status,
    chainEntryPresent: Boolean(chain),
    globalEntryPresent: Boolean(global),
    ...(malformed
      ? { detail: "Wallet returned malformed atomic capability data." }
      : {}),
  };
}

export function unavailableWalletCallCapabilities(input: {
  providerSessionId: string;
  account: Address;
  chainId: number;
  observedAtMs: number;
  availability: Exclude<
    WalletCallCapabilitySnapshot["availability"],
    "available" | "malformed"
  >;
  detail: string;
}): WalletCallCapabilitySnapshot {
  return {
    providerSessionId: input.providerSessionId,
    account: getAddress(input.account),
    chainId: input.chainId,
    observedAtMs: input.observedAtMs,
    evidence: "reported-by-connected-wallet",
    availability: input.availability,
    atomic: "unknown",
    globalAtomic: "unknown",
    chainEntryPresent: false,
    globalEntryPresent: false,
    detail: input.detail,
  };
}

export function atomicBatchAvailability(
  snapshot: WalletCallCapabilitySnapshot,
): { allowed: boolean; reason?: string } {
  if (snapshot.availability !== "available") {
    return {
      allowed: false,
      reason:
        snapshot.detail ?? "Wallet Call API capability data is unavailable.",
    };
  }
  if (snapshot.atomic === "supported") return { allowed: true };
  if (snapshot.atomic === "ready") {
    return {
      allowed: false,
      reason:
        "Atomic execution needs a wallet upgrade; Patio does not request upgrades.",
    };
  }
  if (snapshot.atomic === "unsupported") {
    return {
      allowed: false,
      reason:
        "This wallet does not report atomic batch execution on this chain.",
    };
  }
  return {
    allowed: false,
    reason:
      "The wallet did not report supported atomic batch execution for this chain.",
  };
}

function normalizeCall(call: WalletCall): WalletCall {
  if (!isAddress(call.to))
    throw new Error("Wallet Call API call has an invalid recipient.");
  if (call.data !== undefined && !isHex(call.data)) {
    throw new Error("Wallet Call API call data must be hexadecimal.");
  }
  if (call.valueWei !== undefined && call.valueWei < 0n) {
    throw new Error("Wallet Call API value cannot be negative.");
  }
  return {
    to: getAddress(call.to),
    ...(call.data !== undefined
      ? { data: call.data.toLowerCase() as Hex }
      : {}),
    ...(call.valueWei !== undefined ? { valueWei: call.valueWei } : {}),
  };
}

function requestBytes(input: {
  account: Address;
  chainId: number;
  requestId: string;
  calls: readonly WalletCall[];
}): number {
  return byteLength(
    JSON.stringify({
      version: WALLET_CALL_API_VERSION,
      from: input.account,
      chainId: numberToHex(input.chainId),
      atomicRequired: true,
      id: input.requestId,
      calls: input.calls.map((call) => ({
        to: call.to,
        ...(call.data ? { data: call.data } : {}),
        ...(call.valueWei !== undefined
          ? { value: numberToHex(call.valueWei) }
          : {}),
      })),
    }),
  );
}

function fingerprint(input: {
  requestId: string;
  providerSessionId: string;
  account: Address;
  chainId: number;
  calls: readonly WalletCall[];
}): string {
  return JSON.stringify({
    requestId: input.requestId,
    providerSessionId: input.providerSessionId,
    account: input.account.toLowerCase(),
    chainId: input.chainId,
    calls: input.calls.map((call) => ({
      to: call.to.toLowerCase(),
      data: call.data?.toLowerCase() ?? "0x",
      valueWei: (call.valueWei ?? 0n).toString(),
    })),
  });
}

export function assertWalletCallOperationReferencesSafe(
  operations: readonly Pick<KnownOperation, "source" | "control">[],
): void {
  if (
    operations.some(
      (operation) =>
        operation.source === "patio" ||
        operation.control !== "wallet-manageable",
    )
  ) {
    throw new Error(
      "Patio broadcast and setup operations cannot be placed in Wallet Call API batches.",
    );
  }
}

export function createWalletCallBatchPlan(input: {
  requestId: string;
  providerSessionId: string;
  account: Address;
  chainId: number;
  calls: readonly WalletCall[];
  capabilities: WalletCallCapabilitySnapshot;
  reviewedAtMs: number;
  reviewExpiresAtMs?: number;
  operationReferences?: readonly Pick<KnownOperation, "source" | "control">[];
}): WalletCallBatchPlan {
  if (!input.requestId || byteLength(input.requestId) > 4096) {
    throw new Error(
      "Wallet Call API request ID must be a non-empty string up to 4096 bytes.",
    );
  }
  if (!input.providerSessionId) {
    throw new Error(
      "Wallet Call API plan requires a connected provider session.",
    );
  }
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("Wallet Call API plan requires a valid chain ID.");
  }
  if (!isAddress(input.account))
    throw new Error("Wallet Call API plan has an invalid account.");
  if (input.capabilities.providerSessionId !== input.providerSessionId) {
    throw new Error(
      "Wallet Call API capabilities came from another provider session.",
    );
  }
  if (
    input.capabilities.chainId !== input.chainId ||
    input.capabilities.account.toLowerCase() !== input.account.toLowerCase()
  ) {
    throw new Error(
      "Wallet Call API capabilities do not match this account and chain.",
    );
  }
  const available = atomicBatchAvailability(input.capabilities);
  if (!available.allowed) throw new Error(available.reason);
  if (
    input.calls.length === 0 ||
    input.calls.length > MAX_WALLET_CALLS_PER_BATCH
  ) {
    throw new Error(
      `Wallet Call API batches must contain 1-${MAX_WALLET_CALLS_PER_BATCH} calls.`,
    );
  }
  assertWalletCallOperationReferencesSafe(input.operationReferences ?? []);
  const account = getAddress(input.account);
  const calls = input.calls.map(normalizeCall);
  if (
    requestBytes({
      account,
      chainId: input.chainId,
      requestId: input.requestId,
      calls,
    }) > MAX_WALLET_CALL_REQUEST_BYTES
  ) {
    throw new Error(
      "Wallet Call API batch exceeds Patio's reviewed request-size limit.",
    );
  }
  const reviewExpiresAtMs =
    input.reviewExpiresAtMs ??
    input.reviewedAtMs + MAX_WALLET_CALL_REVIEW_AGE_MS;
  if (reviewExpiresAtMs < input.reviewedAtMs) {
    throw new Error("Wallet Call API review expiration is invalid.");
  }
  return {
    version: WALLET_CALL_API_VERSION,
    requestId: input.requestId,
    providerSessionId: input.providerSessionId,
    account,
    chainId: input.chainId,
    calls,
    callCount: calls.length,
    totalNativeValueWei: calls.reduce(
      (total, call) => total + (call.valueWei ?? 0n),
      0n,
    ),
    atomicRequired: true,
    capabilityObservedAtMs: input.capabilities.observedAtMs,
    reviewedAtMs: input.reviewedAtMs,
    reviewExpiresAtMs,
    reviewFingerprint: fingerprint({
      requestId: input.requestId,
      providerSessionId: input.providerSessionId,
      account,
      chainId: input.chainId,
      calls,
    }),
  };
}

export function assertReviewedWalletCallBatchPlan(
  plan: WalletCallBatchPlan,
  nowMs: number,
): void {
  if (plan.version !== WALLET_CALL_API_VERSION || !plan.atomicRequired) {
    throw new Error(
      "Wallet Call API plan is not the supported atomic v2 format.",
    );
  }
  if (plan.reviewedAtMs > nowMs || nowMs > plan.reviewExpiresAtMs) {
    throw new Error("Wallet Call API review has expired; prepare it again.");
  }
  const recomputed = fingerprint({
    requestId: plan.requestId,
    providerSessionId: plan.providerSessionId,
    account: plan.account,
    chainId: plan.chainId,
    calls: plan.calls,
  });
  if (recomputed !== plan.reviewFingerprint) {
    throw new Error("Wallet Call API plan changed after review.");
  }
}

export function walletCallBatchRecordId(
  chainId: number,
  requestId: string,
): string {
  return `wallet-call:${chainId}:${requestId}`;
}

export function submittedWalletCallBatchRecord(input: {
  plan: WalletCallBatchPlan;
  walletBatchId: string;
  nowMs: number;
}): WalletCallBatchRecord {
  if (!input.walletBatchId || byteLength(input.walletBatchId) > 4096) {
    throw new Error("Wallet returned an invalid Wallet Call API batch ID.");
  }
  return {
    id: walletCallBatchRecordId(input.plan.chainId, input.plan.requestId),
    requestId: input.plan.requestId,
    walletBatchId: input.walletBatchId,
    providerSessionId: input.plan.providerSessionId,
    account: input.plan.account,
    chainId: input.plan.chainId,
    callCount: input.plan.callCount,
    totalNativeValueWei: input.plan.totalNativeValueWei,
    atomicRequired: true,
    state: "submitted",
    transactionHashes: [],
    receipts: [],
    createdAtMs: input.plan.reviewedAtMs,
    updatedAtMs: input.nowMs,
    evidence: "wallet-call-api",
  };
}

export function uncertainWalletCallBatchRecord(input: {
  plan: WalletCallBatchPlan;
  nowMs: number;
  detail: string;
  walletBatchId?: string;
}): WalletCallBatchRecord {
  return {
    id: walletCallBatchRecordId(input.plan.chainId, input.plan.requestId),
    requestId: input.plan.requestId,
    ...(input.walletBatchId ? { walletBatchId: input.walletBatchId } : {}),
    providerSessionId: input.plan.providerSessionId,
    account: input.plan.account,
    chainId: input.plan.chainId,
    callCount: input.plan.callCount,
    totalNativeValueWei: input.plan.totalNativeValueWei,
    atomicRequired: true,
    state: "uncertain",
    transactionHashes: [],
    receipts: [],
    createdAtMs: input.plan.reviewedAtMs,
    updatedAtMs: input.nowMs,
    evidence: "wallet-call-api",
    detail: input.detail,
  };
}

function normalizedState(
  status: number,
  atomicityInconsistent: boolean,
): WalletCallBatchState {
  if (status === 100) return "pending";
  if (status === 200) return atomicityInconsistent ? "unknown" : "included";
  if (status === 400) return "offchain-failed";
  if (status === 500) return "execution-reverted";
  if (status === 600) return "partial-failure";
  return "unknown";
}

function parseReceipt(value: unknown): WalletCallReceiptSummary | null {
  if (!isRecord(value)) return null;
  const transactionHash = value.transactionHash;
  const blockHash = value.blockHash;
  const blockNumber = parseHexQuantity(value.blockNumber);
  const gasUsed = parseHexQuantity(value.gasUsed);
  if (
    !isHexHash(transactionHash) ||
    !isHexHash(blockHash) ||
    blockNumber === null ||
    gasUsed === null ||
    (value.status !== "0x1" && value.status !== "0x0")
  ) {
    return null;
  }
  return {
    transactionHash,
    blockHash,
    blockNumber,
    gasUsed,
    status: value.status === "0x1" ? "success" : "reverted",
  };
}

export function applyWalletCallBatchStatus(input: {
  record: WalletCallBatchRecord;
  response: unknown;
  observedAtMs: number;
}): WalletCallBatchRecord {
  const { record } = input;
  if (!record.walletBatchId || !isRecord(input.response)) {
    throw new Error(
      "Wallet Call API status response is invalid for this batch.",
    );
  }
  const responseId = input.response.id;
  const chainId = parseHexQuantity(input.response.chainId);
  const status = input.response.status;
  const atomic = input.response.atomic;
  if (
    input.response.version !== WALLET_CALL_API_VERSION ||
    responseId !== record.walletBatchId ||
    chainId === null ||
    chainId !== BigInt(record.chainId) ||
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    typeof atomic !== "boolean"
  ) {
    throw new Error(
      "Wallet Call API status response did not match the known batch.",
    );
  }
  const rawReceipts = input.response.receipts;
  if (rawReceipts !== undefined && !Array.isArray(rawReceipts)) {
    throw new Error("Wallet Call API status receipts are malformed.");
  }
  const receipts = (rawReceipts ?? []).map(parseReceipt);
  if (receipts.some((receipt) => receipt === null)) {
    throw new Error(
      "Wallet Call API status contained an invalid receipt summary.",
    );
  }
  const compactReceipts = receipts as WalletCallReceiptSummary[];
  const atomicityInconsistent =
    record.atomicRequired && (atomic !== true || status === 600);
  return {
    ...record,
    atomicReported: atomic,
    ...(atomicityInconsistent ? { atomicityInconsistent: true } : {}),
    rawStatusCode: status,
    state: normalizedState(status, atomicityInconsistent),
    transactionHashes: compactReceipts.map(
      (receipt) => receipt.transactionHash,
    ),
    receipts: compactReceipts,
    updatedAtMs: input.observedAtMs,
    ...(atomicityInconsistent
      ? {
          detail:
            "Wallet status is inconsistent with Patio's requested atomic execution.",
        }
      : {}),
  };
}

export function isTerminalWalletCallBatch(
  record: WalletCallBatchRecord,
): boolean {
  return [
    "included",
    "offchain-failed",
    "execution-reverted",
    "partial-failure",
  ].includes(record.state);
}
