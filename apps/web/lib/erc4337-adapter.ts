import {
  ERC4337_DEFAULT_MAX_OPERATION_COST_WEI,
  ERC4337_ENTRY_POINT_V07,
  ERC4337_ENTRY_POINT_VERSION,
  ERC4337_SIMPLE_ACCOUNT_V07,
  Erc4337PreparationError,
  assertErc4337OperationBudget,
  assertErc4337V07NumericBounds,
  assertReviewedErc4337Plan,
  createErc4337Operation,
  fingerprintReviewedErc4337Plan,
  maximumErc4337GasCost,
  validateOrdinaryErc4337Calls,
  type Erc4337OrdinaryCall,
  type Erc4337GasPayment,
  type Erc4337UserOperationV07,
  type OperationStorage,
  type ReviewedErc4337Plan,
} from "@patio/wallet-core";
import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { getUserOperationHash } from "viem/account-abstraction";

import type { PatioBundlerClient } from "./erc4337-bundler";
import {
  BundlerRpcError,
  type BundlerUserOperationReceipt,
} from "./erc4337-bundler";
import {
  PaymasterServiceError,
  paymasterCodeMatches,
} from "./erc4337-paymaster";
import type { PatioPaymasterClient } from "./erc4337-paymaster";

const SIMPLE_ACCOUNT_V07_ABI = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
]);
const USER_OPERATION_EVENT_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const ESTIMATION_STUB_SIGNATURE =
  `0x${"0".repeat(63)}1${"0".repeat(63)}11b` as Hex;
const DEFAULT_REVIEW_TTL_MS = 2 * 60 * 1_000;
const ATTEMPT_STORAGE_KEY = "patio.wallet.erc4337.attempts.v1";
const MAX_ATTEMPTS = 50;

export interface Erc4337CanonicalLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
}

export interface Erc4337CanonicalReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
  logs: readonly Erc4337CanonicalLog[];
}

/** Read-only chain boundary. No sender or private-key method exists here. */
export interface Erc4337ChainReader {
  chainId(): Promise<number>;
  latestTimestamp(): Promise<bigint>;
  code(address: Address): Promise<Hex>;
  balance(address: Address): Promise<bigint>;
  entryPointNonce(input: {
    entryPoint: Address;
    sender: Address;
    key: bigint;
  }): Promise<bigint>;
  entryPointDeposit(input: {
    entryPoint: Address;
    sender: Address;
  }): Promise<bigint>;
  receipt(hash: Hex): Promise<Erc4337CanonicalReceipt | null>;
}

export interface SimpleAccountV07Integration {
  readonly id: typeof ERC4337_SIMPLE_ACCOUNT_V07;
  readonly sender: Address;
  readonly entryPoint: typeof ERC4337_ENTRY_POINT_V07;
  readonly entryPointVersion: typeof ERC4337_ENTRY_POINT_VERSION;
  readonly ownerContextId: string;
  readonly nonceKey: bigint;
  readonly supportsMissingAccountFunds: true;
  encodeCalls(calls: readonly Erc4337OrdinaryCall[]): Hex;
  estimationStubSignature(): Hex;
  signUserOperationHash(input: {
    userOpHash: Hex;
    chainId: number;
    entryPoint: Address;
    sender: Address;
  }): Promise<Hex>;
}

export function createSimpleAccountV07Integration(input: {
  sender: Address;
  ownerContextId: string;
  signUserOperationHash(input: {
    userOpHash: Hex;
    chainId: number;
    entryPoint: Address;
    sender: Address;
  }): Promise<Hex>;
  nonceKey?: bigint;
}): SimpleAccountV07Integration {
  if (!isAddress(input.sender) || input.ownerContextId.trim().length === 0) {
    throw new Erc4337PreparationError(
      "ACCOUNT_ADAPTER_REQUIRED",
      "A configured SimpleAccount v0.7 integration is required.",
    );
  }
  return {
    id: ERC4337_SIMPLE_ACCOUNT_V07,
    sender: getAddress(input.sender),
    entryPoint: ERC4337_ENTRY_POINT_V07,
    entryPointVersion: ERC4337_ENTRY_POINT_VERSION,
    ownerContextId: input.ownerContextId,
    nonceKey: input.nonceKey ?? 0n,
    supportsMissingAccountFunds: true,
    encodeCalls(calls) {
      validateOrdinaryErc4337Calls(calls);
      if (calls.length === 1) {
        const call = calls[0]!;
        return encodeFunctionData({
          abi: SIMPLE_ACCOUNT_V07_ABI,
          functionName: "execute",
          args: [call.to, call.valueWei, call.data],
        });
      }
      return encodeFunctionData({
        abi: SIMPLE_ACCOUNT_V07_ABI,
        functionName: "executeBatch",
        args: [
          calls.map((call) => call.to),
          calls.map((call) => call.valueWei),
          calls.map((call) => call.data),
        ],
      });
    },
    estimationStubSignature() {
      return ESTIMATION_STUB_SIGNATURE;
    },
    signUserOperationHash: (request) => input.signUserOperationHash(request),
  };
}

