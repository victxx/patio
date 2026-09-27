import type { Address, Hex } from "viem";

import type {
  EoaOperation,
  EoaReplacementActionKind,
  OperationStatus,
} from "./types";

export const DEFAULT_WALLET_REPLACEMENT_BUMP_BPS = 1_500;
export const SIMPLE_EOA_CANCEL_GAS_LIMIT = 21_000n;

export interface EoaAccessListEntry {
  address: Address;
  storageKeys: readonly Hex[];
}

export interface EoaReplacementNetwork {
  chainId: number;
  canonicalSubmissionModel:
    | "public-mempool"
    | "private-mempool"
    | "encrypted-mempool"
    | "sequencer"
    | "unknown";
  sameNonceReplacement:
    "verified" | "documented" | "unverified" | "unsupported" | "unknown";
  replacementPropagation:
    "verified" | "documented" | "unverified" | "unsupported" | "unknown";
}

export interface EoaReplacementEligibilityContext {
  connectedAddress: Address | null;
  connectedChainId: number | null;
  network: EoaReplacementNetwork;
  /** The canonical latest account type, never a wallet guess. */
  accountKind: "plain-eoa" | "eip7702-delegated" | "code-bearing" | "unknown";
}

export interface ReplacementEligibility {
  allowed: boolean;
  reason?: string;
}

export interface EoaReplacementEligibility {
  speedUp: ReplacementEligibility;
  cancel: ReplacementEligibility;
}

function actionable(status: OperationStatus): boolean {
  return status === "submitted" || status === "pending" || status === "unknown";
}

function baseEligibility(
  operation: EoaOperation,
  context: EoaReplacementEligibilityContext,
): ReplacementEligibility {
  if (operation.control !== "wallet-manageable") {
    return { allowed: false, reason: "This operation is read-only." };
  }
  if (operation.source === "patio") {
    return { allowed: false, reason: "Patio setup operations are read-only." };
  }
  if (!actionable(operation.status)) {
    return {
      allowed: false,
      reason: "This transaction is no longer actionable.",
    };
  }
  if (!context.connectedAddress || !context.connectedChainId) {
    return { allowed: false, reason: "Connect the original sending wallet." };
  }
  if (context.connectedAddress.toLowerCase() !== operation.from.toLowerCase()) {
    return {
      allowed: false,
      reason: "Connect the wallet that sent this transaction.",
    };
  }
  if (context.connectedChainId !== operation.chainId) {
    return { allowed: false, reason: "Switch to this transaction's network." };
  }
  if (context.network.chainId !== operation.chainId) {
    return { allowed: false, reason: "Network information is unavailable." };
  }
  if (
    context.network.canonicalSubmissionModel !== "public-mempool" ||
    context.network.sameNonceReplacement !== "verified" ||
    context.network.replacementPropagation !== "verified"
  ) {
    return {
      allowed: false,
      reason: "Replacement is not verified on this network.",
    };
  }
  if (context.accountKind !== "plain-eoa") {
    return {
      allowed: false,
      reason:
        context.accountKind === "eip7702-delegated"
          ? "Speed Up and Cancel are unavailable for delegated EIP-7702 accounts in this version."
          : context.accountKind === "code-bearing"
            ? "Replacement is unavailable for code-bearing accounts."
            : "Account type could not be verified.",
    };
  }
  return { allowed: true };
}

/** Pure policy. It has no RPC, signing, or submission authority. */
export function getEoaReplacementEligibility(
  operation: EoaOperation,
  context: EoaReplacementEligibilityContext,
): EoaReplacementEligibility {
  const base = baseEligibility(operation, context);
  return { speedUp: base, cancel: base };
}

export interface EoaReplacementRpcTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  nonce: bigint;
  transactionType: EoaOperation["transactionType"];
  valueWei: bigint;
  gasLimit: bigint | null;
  gasPriceWei: bigint | null;
  maxFeePerGasWei: bigint | null;
  maxPriorityFeePerGasWei: bigint | null;
  input: Hex;
  accessList?: readonly EoaAccessListEntry[];
}

export interface WalletFeeRecommendation {
  gasPriceWei: bigint;
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
}

export interface EoaReplacementPolicy {
  replacementBumpBps: number;
}

export const DEFAULT_WALLET_REPLACEMENT_POLICY: EoaReplacementPolicy = {
  // Patio product safety margin; this is not an Ethereum consensus rule.
  replacementBumpBps: DEFAULT_WALLET_REPLACEMENT_BUMP_BPS,
};

export interface EoaReplacementPlan {
  action: EoaReplacementActionKind;
  originalOperationId: string;
  originalHash: Hex;
  chainId: number;
  from: Address;
  nonce: bigint;
  transactionType: EoaOperation["transactionType"];
  to: Address | null;
  valueWei: bigint;
  data: Hex;
  gasLimit: bigint;
  accessList?: readonly EoaAccessListEntry[];
  gasPriceWei?: bigint;
  maxFeePerGasWei?: bigint;
  maxPriorityFeePerGasWei?: bigint;
  estimatedMaxCostWei: bigint;
  warnings: readonly string[];
}

function ceilBump(value: bigint, bumpBps: number): bigint {
  if (!Number.isInteger(bumpBps) || bumpBps < 0) {
    throw new Error("Wallet replacement bump must be a non-negative integer.");
  }
  const numerator = value * BigInt(10_000 + bumpBps);
  return (numerator + 9_999n) / 10_000n;
}

