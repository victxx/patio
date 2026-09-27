import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  ERC4337_ENTRY_POINT_V07,
  Erc4337PreparationError,
  assertErc4337OperationBudget,
  assertErc4337V07NumericBounds,
  assertReviewedErc4337Plan,
  createErc4337Operation,
  createOperationStore,
  fingerprintReviewedErc4337Plan,
  maximumErc4337GasCost,
  operationIdFor,
  parseOperationStore,
  registerOperation,
  serializeOperationStore,
  upsertErc4337Operation,
  type Erc4337Operation,
  type ReviewedErc4337Plan,
} from "./index";

const sender = getAddress("0x1111111111111111111111111111111111111111");
const target = getAddress("0x2222222222222222222222222222222222222222");
const hash = `0x${"ab".repeat(32)}` as const;

function reviewedPlan(): ReviewedErc4337Plan {
  const base = {
    attemptId: "attempt-1",
    chainId: 560_048,
    entryPoint: ERC4337_ENTRY_POINT_V07,
    sender,
    ownerContextId: "owner-session-1",
    nonce: 7n,
    nonceKey: 0n,
    callData: "0x1234" as const,
    gas: {
      callGasLimit: 50_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 25_000n,
    },
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    operationBudgetWei: 1_000_000_000_000_000n,
    gasPayment: { kind: "self-paid" } as const,
    preparedAtMs: 100,
  };
  const maximumGasCostWei = maximumErc4337GasCost({
    gas: base.gas,
    maxFeePerGas: base.maxFeePerGas,
  });
  const common = {
    ...base,
    totalNativeValueWei: 3n,
    maximumGasCostWei,
    maximumTotalCostWei: maximumGasCostWei + 3n,
  };
  return {
    version: 1,
    ...common,
    entryPointVersion: "0.7",
    accountImplementation: "simple-account-v0.7.0",
    calls: [{ to: target, valueWei: 3n, data: "0x" }],
    reviewExpiresAtMs: 1_000,
    reviewFingerprint: fingerprintReviewedErc4337Plan(common),
  };
}