export interface PrepareErc4337Input {
  attemptId: string;
  chainId: number;
  account?: SimpleAccountV07Integration;
  calls: readonly Erc4337OrdinaryCall[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  operationBudgetWei?: bigint;
  chain: Erc4337ChainReader;
  bundler: PatioBundlerClient;
  nowMs?: number;
  reviewTtlMs?: number;
  protectedPatioOperation?: boolean;
  factory?: Address;
  paymaster?: Address;
  authorization?: unknown;
}

function assertNoUnsupportedFields(input: PrepareErc4337Input): void {
  if (input.protectedPatioOperation) {
    throw new Erc4337PreparationError(
      "PROTECTED_PATIO_OPERATION",
      "Patio Broadcast and setup operations cannot enter the ERC-4337 adapter.",
    );
  }
  if (input.factory) {
    throw new Erc4337PreparationError(
      "DEPLOYMENT_NOT_SUPPORTED",
      "This adapter supports deployed accounts only.",
    );
  }
  if (input.paymaster) {
    throw new Erc4337PreparationError(
      "PAYMASTER_NOT_SUPPORTED",
      "Paymasters are not supported by this self-paid adapter.",
    );
  }
  if (input.authorization !== undefined) {
    throw new Erc4337PreparationError(
      "EIP7702_NOT_SUPPORTED",
      "EIP-7702 authorization fields are not accepted by this adapter.",
    );
  }
}

function unsignedOperation(
  plan: Pick<
    ReviewedErc4337Plan,
    | "sender"
    | "nonce"
    | "callData"
    | "gas"
    | "gasPayment"
    | "maxFeePerGas"
    | "maxPriorityFeePerGas"
  >,
  signature: Hex,
): Erc4337UserOperationV07 {
  return {
    sender: plan.sender,
    nonce: plan.nonce,
    callData: plan.callData,
    callGasLimit: plan.gas.callGasLimit,
    verificationGasLimit: plan.gas.verificationGasLimit,
    preVerificationGas: plan.gas.preVerificationGas,
    maxFeePerGas: plan.maxFeePerGas,
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    ...(plan.gasPayment.kind === "sponsored"
      ? {
          paymaster: plan.gasPayment.paymaster,
          paymasterVerificationGasLimit: plan.gas.paymasterVerificationGasLimit,
          paymasterPostOpGasLimit: plan.gas.paymasterPostOpGasLimit,
          paymasterData: plan.gasPayment.paymasterData,
        }
      : {}),
    signature,
  };
}

export function userOperationHashV07(input: {
  operation: Erc4337UserOperationV07;
  chainId: number;
  entryPoint?: Address;
}): Hex {
  return getUserOperationHash({
    userOperation: input.operation,
    entryPointAddress: input.entryPoint ?? ERC4337_ENTRY_POINT_V07,
    entryPointVersion: ERC4337_ENTRY_POINT_VERSION,
    chainId: input.chainId,
  });
}

async function assertRuntimeBinding(input: {
  plan?: ReviewedErc4337Plan;
  chainId: number;
  account: SimpleAccountV07Integration;
  chain: Erc4337ChainReader;
  bundler: PatioBundlerClient;
}): Promise<{ nonce: bigint; accountBalance: bigint; deposit: bigint }> {
  const [chainId, bundlerChainId, entryPoints, accountCode, entryPointCode] =
    await Promise.all([
      input.chain.chainId(),
      input.bundler.chainId(),
      input.bundler.supportedEntryPoints(),
      input.chain.code(input.account.sender),
      input.chain.code(input.account.entryPoint),
    ]);
  if (chainId !== input.chainId || bundlerChainId !== input.chainId) {
    throw new Erc4337PreparationError(
      "WRONG_CHAIN",
      "Chain RPC, bundler and reviewed operation must use the same chain.",
    );
  }
  if (
    input.account.entryPointVersion !== ERC4337_ENTRY_POINT_VERSION ||
    input.account.entryPoint.toLowerCase() !==
      ERC4337_ENTRY_POINT_V07.toLowerCase() ||
    !entryPoints.some(
      (entryPoint) =>
        entryPoint.toLowerCase() === input.account.entryPoint.toLowerCase(),
    ) ||
    entryPointCode === "0x"
  ) {
    throw new Erc4337PreparationError(
      "WRONG_ENTRY_POINT",
      "The configured EntryPoint v0.7 binding is not supported or deployed.",
    );
  }
  if (accountCode === "0x") {
    throw new Erc4337PreparationError(
      "ACCOUNT_NOT_DEPLOYED",
      "This delivery accepts existing deployed smart accounts only.",
    );
  }
  if (
    input.plan &&
    (input.plan.sender.toLowerCase() !== input.account.sender.toLowerCase() ||
      input.plan.ownerContextId !== input.account.ownerContextId ||
      input.plan.entryPoint.toLowerCase() !==
        input.account.entryPoint.toLowerCase())
  ) {
    throw new Erc4337PreparationError(
      "ACCOUNT_ADAPTER_REQUIRED",
      "Smart-account or owner context changed; prepare the operation again.",
    );
  }
  const [nonce, accountBalance, deposit] = await Promise.all([
    input.chain.entryPointNonce({
      entryPoint: input.account.entryPoint,
      sender: input.account.sender,
      key: input.account.nonceKey,
    }),
    input.chain.balance(input.account.sender),
    input.chain.entryPointDeposit({
      entryPoint: input.account.entryPoint,
      sender: input.account.sender,
    }),
  ]);
  return { nonce, accountBalance, deposit };
}

export async function prepareErc4337Operation(
  input: PrepareErc4337Input,
): Promise<ReviewedErc4337Plan> {
  assertNoUnsupportedFields(input);
  if (!input.account) {
    throw new Erc4337PreparationError(
      "ACCOUNT_ADAPTER_REQUIRED",
      "ACCOUNT_ADAPTER_REQUIRED: configure an account-specific signer first.",
    );
  }
  validateOrdinaryErc4337Calls(input.calls);
  if (
    input.maxFeePerGas <= 0n ||
    input.maxPriorityFeePerGas <= 0n ||
    input.maxFeePerGas < input.maxPriorityFeePerGas
  ) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "ERC-4337 fee caps are invalid.",
    );
  }
  const runtime = await assertRuntimeBinding({
    chainId: input.chainId,
    account: input.account,
    chain: input.chain,
    bundler: input.bundler,
  });
  const callData = input.account.encodeCalls(input.calls);
  const estimate = await input.bundler.estimateUserOperationGas({
    entryPoint: input.account.entryPoint,
    operation: {
      sender: input.account.sender,
      nonce: runtime.nonce,
      callData,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      signature: input.account.estimationStubSignature(),
    },
  });
  const maximumGasCostWei = maximumErc4337GasCost({
    gas: estimate,
    maxFeePerGas: input.maxFeePerGas,
  });
  assertErc4337V07NumericBounds({
    gas: estimate,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
  });
  const totalNativeValueWei = input.calls.reduce(
    (total, call) => total + call.valueWei,
    0n,
  );
  const operationBudgetWei =
    input.operationBudgetWei ?? ERC4337_DEFAULT_MAX_OPERATION_COST_WEI;
  assertErc4337OperationBudget({
    maximumGasCostWei,
    totalNativeValueWei,
    operationBudgetWei,
  });
  const missingPrefundWei =
    maximumGasCostWei > runtime.deposit
      ? maximumGasCostWei - runtime.deposit
      : 0n;
  if (
    !input.account.supportsMissingAccountFunds ||
    runtime.accountBalance < missingPrefundWei + totalNativeValueWei
  ) {
    throw new Erc4337PreparationError(
      "INSUFFICIENT_PREFUND",
      "SimpleAccount deposit and native balance cannot cover prefund plus call value.",
    );
  }
  const preparedAtMs = input.nowMs ?? Date.now();
  const common = {
    attemptId: input.attemptId,
    chainId: input.chainId,
    entryPoint: input.account.entryPoint,
    sender: input.account.sender,
    ownerContextId: input.account.ownerContextId,
    nonce: runtime.nonce,
    nonceKey: input.account.nonceKey,
    callData,
    gas: estimate,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    totalNativeValueWei,
    maximumGasCostWei,
    maximumTotalCostWei: maximumGasCostWei + totalNativeValueWei,
    operationBudgetWei,
    gasPayment: { kind: "self-paid" as const },
    preparedAtMs,
  } as const;
  return {
    version: 1,
    ...common,
    entryPointVersion: ERC4337_ENTRY_POINT_VERSION,
    accountImplementation: ERC4337_SIMPLE_ACCOUNT_V07,
    calls: input.calls.map((call) => ({ ...call })),
    reviewExpiresAtMs:
      preparedAtMs + (input.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS),
    reviewFingerprint: fingerprintReviewedErc4337Plan(common),
  };
}

