import {
  atomicBatchAvailability,
  createWalletCallBatchPlan,
  type WalletCallBatchPlan,
  type WalletCallCapabilitySnapshot,
} from "@patio/wallet-core";
import { type PatioNetworkProfile } from "@patio/config";
import { PATIO_REGISTRY_ABI, type FeePlan } from "@patio/ethereum";
import {
  classifyAccountCode,
  type AccountCodeClassification,
} from "@patio/wallet-core";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import {
  directFundingRequirementForSweepGas,
  DIRECT_PLAIN_EOA_SWEEP_GAS,
} from "./direct-plan";
import type { DirectSessionDescriptor } from "./direct-hoodi";

const BASIS_POINTS = 10_000n;
const RETURN_GAS_MARGIN_BPS = 12_000n;
/** A conscious safety bound for a session's native-token return, not a global gas change. */
export const MAX_CODE_BEARING_RETURN_GAS = 300_000n;

export type PatioSetupMode = "classic" | "wallet-atomic";

export interface ReturnRecipientSnapshot {
  code: Hex;
  classification: AccountCodeClassification;
}

export interface PatioReturnPlan {
  recipient: Address;
  recipientCode: Hex;
  recipientCodeKind: AccountCodeClassification["kind"];
  sweepGasLimit: bigint;
  cleanupReserveWei: bigint;
  maximumExposureWei: bigint;
  safetyMarginWei: bigint;
  requiredFundingWei: bigint;
  /** The simulation result before Patio's bounded safety margin, if it was needed. */
  estimatedSweepGas?: bigint;
}

export interface AtomicRegistryAnnouncement {
  registry: Address;
  streamId: Hex;
  sessionAddress: Address;
  nonceStart: bigint;
  expiresAt: bigint;
  mediaMode: 0 | 1;
}

/**
 * Patio's deliberately narrow exception to the generic Wallet Call planner:
 * it permits exactly a registry announcement and a funding transfer. It does
 * not accept generic operation references, media calls, or cleanup calls.
 */
export interface AtomicPublicSetupPlan {
  attemptId: string;
  mode: "wallet-atomic";
  providerSessionId: string;
  account: Address;
  chainId: number;
  descriptor: DirectSessionDescriptor;
  announcement: AtomicRegistryAnnouncement;
  fundingAmountWei: bigint;
  returnPlan: PatioReturnPlan;
  capabilitySnapshot: WalletCallCapabilitySnapshot;
  reviewedAtMs: number;
  reviewExpiresAtMs: number;
  walletCallPlan: WalletCallBatchPlan;
}

export interface AtomicSetupAttemptRecord {
  id: string;
  providerSessionId: string;
  account: Address;
  chainId: number;
  sessionAddress: Address;
  streamId: Hex;
  requestedFundingWei: bigint;
  state:
    | "prepared"
    | "dispatching"
    | "submitted"
    | "uncertain"
    | "verified"
    | "held"
    | "rejected";
  createdAtMs: number;
  updatedAtMs: number;
  walletBatchId?: string;
  detail?: string;
}

export type AtomicSetupReadiness =
  "verified" | "awaiting-verification" | "held";