describe("ERC-4337 wallet-core model", () => {
  it("binds identity to chain, EntryPoint and userOpHash", () => {
    const operation = createErc4337Operation({
      chainId: 560_048,
      entryPoint: ERC4337_ENTRY_POINT_V07,
      userOpHash: hash,
      sender,
      nonce: 1n,
      state: "submitted",
      evidence: "configured-bundler",
      nowMs: 1,
    });
    expect(operationIdFor(operation)).toContain(
      ERC4337_ENTRY_POINT_V07.toLowerCase(),
    );
    expect(operation.control).toBe("read-only");
    expect(operation.gasPayment).toEqual({ kind: "self-paid" });
    expect(
      registerOperation(createOperationStore(), {
        ...operation,
        control: "wallet-manageable",
      }).entries,
    ).toHaveLength(0);
  });

  it("keeps ordinary-operation budget separate and bigint-safe", () => {
    const maximumGasCostWei = maximumErc4337GasCost({
      gas: {
        callGasLimit: 40_000n,
        verificationGasLimit: 80_000n,
        preVerificationGas: 20_000n,
      },
      maxFeePerGas: 3_000_000_000n,
    });
    expect(maximumGasCostWei).toBe(420_000_000_000_000n);
    expect(
      maximumErc4337GasCost({
        gas: {
          callGasLimit: 40_000n,
          verificationGasLimit: 80_000n,
          preVerificationGas: 20_000n,
          paymasterVerificationGasLimit: 30_000n,
          paymasterPostOpGasLimit: 10_000n,
        },
        maxFeePerGas: 3_000_000_000n,
      }),
    ).toBe(540_000_000_000_000n);
    expect(() =>
      assertErc4337OperationBudget({
        maximumGasCostWei,
        totalNativeValueWei: 1n,
        operationBudgetWei: maximumGasCostWei,
      }),
    ).toThrow(Erc4337PreparationError);
    expect(() =>
      assertErc4337V07NumericBounds({
        gas: {
          callGasLimit: 1n << 128n,
          verificationGasLimit: 1n,
          preVerificationGas: 1n,
        },
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      }),
    ).toThrow("uint128");
  });

  it("persists allowlisted sponsorship evidence without authorization data", () => {
    const operation = createErc4337Operation({
      chainId: 560_048,
      entryPoint: ERC4337_ENTRY_POINT_V07,
      userOpHash: hash,
      sender,
      nonce: 2n,
      state: "included-reverted",
      evidence: "canonical-entrypoint-event",
      nowMs: 10,
      gasPayment: {
        kind: "sponsored",
        sponsorId: "fixture-sponsor",
        paymaster: target,
        profile: "verifying-paymaster-v0.7.0",
        status: "verified",
        validUntil: 123n,
        maximumSponsoredGasCostWei: 456n,
      },
    });
    const serialized = serializeOperationStore(
      registerOperation(createOperationStore(), operation),
    );
    expect(serialized).not.toMatch(/paymasterData|signature|callData/i);
    expect(parseOperationStore(serialized).entries[0]).toMatchObject({
      gasPayment: {
        kind: "sponsored",
        sponsorId: "fixture-sponsor",
        paymaster: target,
        status: "verified",
        validUntil: 123n,
        maximumSponsoredGasCostWei: 456n,
      },
    });
  });

  it("rejects modified or stale reviewed plans", () => {
    const plan = reviewedPlan();
    expect(() => assertReviewedErc4337Plan(plan, 999)).not.toThrow();
    expect(() =>
      assertReviewedErc4337Plan({ ...plan, nonce: 8n }, 999),
    ).toThrow("modified");
    expect(() => assertReviewedErc4337Plan(plan, 1_001)).toThrow("expired");
  });

  it("persists compact outcome metadata without request, signature or calldata", () => {
    const operation: Erc4337Operation = {
      ...createErc4337Operation({
        chainId: 560_048,
        entryPoint: ERC4337_ENTRY_POINT_V07,
        userOpHash: hash,
        sender,
        nonce: 1n,
        state: "included-reverted",
        evidence: "canonical-entrypoint-event",
        nowMs: 1,
      }),
      actualGasCostWei: 123n,
      actualGasUsed: 456n,
      outerTransactionHash: `0x${"cd".repeat(32)}`,
    };
    const serialized = serializeOperationStore(
      registerOperation(createOperationStore(), operation),
    );
    expect(serialized).not.toMatch(/callData|signature|rawTransaction|logs/i);
    const loaded = parseOperationStore(serialized);
    expect(loaded.entries[0]).toMatchObject({
      executionType: "erc4337",
      operationState: "included-reverted",
      actualGasCostWei: 123n,
      gasPayment: { kind: "self-paid" },
    });
  });

  it("can invalidate stale canonical inclusion evidence without creating a duplicate", () => {
    const included = createErc4337Operation({
      chainId: 560_048,
      entryPoint: ERC4337_ENTRY_POINT_V07,
      userOpHash: hash,
      sender,
      nonce: 1n,
      state: "included-success",
      evidence: "canonical-entrypoint-event",
      nowMs: 1,
    });
    const unknown = createErc4337Operation({
      chainId: 560_048,
      entryPoint: ERC4337_ENTRY_POINT_V07,
      userOpHash: hash,
      sender,
      nonce: 1n,
      state: "unknown",
      evidence: "configured-bundler",
      nowMs: 2,
    });
    const store = upsertErc4337Operation(
      upsertErc4337Operation(createOperationStore(), included),
      unknown,
    );
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      operationState: "unknown",
      status: "unknown",
      createdAtMs: 1,
      updatedAtMs: 2,
    });
  });

  it("keeps older compact ERC-4337 history readable and read-only", () => {
    const legacy = JSON.stringify({
      version: 1,
      maximumEntries: 10,
      entries: [
        {
          id: "erc4337:560048:legacy",
          executionType: "erc4337",
          chainId: 560048,
          createdAtMs: 1,
          updatedAtMs: 1,
          source: "external",
          control: "wallet-manageable",
          status: "pending",
          userOpHash: hash,
          sender,
          nonce: "1",
          sponsored: true,
        },
      ],
    });
    expect(parseOperationStore(legacy).entries[0]).toMatchObject({
      executionType: "erc4337",
      entryPoint: null,
      entryPointVersion: "unknown",
      operationState: "unknown",
      evidence: "legacy-history",
      control: "read-only",
      gasPayment: { kind: "self-paid" },
    });
  });
});