export interface PrepareSponsoredErc4337Input extends Omit<
  PrepareErc4337Input,
  "paymaster"
> {
  paymaster: PatioPaymasterClient;
}

function sponsorshipError(cause: unknown): never {
  if (cause instanceof PaymasterServiceError) {
    const code =
      cause.code === "VALIDITY_INVALID"
        ? "SPONSORSHIP_EXPIRED"
        : cause.code === "CONFIGURATION_MISMATCH"
          ? "PAYMASTER_CONFIGURATION_REQUIRED"
          : cause.code === "SERVICE_UNAVAILABLE" ||
              cause.code === "SPONSORSHIP_DECLINED"
            ? "SPONSORSHIP_UNAVAILABLE"
            : "PAYMASTER_RESPONSE_INVALID";
    throw new Erc4337PreparationError(code, cause.message);
  }
  throw cause;
}

/**
 * Prepares one sponsorship-only operation. Quoting is read-only and never asks
 * the account integration for its final signature.
 */
export async function prepareSponsoredErc4337Operation(
  input: PrepareSponsoredErc4337Input,
): Promise<ReviewedErc4337Plan> {
  const { paymaster: _paymaster, ...ordinaryInput } = input;
  assertNoUnsupportedFields(ordinaryInput);
  if (!input.account) {
    throw new Erc4337PreparationError(
      "ACCOUNT_ADAPTER_REQUIRED",
      "ACCOUNT_ADAPTER_REQUIRED: configure an account-specific signer first.",
    );
  }
  validateOrdinaryErc4337Calls(input.calls);
  if (
    input.maxFeePerGas <= 0n ||
    input.maxPriorityFeePerGas <= 0n ||
    input.maxFeePerGas < input.maxPriorityFeePerGas
  ) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "ERC-4337 fee caps are invalid.",
    );
  }
  const config = input.paymaster.config;
  if (
    config.chainId !== input.chainId ||
    config.entryPointVersion !== ERC4337_ENTRY_POINT_VERSION ||
    config.entryPoint.toLowerCase() !== input.account.entryPoint.toLowerCase()
  ) {
    throw new Erc4337PreparationError(
      "PAYMASTER_CONFIGURATION_REQUIRED",
      "Sponsor, chain and EntryPoint v0.7 configuration do not match.",
    );
  }
  const runtime = await assertRuntimeBinding({
    chainId: input.chainId,
    account: input.account,
    chain: input.chain,
    bundler: input.bundler,
  });
  const [paymasterCode, chainTimestamp] = await Promise.all([
    input.chain.code(config.paymaster),
    input.chain.latestTimestamp(),
  ]);
  if (!paymasterCodeMatches(paymasterCode, config)) {
    throw new Erc4337PreparationError(
      "PAYMASTER_CONFIGURATION_REQUIRED",
      "Configured paymaster code does not match the approved profile.",
    );
  }
  const callData = input.account.encodeCalls(input.calls);
  const baseOperation: Erc4337UserOperationV07 = {
    sender: input.account.sender,
    nonce: runtime.nonce,
    callData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    signature: input.account.estimationStubSignature(),
  };
  try {
    const stub = await input.paymaster.getStubData(baseOperation);
    const estimated = await input.bundler.estimateUserOperationGas({
      entryPoint: input.account.entryPoint,
      operation: {
        ...baseOperation,
        paymaster: stub.paymaster,
        paymasterData: stub.paymasterData,
        paymasterVerificationGasLimit: stub.paymasterVerificationGasLimit,
        paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit,
      },
    });
    const boundedGas = {
      callGasLimit: estimated.callGasLimit,
      verificationGasLimit: estimated.verificationGasLimit,
      preVerificationGas: estimated.preVerificationGas,
      paymasterVerificationGasLimit:
        stub.paymasterVerificationGasLimit >
        (estimated.paymasterVerificationGasLimit ?? 0n)
          ? stub.paymasterVerificationGasLimit
          : (estimated.paymasterVerificationGasLimit ?? 0n),
      paymasterPostOpGasLimit:
        stub.paymasterPostOpGasLimit > (estimated.paymasterPostOpGasLimit ?? 0n)
          ? stub.paymasterPostOpGasLimit
          : (estimated.paymasterPostOpGasLimit ?? 0n),
    };
    if (
      boundedGas.paymasterVerificationGasLimit >
        config.maximumPaymasterVerificationGas ||
      boundedGas.paymasterPostOpGasLimit > config.maximumPaymasterPostOpGas
    ) {
      throw new PaymasterServiceError(
        "LIMIT_EXCEEDED",
        "Estimated paymaster gas exceeds the configured sponsor bounds.",
      );
    }
    const final = await input.paymaster.getFinalData({
      operation: {
        ...baseOperation,
        ...boundedGas,
        paymaster: stub.paymaster,
        paymasterData: stub.paymasterData,
      },
      stub,
      chainTimestamp,
    });
    const maximumGasCostWei = maximumErc4337GasCost({
      gas: boundedGas,
      maxFeePerGas: input.maxFeePerGas,
    });
    assertErc4337V07NumericBounds({
      gas: boundedGas,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    });
    if (maximumGasCostWei > config.maximumSponsoredGasCostWei) {
      throw new PaymasterServiceError(
        "LIMIT_EXCEEDED",
        "Sponsored gas ceiling exceeds the configured sponsor policy.",
      );
    }
    const totalNativeValueWei = input.calls.reduce(
      (total, call) => total + call.valueWei,
      0n,
    );
    const operationBudgetWei =
      input.operationBudgetWei ?? ERC4337_DEFAULT_MAX_OPERATION_COST_WEI;
    if (totalNativeValueWei > operationBudgetWei) {
      throw new Erc4337PreparationError(
        "OPERATION_BUDGET_EXCEEDED",
        "User call value exceeds its independent operation budget.",
      );
    }
    if (runtime.accountBalance < totalNativeValueWei) {
      throw new Erc4337PreparationError(
        "INSUFFICIENT_PREFUND",
        "Smart account cannot cover the intended call value.",
      );
    }
    const paymasterDeposit = await input.chain.entryPointDeposit({
      entryPoint: input.account.entryPoint,
      sender: final.paymaster,
    });
    if (paymasterDeposit < maximumGasCostWei) {
      throw new Erc4337PreparationError(
        "PAYMASTER_DEPOSIT_INSUFFICIENT",
        "Paymaster EntryPoint deposit cannot cover the reviewed maximum gas charge.",
      );
    }
    const preparedAtMs = input.nowMs ?? Date.now();
    const common = {
      attemptId: input.attemptId,
      chainId: input.chainId,
      entryPoint: input.account.entryPoint,
      sender: input.account.sender,
      ownerContextId: input.account.ownerContextId,
      nonce: runtime.nonce,
      nonceKey: input.account.nonceKey,
      callData,
      gas: boundedGas,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      totalNativeValueWei,
      maximumGasCostWei,
      maximumTotalCostWei: maximumGasCostWei + totalNativeValueWei,
      operationBudgetWei,
      gasPayment: {
        kind: "sponsored" as const,
        sponsorId: config.sponsorId,
        profile: config.profile,
        paymaster: final.paymaster,
        paymasterData: final.paymasterData,
        validAfter: final.validAfter,
        validUntil: final.validUntil,
        maximumSponsoredGasCostWei: maximumGasCostWei,
        paymasterCodeHash: config.paymasterCodeHash,
      },
      preparedAtMs,
    };
    return {
      version: 1,
      ...common,
      entryPointVersion: ERC4337_ENTRY_POINT_VERSION,
      accountImplementation: ERC4337_SIMPLE_ACCOUNT_V07,
      calls: input.calls.map((call) => ({ ...call })),
      reviewExpiresAtMs:
        preparedAtMs + (input.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS),
      reviewFingerprint: fingerprintReviewedErc4337Plan(common),
    };
  } catch (cause) {
    sponsorshipError(cause);
  }
}

