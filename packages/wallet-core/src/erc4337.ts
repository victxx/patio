import { getAddress, isAddress, isHex, keccak256, stringToHex } from "viem";
import type { Address, Hex } from "viem";

import type {
  Erc4337Evidence,
  Erc4337GasPayment,
  Erc4337Operation,
  Erc4337OperationState,
} from "./types";

export const ERC4337_ENTRY_POINT_V07 = getAddress(
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
);
export const ERC4337_ENTRY_POINT_VERSION = "0.7" as const;
export const ERC4337_SIMPLE_ACCOUNT_V07 = "simple-account-v0.7.0" as const;
export const ERC4337_DEFAULT_MAX_OPERATION_COST_WEI = 10_000_000_000_000_000n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export interface Erc4337OrdinaryCall {
  to: Address;
  valueWei: bigint;
  data: Hex;
}

export interface Erc4337GasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}

export interface Erc4337UserOperationV07 {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  signature: Hex;
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
}

export type Erc4337ReviewedGasPayment =
  | { kind: "self-paid" }
  | {
      kind: "sponsored";
      sponsorId: string;
      profile: "verifying-paymaster-v0.7.0";
      paymaster: Address;
      paymasterData: Hex;
      validAfter: bigint;
      validUntil: bigint;
      maximumSponsoredGasCostWei: bigint;
      paymasterCodeHash: Hex;
    };

export interface ReviewedErc4337Plan {
  version: 1;
  attemptId: string;
  chainId: number;
  entryPoint: Address;
  entryPointVersion: "0.7";
  accountImplementation: typeof ERC4337_SIMPLE_ACCOUNT_V07;
  sender: Address;
  ownerContextId: string;
  nonce: bigint;
  nonceKey: bigint;
  calls: readonly Erc4337OrdinaryCall[];
  callData: Hex;
  totalNativeValueWei: bigint;
  gas: Erc4337GasEstimate;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maximumGasCostWei: bigint;
  maximumTotalCostWei: bigint;
  operationBudgetWei: bigint;
  gasPayment: Erc4337ReviewedGasPayment;
  preparedAtMs: number;
  reviewExpiresAtMs: number;
  reviewFingerprint: Hex;
}

export type Erc4337PreparationBlockCode =
  | "ACCOUNT_ADAPTER_REQUIRED"
  | "UNSUPPORTED_ENTRY_POINT_VERSION"
  | "WRONG_CHAIN"
  | "WRONG_ENTRY_POINT"
  | "ACCOUNT_NOT_DEPLOYED"
  | "PROTECTED_PATIO_OPERATION"
  | "DEPLOYMENT_NOT_SUPPORTED"
  | "PAYMASTER_NOT_SUPPORTED"
  | "PAYMASTER_CONFIGURATION_REQUIRED"
  | "PAYMASTER_RESPONSE_INVALID"
  | "PAYMASTER_DEPOSIT_INSUFFICIENT"
  | "SPONSORSHIP_EXPIRED"
  | "SPONSORSHIP_UNAVAILABLE"
  | "EIP7702_NOT_SUPPORTED"
  | "INSUFFICIENT_PREFUND"
  | "OPERATION_BUDGET_EXCEEDED"
  | "INVALID_INTENT";

export class Erc4337PreparationError extends Error {
  public constructor(
    public readonly code: Erc4337PreparationBlockCode,
    message: string,
  ) {
    super(message);
    this.name = "Erc4337PreparationError";
  }
}

function positiveBigint(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      `${label} must be greater than zero.`,
    );
  }
}

export function validateOrdinaryErc4337Calls(
  calls: readonly Erc4337OrdinaryCall[],
): void {
  if (calls.length < 1 || calls.length > 16) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "An ordinary ERC-4337 plan requires between 1 and 16 calls.",
    );
  }
  for (const call of calls) {
    if (!isAddress(call.to) || !isHex(call.data, { strict: true })) {
      throw new Erc4337PreparationError(
        "INVALID_INTENT",
        "ERC-4337 call address or calldata is invalid.",
      );
    }
    if (call.valueWei < 0n) {
      throw new Erc4337PreparationError(
        "INVALID_INTENT",
        "ERC-4337 call value cannot be negative.",
      );
    }
  }
}