/** Pure evidence gate: wallet status never starts Patio media by itself. */
export function assessAtomicSetupReadiness(input: {
  walletState:
    | "submitted"
    | "uncertain"
    | "pending"
    | "included"
    | "offchain-failed"
    | "execution-reverted"
    | "partial-failure"
    | "unknown";
  atomicReported?: boolean | undefined;
  atomicityInconsistent?: boolean | undefined;
  canonicalReceiptCount: number;
  allCanonicalReceiptsSuccessful: boolean;
  exactAnnouncementObserved?: boolean | undefined;
  announcementStillValid?: boolean | undefined;
  sufficientSessionBalance?: boolean | undefined;
  sessionIsFreshPlainEoa?: boolean | undefined;
}): { readiness: AtomicSetupReadiness; reason: string } {
  if (
    input.walletState === "submitted" ||
    input.walletState === "uncertain" ||
    input.walletState === "pending" ||
    input.walletState === "unknown"
  ) {
    return {
      readiness: "awaiting-verification",
      reason: "Wallet execution is not terminal yet.",
    };
  }
  if (
    input.walletState !== "included" ||
    input.atomicReported !== true ||
    input.atomicityInconsistent
  ) {
    return {
      readiness: "held",
      reason: "Wallet did not report a successful, atomic setup outcome.",
    };
  }
  if (input.canonicalReceiptCount === 0) {
    return {
      readiness: "awaiting-verification",
      reason: "Wallet success needs canonical receipt references.",
    };
  }
  if (!input.allCanonicalReceiptsSuccessful) {
    return {
      readiness: "awaiting-verification",
      reason:
        "Canonical setup receipts are not all available and successful yet.",
    };
  }
  if (
    input.exactAnnouncementObserved === undefined ||
    input.sufficientSessionBalance === undefined ||
    input.sessionIsFreshPlainEoa === undefined
  ) {
    return {
      readiness: "awaiting-verification",
      reason:
        "Canonical registry, funding and session-state evidence is incomplete.",
    };
  }
  if (
    !input.exactAnnouncementObserved ||
    input.announcementStillValid === false ||
    !input.sufficientSessionBalance ||
    !input.sessionIsFreshPlainEoa
  ) {
    return {
      readiness: "held",
      reason: "Canonical evidence contradicts the reviewed Patio setup plan.",
    };
  }
  return {
    readiness: "verified",
    reason: "Canonical setup evidence verified.",
  };
}

export const ATOMIC_PUBLIC_SETUP_STORAGE_KEY =
  "patio.atomic-public-setup-attempts.v1";
const MAX_ATOMIC_SETUP_ATTEMPTS = 10;

export function atomicPublicSetupFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PATIO_EXPERIMENTAL_ATOMIC_SETUP === "true";
}

function ceilingBps(value: bigint, bps: bigint): bigint {
  return (value * bps + BASIS_POINTS - 1n) / BASIS_POINTS;
}

export function snapshotReturnRecipient(code: Hex): ReturnRecipientSnapshot {
  return { code, classification: classifyAccountCode(code) };
}

/**
 * A plain recipient keeps the historical 21k reserve byte-for-byte. A
 * code-bearing recipient needs a successful state-aware estimate before it
 * can receive temporary funds from a pre-funded session.
 */
export function createPatioReturnPlan(input: {
  recipient: Address;
  recipientSnapshot: ReturnRecipientSnapshot;
  feePlan: FeePlan;
  estimatedSweepGas?: bigint;
}): PatioReturnPlan {
  const recipient = getAddress(input.recipient);
  const plainRecipient =
    input.recipientSnapshot.classification.kind === "no-code";
  let sweepGasLimit = DIRECT_PLAIN_EOA_SWEEP_GAS;
  if (!plainRecipient) {
    if (!input.estimatedSweepGas || input.estimatedSweepGas <= 0n) {
      throw new Error(
        "Patio could not safely estimate the return transfer for this code-bearing operator account.",
      );
    }
    sweepGasLimit = ceilingBps(input.estimatedSweepGas, RETURN_GAS_MARGIN_BPS);
    if (sweepGasLimit < DIRECT_PLAIN_EOA_SWEEP_GAS) {
      sweepGasLimit = DIRECT_PLAIN_EOA_SWEEP_GAS;
    }
    if (sweepGasLimit > MAX_CODE_BEARING_RETURN_GAS) {
      throw new Error(
        "The operator return transfer exceeds Patio's bounded session return-gas limit.",
      );
    }
  }
  const funding = directFundingRequirementForSweepGas(
    input.feePlan,
    sweepGasLimit,
  );
  return {
    recipient,
    recipientCode: input.recipientSnapshot.code,
    recipientCodeKind: input.recipientSnapshot.classification.kind,
    sweepGasLimit,
    ...funding,
    ...(!plainRecipient ? { estimatedSweepGas: input.estimatedSweepGas } : {}),
  };
}

export function assertReturnPlanFitsNetwork(
  returnPlan: PatioReturnPlan,
  network: PatioNetworkProfile,
): void {
  if (
    returnPlan.requiredFundingWei > network.safety.maximumSessionExposureWei
  ) {
    throw new Error(
      `The return reserve exceeds Patio's ${network.nativeCurrency.symbol} session safety limit.`,
    );
  }
  if (returnPlan.requiredFundingWei <= returnPlan.cleanupReserveWei) {
    throw new Error(
      "The planned session has no positive amount available to return.",
    );
  }
}