export interface SignedErc4337Operation {
  plan: ReviewedErc4337Plan;
  operation: Erc4337UserOperationV07;
  expectedUserOpHash: Hex;
  signedAtMs: number;
}

async function revalidatePlan(input: {
  plan: ReviewedErc4337Plan;
  account: SimpleAccountV07Integration;
  chain: Erc4337ChainReader;
  bundler: PatioBundlerClient;
  paymaster?: PatioPaymasterClient;
  nowMs: number;
}): Promise<void> {
  assertReviewedErc4337Plan(input.plan, input.nowMs);
  if (
    input.account.encodeCalls(input.plan.calls).toLowerCase() !==
    input.plan.callData.toLowerCase()
  ) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "The reviewed ERC-4337 calls no longer match their encoded account calldata.",
    );
  }
  const runtime = await assertRuntimeBinding({
    plan: input.plan,
    chainId: input.plan.chainId,
    account: input.account,
    chain: input.chain,
    bundler: input.bundler,
  });
  if (runtime.nonce !== input.plan.nonce) {
    throw new Erc4337PreparationError(
      "INVALID_INTENT",
      "The smart-account UserOperation nonce changed; review a fresh plan.",
    );
  }
  if (input.plan.gasPayment.kind === "self-paid") {
    const missingPrefundWei =
      input.plan.maximumGasCostWei > runtime.deposit
        ? input.plan.maximumGasCostWei - runtime.deposit
        : 0n;
    if (
      runtime.accountBalance <
      missingPrefundWei + input.plan.totalNativeValueWei
    ) {
      throw new Erc4337PreparationError(
        "INSUFFICIENT_PREFUND",
        "Smart-account prefund changed; review a fresh plan.",
      );
    }
    return;
  }
  const payment = input.plan.gasPayment;
  const config = input.paymaster?.config;
  if (
    !config ||
    config.chainId !== input.plan.chainId ||
    config.entryPoint.toLowerCase() !== input.plan.entryPoint.toLowerCase() ||
    config.paymaster.toLowerCase() !== payment.paymaster.toLowerCase() ||
    config.sponsorId !== payment.sponsorId ||
    config.profile !== payment.profile ||
    config.paymasterCodeHash.toLowerCase() !==
      payment.paymasterCodeHash.toLowerCase()
  ) {
    throw new Erc4337PreparationError(
      "PAYMASTER_CONFIGURATION_REQUIRED",
      "The reviewed sponsor configuration is unavailable or changed.",
    );
  }
  const [paymasterCode, chainTimestamp, paymasterDeposit] = await Promise.all([
    input.chain.code(payment.paymaster),
    input.chain.latestTimestamp(),
    input.chain.entryPointDeposit({
      entryPoint: input.plan.entryPoint,
      sender: payment.paymaster,
    }),
  ]);
  if (!paymasterCodeMatches(paymasterCode, config)) {
    throw new Erc4337PreparationError(
      "PAYMASTER_CONFIGURATION_REQUIRED",
      "Paymaster code changed after review.",
    );
  }
  try {
    input.paymaster!.assertValidity({
      validAfter: payment.validAfter,
      validUntil: payment.validUntil,
      chainTimestamp,
    });
  } catch (cause) {
    sponsorshipError(cause);
  }
  if (paymasterDeposit < payment.maximumSponsoredGasCostWei) {
    throw new Erc4337PreparationError(
      "PAYMASTER_DEPOSIT_INSUFFICIENT",
      "Paymaster deposit changed; prepare a fresh sponsorship review.",
    );
  }
  if (runtime.accountBalance < input.plan.totalNativeValueWei) {
    throw new Erc4337PreparationError(
      "INSUFFICIENT_PREFUND",
      "Smart account can no longer cover the intended call value.",
    );
  }
}