export function maximumErc4337GasCost(input: {
  gas: Erc4337GasEstimate;
  maxFeePerGas: bigint;
}): bigint {
  positiveBigint(input.gas.callGasLimit, "Call gas limit");
  positiveBigint(input.gas.verificationGasLimit, "Verification gas limit");
  positiveBigint(input.gas.preVerificationGas, "Pre-verification gas");
  if (input.gas.paymasterVerificationGasLimit !== undefined)
    positiveBigint(
      input.gas.paymasterVerificationGasLimit,
      "Paymaster verification gas limit",
    );
  if (input.gas.paymasterPostOpGasLimit !== undefined)
    positiveBigint(
      input.gas.paymasterPostOpGasLimit,
      "Paymaster post-operation gas limit",
    );
  positiveBigint(input.maxFeePerGas, "Maximum fee per gas");
  const maximum =
    (input.gas.callGasLimit +
      input.gas.verificationGasLimit +
      input.gas.preVerificationGas +
      // EntryPoint v0.7 charges these paymaster-specific terms directly.
      (input.gas.paymasterVerificationGasLimit ?? 0n) +
      (input.gas.paymasterPostOpGasLimit ?? 0n)) *
    input.maxFeePerGas;
  if (maximum > MAX_UINT256) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "ERC-4337 maximum gas charge exceeds uint256 bounds.",
    );
  }
  return maximum;
}

export function assertErc4337V07NumericBounds(input: {
  gas: Erc4337GasEstimate;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): void {
  const packedValues = [
    input.gas.callGasLimit,
    input.gas.verificationGasLimit,
    input.gas.paymasterVerificationGasLimit ?? 0n,
    input.gas.paymasterPostOpGasLimit ?? 0n,
    input.maxFeePerGas,
    input.maxPriorityFeePerGas,
  ];
  if (packedValues.some((value) => value < 0n || value > MAX_UINT128)) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "EntryPoint v0.7 packed gas or fee field exceeds uint128 bounds.",
    );
  }
  if (input.gas.preVerificationGas < 0n) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "Pre-verification gas cannot be negative.",
    );
  }
}

export function assertErc4337OperationBudget(input: {
  maximumGasCostWei: bigint;
  totalNativeValueWei: bigint;
  operationBudgetWei: bigint;
}): void {
  positiveBigint(input.operationBudgetWei, "Operation budget");
  const maximumTotalCostWei =
    input.maximumGasCostWei + input.totalNativeValueWei;
  if (maximumTotalCostWei > input.operationBudgetWei) {
    throw new Erc4337PreparationError(
      "OPERATION_BUDGET_EXCEEDED",
      "The reviewed ERC-4337 operation exceeds its independent operation budget.",
    );
  }
}