export function registryAnnouncementData(
  announcement: AtomicRegistryAnnouncement,
): Hex {
  return encodeFunctionData({
    abi: PATIO_REGISTRY_ABI,
    functionName: "announce",
    args: [
      announcement.streamId,
      announcement.sessionAddress,
      announcement.nonceStart,
      announcement.expiresAt,
      announcement.mediaMode,
    ],
  });
}

export function createAtomicPublicSetupPlan(input: {
  attemptId: string;
  providerSessionId: string;
  account: Address;
  chainId: number;
  descriptor: DirectSessionDescriptor;
  announcement: AtomicRegistryAnnouncement;
  fundingAmountWei: bigint;
  returnPlan: PatioReturnPlan;
  capabilities: WalletCallCapabilitySnapshot;
  reviewedAtMs: number;
  reviewExpiresAtMs?: number;
}): AtomicPublicSetupPlan {
  const availability = atomicBatchAvailability(input.capabilities);
  if (!availability.allowed) {
    throw new Error(
      availability.reason ?? "Atomic Wallet Call API execution is unavailable.",
    );
  }
  if (input.descriptor.operator.toLowerCase() !== input.account.toLowerCase()) {
    throw new Error("Atomic setup must use the connected operator account.");
  }
  if (input.descriptor.chainId !== input.chainId) {
    throw new Error(
      "Atomic setup chain does not match the session descriptor.",
    );
  }
  if (input.announcement.sessionAddress !== input.descriptor.sessionAddress) {
    throw new Error(
      "Atomic setup announcement does not match the session address.",
    );
  }
  if (input.fundingAmountWei !== input.returnPlan.requiredFundingWei) {
    throw new Error(
      "Atomic setup funding does not match its reviewed return reserve.",
    );
  }
  const walletCallPlan = createWalletCallBatchPlan({
    requestId: input.attemptId,
    providerSessionId: input.providerSessionId,
    account: input.account,
    chainId: input.chainId,
    capabilities: input.capabilities,
    reviewedAtMs: input.reviewedAtMs,
    ...(input.reviewExpiresAtMs === undefined
      ? {}
      : { reviewExpiresAtMs: input.reviewExpiresAtMs }),
    // This is intentionally a closed Patio setup plan, not a generic
    // operation batch. Generic Patio operations remain protected.
    calls: [
      {
        to: input.announcement.registry,
        data: registryAnnouncementData(input.announcement),
        valueWei: 0n,
      },
      {
        to: input.descriptor.sessionAddress,
        data: "0x",
        valueWei: input.fundingAmountWei,
      },
    ],
  });
  if (
    walletCallPlan.callCount !== 2 ||
    walletCallPlan.calls[1]?.data !== "0x"
  ) {
    throw new Error(
      "Atomic Patio setup must contain exactly announce then funding.",
    );
  }
  return {
    attemptId: input.attemptId,
    mode: "wallet-atomic",
    providerSessionId: input.providerSessionId,
    account: getAddress(input.account),
    chainId: input.chainId,
    descriptor: input.descriptor,
    announcement: input.announcement,
    fundingAmountWei: input.fundingAmountWei,
    returnPlan: input.returnPlan,
    capabilitySnapshot: input.capabilities,
    reviewedAtMs: input.reviewedAtMs,
    reviewExpiresAtMs: walletCallPlan.reviewExpiresAtMs,
    walletCallPlan,
  };
}

export function decodeRegistryOperatorApproval(result: Hex): boolean {
  return decodeFunctionResult({
    abi: PATIO_REGISTRY_ABI,
    functionName: "approvedOperators",
    data: result,
  });
}

export function decodeRegistryStreamOperator(result: Hex): Address {
  return getAddress(
    decodeFunctionResult({
      abi: PATIO_REGISTRY_ABI,
      functionName: "streamOperators",
      data: result,
    }),
  );
}