export async function signReviewedErc4337Operation(input: {
  plan: ReviewedErc4337Plan;
  account: SimpleAccountV07Integration;
  chain: Erc4337ChainReader;
  bundler: PatioBundlerClient;
  paymaster?: PatioPaymasterClient;
  explicitApproval: true;
  nowMs?: number;
}): Promise<SignedErc4337Operation> {
  const nowMs = input.nowMs ?? Date.now();
  await revalidatePlan({ ...input, nowMs });
  const unsigned = unsignedOperation(
    input.plan,
    input.account.estimationStubSignature(),
  );
  const expectedUserOpHash = userOperationHashV07({
    operation: unsigned,
    chainId: input.plan.chainId,
    entryPoint: input.plan.entryPoint,
  });
  const signature = await input.account.signUserOperationHash({
    userOpHash: expectedUserOpHash,
    chainId: input.plan.chainId,
    entryPoint: input.plan.entryPoint,
    sender: input.plan.sender,
  });
  if (
    !isHex(signature, { strict: true }) ||
    signature.length !== input.account.estimationStubSignature().length
  ) {
    throw new Erc4337PreparationError(
      "ACCOUNT_ADAPTER_REQUIRED",
      "Account signer returned a signature incompatible with the reviewed estimate.",
    );
  }
  const operation = { ...unsigned, signature };
  const finalHash = userOperationHashV07({
    operation,
    chainId: input.plan.chainId,
    entryPoint: input.plan.entryPoint,
  });
  if (finalHash.toLowerCase() !== expectedUserOpHash.toLowerCase()) {
    throw new Error("Signature unexpectedly changed the EntryPoint v0.7 hash.");
  }
  return { plan: input.plan, operation, expectedUserOpHash, signedAtMs: nowMs };
}

export type Erc4337AttemptState =
  | "reserved"
  | "rejected"
  | "submitted"
  | "uncertain"
  | "included-success"
  | "included-reverted";

export interface Erc4337AttemptRecord {
  attemptId: string;
  chainId: number;
  entryPoint: Address;
  sender: Address;
  nonce: bigint;
  expectedUserOpHash: Hex;
  gasPayment: Erc4337GasPayment;
  state: Erc4337AttemptState;
  createdAtMs: number;
  updatedAtMs: number;
  detail?: string;
}