function required(value: bigint | null, label: string): bigint {
  if (value === null) throw new Error(`Original ${label} is unavailable.`);
  return value;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function assertOriginalTransactionMatches(
  operation: EoaOperation,
  transaction: EoaReplacementRpcTransaction | null,
): EoaReplacementRpcTransaction {
  if (!transaction) throw new Error("The original transaction is unavailable.");
  if (
    transaction.hash.toLowerCase() !== operation.hash.toLowerCase() ||
    !sameAddress(transaction.from, operation.from) ||
    transaction.nonce !== operation.nonce ||
    transaction.transactionType !== operation.transactionType
  ) {
    throw new Error("The network returned a different original transaction.");
  }
  return transaction;
}

export function createEoaReplacementPlan(input: {
  action: EoaReplacementActionKind;
  operation: EoaOperation;
  original: EoaReplacementRpcTransaction;
  recommendation: WalletFeeRecommendation;
  policy?: EoaReplacementPolicy;
}): EoaReplacementPlan {
  const policy = input.policy ?? DEFAULT_WALLET_REPLACEMENT_POLICY;
  const { original, operation } = input;
  const isCancel = input.action === "cancel";
  const gasLimit = isCancel
    ? SIMPLE_EOA_CANCEL_GAS_LIMIT
    : required(original.gasLimit, "gas limit");
  const common = {
    action: input.action,
    originalOperationId: operation.id,
    originalHash: operation.hash,
    chainId: operation.chainId,
    from: operation.from,
    nonce: operation.nonce,
    transactionType: operation.transactionType,
    to: isCancel ? operation.from : original.to,
    valueWei: isCancel ? 0n : original.valueWei,
    data: isCancel ? ("0x" as Hex) : original.input,
    gasLimit,
    ...(isCancel || !original.accessList
      ? {}
      : { accessList: original.accessList }),
    warnings: isCancel
      ? [
          "Cancel submits a competing zero-value transaction; it does not delete the original.",
          "Only the candidate included onchain consumes execution gas.",
        ]
      : ["The replacement preserves the original transaction intent."],
  } as const;

  if (
    operation.transactionType === "legacy" ||
    operation.transactionType === "eip2930"
  ) {
    const gasPriceWei = [
      ceilBump(
        required(original.gasPriceWei, "gas price"),
        policy.replacementBumpBps,
      ),
      input.recommendation.gasPriceWei,
    ].reduce((left, right) => (left > right ? left : right));
    return {
      ...common,
      gasPriceWei,
      estimatedMaxCostWei: gasLimit * gasPriceWei,
    };
  }
  const maxPriorityFeePerGasWei = [
    ceilBump(
      required(original.maxPriorityFeePerGasWei, "priority fee"),
      policy.replacementBumpBps,
    ),
    input.recommendation.maxPriorityFeePerGasWei,
  ].reduce((left, right) => (left > right ? left : right));
  const maxFeePerGasWei = [
    ceilBump(
      required(original.maxFeePerGasWei, "fee cap"),
      policy.replacementBumpBps,
    ),
    input.recommendation.maxFeePerGasWei,
    maxPriorityFeePerGasWei,
  ].reduce((left, right) => (left > right ? left : right));
  return {
    ...common,
    maxFeePerGasWei,
    maxPriorityFeePerGasWei,
    estimatedMaxCostWei: gasLimit * maxFeePerGasWei,
  };
}

export function doesPlanMeetCurrentFeeFloor(
  plan: EoaReplacementPlan,
  recommendation: WalletFeeRecommendation,
): boolean {
  if (plan.transactionType === "legacy" || plan.transactionType === "eip2930") {
    return (plan.gasPriceWei ?? 0n) >= recommendation.gasPriceWei;
  }
  return (
    (plan.maxFeePerGasWei ?? 0n) >= recommendation.maxFeePerGasWei &&
    (plan.maxPriorityFeePerGasWei ?? 0n) >=
      recommendation.maxPriorityFeePerGasWei
  );
}

function accessListMatches(
  left: readonly EoaAccessListEntry[] | undefined,
  right: readonly EoaAccessListEntry[] | undefined,
): boolean {
  if (!left || left.length === 0) return !right || right.length === 0;
  if (!right || left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      sameAddress(entry.address, candidate.address) &&
      entry.storageKeys.length === candidate.storageKeys.length &&
      entry.storageKeys.every(
        (key, keyIndex) => key === candidate.storageKeys[keyIndex],
      )
    );
  });
}

/** Verifies that a wallet actually sent the reviewed candidate, not merely a hash. */
export function walletSubmissionMatchesPlan(
  plan: EoaReplacementPlan,
  transaction: EoaReplacementRpcTransaction | null,
): boolean {
  if (!transaction) return false;
  if (
    !sameAddress(transaction.from, plan.from) ||
    transaction.nonce !== plan.nonce ||
    transaction.transactionType !== plan.transactionType ||
    transaction.to?.toLowerCase() !== plan.to?.toLowerCase() ||
    transaction.valueWei !== plan.valueWei ||
    transaction.input.toLowerCase() !== plan.data.toLowerCase() ||
    transaction.gasLimit !== plan.gasLimit
  ) {
    return false;
  }
  if (!accessListMatches(plan.accessList, transaction.accessList)) return false;
  if (plan.transactionType === "legacy" || plan.transactionType === "eip2930") {
    return transaction.gasPriceWei === plan.gasPriceWei;
  }
  return (
    transaction.maxFeePerGasWei === plan.maxFeePerGasWei &&
    transaction.maxPriorityFeePerGasWei === plan.maxPriorityFeePerGasWei
  );
}