export function fingerprintReviewedErc4337Plan(input: {
  attemptId: string;
  chainId: number;
  entryPoint: Address;
  sender: Address;
  ownerContextId: string;
  nonce: bigint;
  nonceKey: bigint;
  callData: Hex;
  gas: Erc4337GasEstimate;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  totalNativeValueWei: bigint;
  maximumGasCostWei: bigint;
  maximumTotalCostWei: bigint;
  operationBudgetWei: bigint;
  gasPayment: Erc4337ReviewedGasPayment;
  preparedAtMs: number;
}): Hex {
  const paymentFingerprint =
    input.gasPayment.kind === "self-paid"
      ? "self-paid"
      : [
          "sponsored",
          input.gasPayment.sponsorId,
          input.gasPayment.profile,
          input.gasPayment.paymaster.toLowerCase(),
          input.gasPayment.paymasterData.toLowerCase(),
          input.gasPayment.validAfter,
          input.gasPayment.validUntil,
          input.gasPayment.maximumSponsoredGasCostWei,
          input.gasPayment.paymasterCodeHash.toLowerCase(),
        ].join("|");
  return keccak256(
    stringToHex(
      [
        input.attemptId,
        input.chainId,
        input.entryPoint.toLowerCase(),
        input.sender.toLowerCase(),
        input.ownerContextId,
        input.nonce,
        input.nonceKey,
        input.callData.toLowerCase(),
        input.gas.callGasLimit,
        input.gas.verificationGasLimit,
        input.gas.preVerificationGas,
        input.gas.paymasterVerificationGasLimit ?? 0n,
        input.gas.paymasterPostOpGasLimit ?? 0n,
        input.maxFeePerGas,
        input.maxPriorityFeePerGas,
        input.totalNativeValueWei,
        input.maximumGasCostWei,
        input.maximumTotalCostWei,
        input.operationBudgetWei,
        paymentFingerprint,
        input.preparedAtMs,
      ].join(":"),
    ),
  );
}

export function assertReviewedErc4337Plan(
  plan: ReviewedErc4337Plan,
  nowMs: number,
): void {
  if (plan.entryPointVersion !== ERC4337_ENTRY_POINT_VERSION) {
    throw new Erc4337PreparationError(
      "UNSUPPORTED_ENTRY_POINT_VERSION",
      "Only EntryPoint v0.7 is supported by this adapter.",
    );
  }
  if (plan.entryPoint.toLowerCase() !== ERC4337_ENTRY_POINT_V07.toLowerCase()) {
    throw new Erc4337PreparationError(
      "WRONG_ENTRY_POINT",
      "The reviewed plan targets an unsupported EntryPoint address.",
    );
  }
  if (nowMs > plan.reviewExpiresAtMs) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "The ERC-4337 review expired; prepare it again.",
    );
  }
  const fingerprint = fingerprintReviewedErc4337Plan(plan);
  if (fingerprint.toLowerCase() !== plan.reviewFingerprint.toLowerCase()) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "The reviewed ERC-4337 plan was modified.",
    );
  }
}

export function erc4337OperationId(input: {
  chainId: number;
  entryPoint: Address;
  userOpHash: Hex;
}): string {
  return `erc4337:${input.chainId}:${input.entryPoint.toLowerCase()}:${input.userOpHash.toLowerCase()}`;
}

export function createErc4337Operation(input: {
  chainId: number;
  entryPoint: Address;
  userOpHash: Hex;
  sender: Address;
  nonce: bigint;
  nonceKey?: bigint;
  nonceSequence?: bigint;
  state: Erc4337OperationState;
  evidence: Erc4337Evidence;
  nowMs: number;
  label?: string;
  gasPayment?: Erc4337GasPayment;
}): Erc4337Operation {
  const operation: Erc4337Operation = {
    id: erc4337OperationId(input),
    executionType: "erc4337",
    chainId: input.chainId,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    source: "external",
    control: "read-only",
    status:
      input.state === "included-success"
        ? "included"
        : input.state === "included-reverted" || input.state === "rejected"
          ? "failed"
          : input.state === "submitted"
            ? "submitted"
            : input.state === "unknown" || input.state === "uncertain"
              ? "unknown"
              : "created",
    ...(input.label ? { label: input.label } : {}),
    userOpHash: input.userOpHash,
    sender: input.sender,
    nonce: input.nonce,
    entryPoint: input.entryPoint,
    entryPointVersion: ERC4337_ENTRY_POINT_VERSION,
    accountImplementation: ERC4337_SIMPLE_ACCOUNT_V07,
    operationState: input.state,
    evidence: input.evidence,
    gasPayment: input.gasPayment ?? { kind: "self-paid" },
    ...(input.nonceKey === undefined ? {} : { nonceKey: input.nonceKey }),
    ...(input.nonceSequence === undefined
      ? {}
      : { nonceSequence: input.nonceSequence }),
  };
  return operation;
}