function serializeAttempts(records: readonly Erc4337AttemptRecord[]): string {
  return JSON.stringify({
    version: 1,
    records: records.slice(-MAX_ATTEMPTS).map((record) => ({
      ...record,
      nonce: record.nonce.toString(),
      gasPayment:
        record.gasPayment.kind === "self-paid"
          ? record.gasPayment
          : {
              ...record.gasPayment,
              ...(record.gasPayment.validAfter === undefined
                ? {}
                : { validAfter: record.gasPayment.validAfter.toString() }),
              ...(record.gasPayment.validUntil === undefined
                ? {}
                : { validUntil: record.gasPayment.validUntil.toString() }),
              ...(record.gasPayment.maximumSponsoredGasCostWei === undefined
                ? {}
                : {
                    maximumSponsoredGasCostWei:
                      record.gasPayment.maximumSponsoredGasCostWei.toString(),
                  }),
            },
    })),
  });
}

export function loadErc4337Attempts(
  storage: OperationStorage,
): readonly Erc4337AttemptRecord[] {
  try {
    const raw = storage.getItem(ATTEMPT_STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as {
      version?: unknown;
      records?: unknown;
    };
    if (value.version !== 1 || !Array.isArray(value.records)) return [];
    return value.records
      .map((item): Erc4337AttemptRecord | null => {
        if (!item || typeof item !== "object" || Array.isArray(item))
          return null;
        const record = item as Record<string, unknown>;
        if (
          typeof record.attemptId !== "string" ||
          typeof record.chainId !== "number" ||
          !Number.isSafeInteger(record.chainId) ||
          typeof record.entryPoint !== "string" ||
          !isAddress(record.entryPoint) ||
          typeof record.sender !== "string" ||
          !isAddress(record.sender) ||
          typeof record.nonce !== "string" ||
          !/^\d+$/.test(record.nonce) ||
          typeof record.expectedUserOpHash !== "string" ||
          !isHex(record.expectedUserOpHash, { strict: true }) ||
          ![
            "reserved",
            "rejected",
            "submitted",
            "uncertain",
            "included-success",
            "included-reverted",
          ].includes(String(record.state)) ||
          typeof record.createdAtMs !== "number" ||
          typeof record.updatedAtMs !== "number"
        ) {
          return null;
        }
        const rawPayment = record.gasPayment;
        let gasPayment: Erc4337GasPayment = { kind: "self-paid" };
        if (
          rawPayment &&
          typeof rawPayment === "object" &&
          !Array.isArray(rawPayment) &&
          (rawPayment as Record<string, unknown>).kind === "sponsored"
        ) {
          const payment = rawPayment as Record<string, unknown>;
          if (
            typeof payment.sponsorId !== "string" ||
            typeof payment.paymaster !== "string" ||
            !isAddress(payment.paymaster) ||
            payment.profile !== "verifying-paymaster-v0.7.0" ||
            ![
              "offered",
              "verified",
              "expired",
              "unavailable",
              "unknown",
            ].includes(String(payment.status))
          ) {
            return null;
          }
          const optionalQuantity = (value: unknown): bigint | undefined =>
            typeof value === "string" && /^\d+$/u.test(value)
              ? BigInt(value)
              : undefined;
          const validAfter = optionalQuantity(payment.validAfter);
          const validUntil = optionalQuantity(payment.validUntil);
          const maximumSponsoredGasCostWei = optionalQuantity(
            payment.maximumSponsoredGasCostWei,
          );
          gasPayment = {
            kind: "sponsored",
            sponsorId: payment.sponsorId,
            paymaster: getAddress(payment.paymaster),
            profile: payment.profile,
            status: payment.status as Extract<
              Erc4337GasPayment,
              { kind: "sponsored" }
            >["status"],
            ...(validAfter === undefined ? {} : { validAfter }),
            ...(validUntil === undefined ? {} : { validUntil }),
            ...(maximumSponsoredGasCostWei === undefined
              ? {}
              : { maximumSponsoredGasCostWei }),
          };
        }
        return {
          attemptId: record.attemptId,
          chainId: record.chainId,
          entryPoint: getAddress(record.entryPoint),
          sender: getAddress(record.sender),
          nonce: BigInt(record.nonce),
          expectedUserOpHash: record.expectedUserOpHash,
          gasPayment,
          state: record.state as Erc4337AttemptState,
          createdAtMs: record.createdAtMs,
          updatedAtMs: record.updatedAtMs,
          ...(typeof record.detail === "string"
            ? { detail: record.detail.slice(0, 400) }
            : {}),
        };
      })
      .filter((record): record is Erc4337AttemptRecord => record !== null)
      .slice(-MAX_ATTEMPTS);
  } catch {
    return [];
  }
}

function saveAttempt(
  storage: OperationStorage,
  record: Erc4337AttemptRecord,
): void {
  const existing = loadErc4337Attempts(storage);
  const next = [
    ...existing.filter((candidate) => candidate.attemptId !== record.attemptId),
    record,
  ];
  storage.setItem(ATTEMPT_STORAGE_KEY, serializeAttempts(next));
  const retained = loadErc4337Attempts(storage).find(
    (candidate) => candidate.attemptId === record.attemptId,
  );
  if (!retained) {
    throw new Error("ERC-4337 attempt metadata could not be retained safely.");
  }
}

export type SubmitErc4337Result =
  | { kind: "submitted"; record: Erc4337AttemptRecord }
  | { kind: "rejected"; record: Erc4337AttemptRecord; reason: string }
  | { kind: "uncertain"; record: Erc4337AttemptRecord; reason: string };

export interface Erc4337AttemptLock {
  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
}

/** Cross-tab exclusion when the browser Web Locks API is available. */
export function browserErc4337AttemptLock(): Erc4337AttemptLock {
  return {
    runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
      if (typeof navigator === "undefined" || !navigator.locks) {
        return Promise.reject(
          new Error("A browser lock is required before ERC-4337 submission."),
        );
      }
      return navigator.locks.request(
        `patio:erc4337:${key}`,
        task,
      ) as unknown as Promise<T>;
    },
  };
}