export function mayUseExistingStreamOperator(
  currentOperator: Address,
  intendedOperator: Address,
): boolean {
  return (
    currentOperator.toLowerCase() === zeroAddress ||
    currentOperator.toLowerCase() === intendedOperator.toLowerCase()
  );
}

function asStoredAttempt(value: unknown): AtomicSetupAttemptRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.providerSessionId !== "string" ||
    typeof record.account !== "string" ||
    typeof record.chainId !== "number" ||
    typeof record.sessionAddress !== "string" ||
    typeof record.streamId !== "string" ||
    typeof record.requestedFundingWei !== "string" ||
    typeof record.state !== "string" ||
    typeof record.createdAtMs !== "number" ||
    typeof record.updatedAtMs !== "number"
  )
    return null;
  try {
    return {
      id: record.id,
      providerSessionId: record.providerSessionId,
      account: getAddress(record.account),
      chainId: record.chainId,
      sessionAddress: getAddress(record.sessionAddress),
      streamId: record.streamId as Hex,
      requestedFundingWei: BigInt(record.requestedFundingWei),
      state: record.state as AtomicSetupAttemptRecord["state"],
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      ...(typeof record.walletBatchId === "string"
        ? { walletBatchId: record.walletBatchId }
        : {}),
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    };
  } catch {
    return null;
  }
}

function serializeAttempts(
  attempts: readonly AtomicSetupAttemptRecord[],
): string {
  return JSON.stringify({
    version: 1,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      requestedFundingWei: attempt.requestedFundingWei.toString(),
    })),
  });
}

export function loadAtomicSetupAttempts(
  storage: Pick<Storage, "getItem">,
): readonly AtomicSetupAttemptRecord[] {
  try {
    const parsed = JSON.parse(
      storage.getItem(ATOMIC_PUBLIC_SETUP_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return [];
    const attempts = (parsed as { attempts?: unknown }).attempts;
    return Array.isArray(attempts)
      ? attempts
          .map(asStoredAttempt)
          .filter((value): value is AtomicSetupAttemptRecord => value !== null)
      : [];
  } catch {
    return [];
  }
}

/**
 * Persist-before-dispatch guard. It is a best-effort cross-tab claim, never a
 * claim of universal exactly-once wallet execution.
 */
export function reserveAtomicSetupAttempt(
  storage: Pick<Storage, "getItem" | "setItem">,
  attempt: AtomicSetupAttemptRecord,
): void {
  const existing = loadAtomicSetupAttempts(storage);
  const unresolved = existing.find(
    (candidate) =>
      candidate.account.toLowerCase() === attempt.account.toLowerCase() &&
      candidate.chainId === attempt.chainId &&
      ["dispatching", "submitted", "uncertain", "held"].includes(
        candidate.state,
      ),
  );
  if (unresolved) {
    throw new Error(
      "An earlier atomic setup attempt for this wallet still needs reconciliation before another can be sent.",
    );
  }
  const next = [...existing, attempt].slice(-MAX_ATOMIC_SETUP_ATTEMPTS);
  try {
    storage.setItem(ATOMIC_PUBLIC_SETUP_STORAGE_KEY, serializeAttempts(next));
    const persisted = loadAtomicSetupAttempts(storage).some(
      (candidate) => candidate.id === attempt.id,
    );
    if (!persisted)
      throw new Error("Atomic setup attempt storage was not retained.");
  } catch (cause) {
    throw new Error(
      cause instanceof Error
        ? `Atomic setup was blocked because its recovery record could not be stored: ${cause.message}`
        : "Atomic setup was blocked because its recovery record could not be stored.",
    );
  }
}

export function updateAtomicSetupAttempt(
  storage: Pick<Storage, "getItem" | "setItem">,
  id: string,
  patch: Pick<AtomicSetupAttemptRecord, "state" | "updatedAtMs"> &
    Partial<Pick<AtomicSetupAttemptRecord, "walletBatchId" | "detail">>,
): void {
  const attempts = loadAtomicSetupAttempts(storage).map((attempt) =>
    attempt.id === id ? { ...attempt, ...patch } : attempt,
  );
  storage.setItem(ATOMIC_PUBLIC_SETUP_STORAGE_KEY, serializeAttempts(attempts));
}
