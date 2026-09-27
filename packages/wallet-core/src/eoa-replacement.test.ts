import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import {
  createEoaReplacementPlan,
  getEoaReplacementEligibility,
  walletSubmissionMatchesPlan,
  type EoaOperation,
  type EoaReplacementRpcTransaction,
} from "./index";

const address = (suffix: string): Address => `0x${suffix.padStart(40, "0")}`;
const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}`;

function operation(overrides: Partial<EoaOperation> = {}): EoaOperation {
  return {
    id: "eoa:560048:0x01",
    executionType: "eoa",
    chainId: 560_048,
    createdAtMs: 1,
    updatedAtMs: 1,
    source: "external",
    control: "wallet-manageable",
    status: "pending",
    hash: hash("1"),
    from: address("a"),
    to: address("b"),
    nonce: 7n,
    transactionType: "eip1559",
    valueWei: 10n,
    ...overrides,
  };
}

function original(
  overrides: Partial<EoaReplacementRpcTransaction> = {},
): EoaReplacementRpcTransaction {
  return {
    hash: hash("1"),
    from: address("a"),
    to: address("b"),
    nonce: 7n,
    transactionType: "eip1559",
    valueWei: 10n,
    gasLimit: 50_000n,
    gasPriceWei: null,
    maxFeePerGasWei: 100n,
    maxPriorityFeePerGasWei: 10n,
    input: "0x1234",
    ...overrides,
  };
}

const eligibleContext = {
  connectedAddress: address("a"),
  connectedChainId: 560_048,
  network: {
    chainId: 560_048,
    canonicalSubmissionModel: "public-mempool" as const,
    sameNonceReplacement: "verified" as const,
    replacementPropagation: "verified" as const,
  },
  accountKind: "plain-eoa" as const,
};

const recommendation = {
  gasPriceWei: 120n,
  maxFeePerGasWei: 130n,
  maxPriorityFeePerGasWei: 15n,
};

describe("safe generic EOA replacement planner", () => {
  it("only allows an eligible, normal pending EOA", () => {
    expect(
      getEoaReplacementEligibility(operation(), eligibleContext).speedUp
        .allowed,
    ).toBe(true);
    expect(
      getEoaReplacementEligibility(
        operation({ control: "read-only" }),
        eligibleContext,
      ).cancel.allowed,
    ).toBe(false);
    expect(
      getEoaReplacementEligibility(
        operation({ source: "patio" }),
        eligibleContext,
      ).cancel.reason,
    ).toMatch(/Patio setup/i);
    expect(
      getEoaReplacementEligibility(operation(), {
        ...eligibleContext,
        connectedAddress: address("c"),
      }).speedUp.allowed,
    ).toBe(false);
    expect(
      getEoaReplacementEligibility(operation(), {
        ...eligibleContext,
        connectedChainId: 100,
      }).speedUp.allowed,
    ).toBe(false);
    expect(
      getEoaReplacementEligibility(operation(), {
        ...eligibleContext,
        accountKind: "code-bearing",
      }).cancel.allowed,
    ).toBe(false);
    expect(
      getEoaReplacementEligibility(operation(), {
        ...eligibleContext,
        accountKind: "eip7702-delegated",
      }).cancel.reason,
    ).toMatch(/delegated EIP-7702/i);
    expect(
      getEoaReplacementEligibility(operation(), {
        ...eligibleContext,
        network: {
          ...eligibleContext.network,
          replacementPropagation: "unverified",
        },
      }).speedUp.allowed,
    ).toBe(false);
  });

  it("preserves speed-up intent and bumps both EIP-1559 fee fields with bigint math", () => {
    const plan = createEoaReplacementPlan({
      action: "speed-up",
      operation: operation(),
      original: original(),
      recommendation,
    });
    expect(plan).toMatchObject({
      from: address("a"),
      to: address("b"),
      nonce: 7n,
      valueWei: 10n,
      data: "0x1234",
      gasLimit: 50_000n,
      transactionType: "eip1559",
    });
    expect(plan.maxFeePerGasWei).toBe(130n);
    expect(plan.maxPriorityFeePerGasWei).toBe(15n);
    expect(plan.estimatedMaxCostWei).toBe(6_500_000n);
  });

  it("uses the market floor when it exceeds the separate wallet bump", () => {
    const plan = createEoaReplacementPlan({
      action: "speed-up",
      operation: operation(),
      original: original(),
      recommendation: {
        gasPriceWei: 1n,
        maxFeePerGasWei: 1_000n,
        maxPriorityFeePerGasWei: 200n,
      },
    });
    expect(plan.maxFeePerGasWei).toBe(1_000n);
    expect(plan.maxPriorityFeePerGasWei).toBe(200n);
  });

  it("preserves EIP-2930 access lists and bumps legacy-style gas price", () => {
    const accessList = [{ address: address("d"), storageKeys: [hash("e")] }];
    const plan = createEoaReplacementPlan({
      action: "speed-up",
      operation: operation({ transactionType: "eip2930" }),
      original: original({
        transactionType: "eip2930",
        gasPriceWei: 100n,
        maxFeePerGasWei: null,
        maxPriorityFeePerGasWei: null,
        accessList,
      }),
      recommendation,
    });
    expect(plan.gasPriceWei).toBe(120n);
    expect(plan.accessList).toEqual(accessList);
  });

  it("creates only the plain-EOA self-transfer cancellation shape", () => {
    const plan = createEoaReplacementPlan({
      action: "cancel",
      operation: operation(),
      original: original(),
      recommendation,
    });
    expect(plan).toMatchObject({
      from: address("a"),
      to: address("a"),
      nonce: 7n,
      valueWei: 0n,
      data: "0x",
      gasLimit: 21_000n,
    });
  });

  it("rejects a wallet submission that changes any reviewed intent", () => {
    const plan = createEoaReplacementPlan({
      action: "speed-up",
      operation: operation(),
      original: original(),
      recommendation,
    });
    const submitted = original({
      hash: hash("2"),
      maxFeePerGasWei: plan.maxFeePerGasWei!,
      maxPriorityFeePerGasWei: plan.maxPriorityFeePerGasWei!,
    });
    expect(walletSubmissionMatchesPlan(plan, submitted)).toBe(true);
    expect(
      walletSubmissionMatchesPlan(plan, { ...submitted, input: "0xbeef" }),
    ).toBe(false);
  });
});