interface SubmitErc4337Input {
  signed: SignedErc4337Operation;
  account: SimpleAccountV07Integration;
  chain: Erc4337ChainReader;
  bundler: PatioBundlerClient;
  paymaster?: PatioPaymasterClient;
  storage: OperationStorage;
  lock: Erc4337AttemptLock;
  explicitApproval: true;
  nowMs?: number;
}

export function submitSignedErc4337Operation(
  input: SubmitErc4337Input,
): Promise<SubmitErc4337Result> {
  const plan = input.signed.plan;
  const lockKey = `${plan.chainId}:${plan.entryPoint.toLowerCase()}:${plan.sender.toLowerCase()}:${plan.nonce.toString()}`;
  return input.lock.runExclusive(lockKey, () => submitLocked(input));
}

async function submitLocked(
  input: SubmitErc4337Input,
): Promise<SubmitErc4337Result> {
  const nowMs = input.nowMs ?? Date.now();
  await revalidatePlan({
    plan: input.signed.plan,
    account: input.account,
    chain: input.chain,
    bundler: input.bundler,
    ...(input.paymaster ? { paymaster: input.paymaster } : {}),
    nowMs,
  });
  if (
    userOperationHashV07({
      operation: input.signed.operation,
      chainId: input.signed.plan.chainId,
      entryPoint: input.signed.plan.entryPoint,
    }).toLowerCase() !== input.signed.expectedUserOpHash.toLowerCase()
  ) {
    throw new Error(
      "Signed UserOperation no longer matches the reviewed hash.",
    );
  }
  const collision = loadErc4337Attempts(input.storage).find(
    (record) =>
      record.chainId === input.signed.plan.chainId &&
      record.entryPoint.toLowerCase() ===
        input.signed.plan.entryPoint.toLowerCase() &&
      record.sender.toLowerCase() === input.signed.plan.sender.toLowerCase() &&
      record.nonce === input.signed.plan.nonce &&
      !["rejected", "included-success", "included-reverted"].includes(
        record.state,
      ),
  );
  if (collision) {
    throw new Error(
      "An unresolved Patio attempt already exists for this smart-account nonce.",
    );
  }
  let record: Erc4337AttemptRecord = {
    attemptId: input.signed.plan.attemptId,
    chainId: input.signed.plan.chainId,
    entryPoint: input.signed.plan.entryPoint,
    sender: input.signed.plan.sender,
    nonce: input.signed.plan.nonce,
    expectedUserOpHash: input.signed.expectedUserOpHash,
    gasPayment:
      input.signed.plan.gasPayment.kind === "self-paid"
        ? { kind: "self-paid" }
        : {
            kind: "sponsored",
            sponsorId: input.signed.plan.gasPayment.sponsorId,
            paymaster: input.signed.plan.gasPayment.paymaster,
            profile: input.signed.plan.gasPayment.profile,
            status: "offered",
            validAfter: input.signed.plan.gasPayment.validAfter,
            validUntil: input.signed.plan.gasPayment.validUntil,
            maximumSponsoredGasCostWei:
              input.signed.plan.gasPayment.maximumSponsoredGasCostWei,
          },
    state: "reserved",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  saveAttempt(input.storage, record);
  try {
    const returnedHash = await input.bundler.sendUserOperation({
      operation: input.signed.operation,
      entryPoint: input.signed.plan.entryPoint,
    });
    if (
      returnedHash.toLowerCase() !==
      input.signed.expectedUserOpHash.toLowerCase()
    ) {
      record = {
        ...record,
        state: "uncertain",
        updatedAtMs: Date.now(),
        detail:
          "Bundler returned a hash different from the reviewed EntryPoint hash.",
      };
      saveAttempt(input.storage, record);
      return {
        kind: "uncertain",
        record,
        reason: record.detail!,
      };
    }
    record = { ...record, state: "submitted", updatedAtMs: Date.now() };
    saveAttempt(input.storage, record);
    return { kind: "submitted", record };
  } catch (cause) {
    const reason =
      cause instanceof BundlerRpcError
        ? cause.message
        : "Bundler submission outcome is uncertain.";
    if (cause instanceof BundlerRpcError && !cause.uncertainSubmission) {
      record = {
        ...record,
        state: "rejected",
        updatedAtMs: Date.now(),
        detail: reason.slice(0, 400),
      };
      saveAttempt(input.storage, record);
      return { kind: "rejected", record, reason };
    }
    record = {
      ...record,
      state: "uncertain",
      updatedAtMs: Date.now(),
      detail: reason.slice(0, 400),
    };
    saveAttempt(input.storage, record);
    return { kind: "uncertain", record, reason };
  }
}

export type Erc4337Outcome =
  | { kind: "unknown"; reason: string }
  | { kind: "inconsistent"; reason: string }
  | {
      kind: "included";
      success: boolean;
      operation: ReturnType<typeof createErc4337Operation>;
    };

function matchingUserOperationEvent(input: {
  receipt: Erc4337CanonicalReceipt;
  bundlerReceipt: BundlerUserOperationReceipt;
}): {
  paymaster: Address;
  success: boolean;
  actualGasCostWei: bigint;
  actualGasUsed: bigint;
} | null {
  for (const log of input.receipt.logs) {
    if (
      log.address.toLowerCase() !==
        input.bundlerReceipt.entryPoint.toLowerCase() ||
      log.transactionHash.toLowerCase() !==
        input.receipt.transactionHash.toLowerCase() ||
      log.blockHash.toLowerCase() !== input.receipt.blockHash.toLowerCase() ||
      log.blockNumber !== input.receipt.blockNumber
    ) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: USER_OPERATION_EVENT_ABI,
        eventName: "UserOperationEvent",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      const args = decoded.args;
      if (
        args.userOpHash.toLowerCase() ===
          input.bundlerReceipt.userOpHash.toLowerCase() &&
        args.sender.toLowerCase() ===
          input.bundlerReceipt.sender.toLowerCase() &&
        args.nonce === input.bundlerReceipt.nonce
      ) {
        return {
          paymaster: args.paymaster,
          success: args.success,
          actualGasCostWei: args.actualGasCost,
          actualGasUsed: args.actualGasUsed,
        };
      }
    } catch {
      // Another EntryPoint event in the same receipt.
    }
  }
  return null;
}

export async function verifyErc4337Outcome(input: {
  attempt: Erc4337AttemptRecord;
  chain: Erc4337ChainReader;
  bundler: PatioBundlerClient;
  nowMs?: number;
}): Promise<Erc4337Outcome> {
  const bundlerReceipt = await input.bundler.getUserOperationReceipt(
    input.attempt.expectedUserOpHash,
  );
  if (!bundlerReceipt) {
    return {
      kind: "unknown",
      reason:
        "The configured bundler has no receipt; this does not prove the operation was dropped.",
    };
  }
  if (
    bundlerReceipt.userOpHash.toLowerCase() !==
      input.attempt.expectedUserOpHash.toLowerCase() ||
    bundlerReceipt.entryPoint.toLowerCase() !==
      input.attempt.entryPoint.toLowerCase() ||
    bundlerReceipt.sender.toLowerCase() !==
      input.attempt.sender.toLowerCase() ||
    bundlerReceipt.nonce !== input.attempt.nonce
  ) {
    return {
      kind: "inconsistent",
      reason: "Bundler receipt identity mismatch.",
    };
  }
  const canonical = await input.chain.receipt(bundlerReceipt.transactionHash);
  if (
    !canonical ||
    canonical.transactionHash.toLowerCase() !==
      bundlerReceipt.transactionHash.toLowerCase() ||
    canonical.blockHash.toLowerCase() !==
      bundlerReceipt.blockHash.toLowerCase() ||
    canonical.blockNumber !== bundlerReceipt.blockNumber ||
    canonical.status !== bundlerReceipt.outerStatus
  ) {
    return {
      kind: "unknown",
      reason:
        "Canonical receipt evidence is absent or changed; inclusion is not retained as final.",
    };
  }
  const event = matchingUserOperationEvent({
    receipt: canonical,
    bundlerReceipt,
  });
  if (
    !event ||
    event.paymaster.toLowerCase() !==
      (input.attempt.gasPayment.kind === "sponsored"
        ? input.attempt.gasPayment.paymaster
        : zeroAddress
      ).toLowerCase() ||
    event.success !== bundlerReceipt.success ||
    event.actualGasCostWei !== bundlerReceipt.actualGasCostWei ||
    event.actualGasUsed !== bundlerReceipt.actualGasUsed
  ) {
    return {
      kind: "inconsistent",
      reason: "Canonical EntryPoint event does not match bundler evidence.",
    };
  }
  const operation = {
    ...createErc4337Operation({
      chainId: input.attempt.chainId,
      entryPoint: input.attempt.entryPoint,
      userOpHash: input.attempt.expectedUserOpHash,
      sender: input.attempt.sender,
      nonce: input.attempt.nonce,
      state: event.success ? "included-success" : "included-reverted",
      evidence: "canonical-entrypoint-event",
      nowMs: input.nowMs ?? Date.now(),
      label: "ERC-4337 operation",
      gasPayment:
        input.attempt.gasPayment.kind === "self-paid"
          ? input.attempt.gasPayment
          : { ...input.attempt.gasPayment, status: "verified" },
    }),
    outerTransactionHash: canonical.transactionHash,
    executionResult: event.success
      ? ("success" as const)
      : ("reverted" as const),
    actualGasCostWei: event.actualGasCostWei,
    actualGasUsed: event.actualGasUsed,
    canonicalBlockHash: canonical.blockHash,
    canonicalBlockNumber: canonical.blockNumber,
  };
  return { kind: "included", success: event.success, operation };
}

export function watchErc4337Outcome(input: {
  read: () => Promise<Erc4337Outcome>;
  onUpdate: (outcome: Erc4337Outcome) => void;
  intervalsMs?: readonly number[];
}): () => void {
  const intervals = input.intervalsMs ?? [750, 1_500, 3_000, 6_000];
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;
  const poll = async () => {
    if (!active) return;
    const outcome = await input.read();
    if (!active) return;
    input.onUpdate(outcome);
    if (outcome.kind === "included" || outcome.kind === "inconsistent") {
      active = false;
      return;
    }
    timer = setTimeout(
      () => void poll(),
      intervals[Math.min(index++, intervals.length - 1)] ?? 6_000,
    );
  };
  void poll();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}
