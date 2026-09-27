import { PATIO_NETWORK_PROFILES } from "@patio/config";
import { createFeePlan } from "@patio/ethereum";
import { getAddress, zeroAddress } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  assessAtomicSetupReadiness,
  assertReturnPlanFitsNetwork,
  atomicPublicSetupFeatureEnabled,
  createAtomicPublicSetupPlan,
  createPatioReturnPlan,
  loadAtomicSetupAttempts,
  mayUseExistingStreamOperator,
  reserveAtomicSetupAttempt,
  snapshotReturnRecipient,
  type AtomicSetupAttemptRecord,
} from "./atomic-public-setup";
import { dispatchReviewedWalletCallBatch } from "./wallet-call-api";
import type { EthereumProvider } from "./wallet";

const operator = getAddress("0x1111111111111111111111111111111111111111");
const session = getAddress("0x2222222222222222222222222222222222222222");
const registry = getAddress("0x3333333333333333333333333333333333333333");
const streamId = `0x${"ab".repeat(16)}` as const;

function feePlan() {
  return createFeePlan({
    baseFeePerGasWei: 1_000_000n,
    priorityFeePerGasWei: 1_000_000n,
    budgetWei: PATIO_NETWORK_PROFILES.hoodi.safety.maximumSessionExposureWei,
    chunkDurationMs: 15_000,
    requestedWindows: 1,
    replacementsPerWindow: 5,
    networkProfile: PATIO_NETWORK_PROFILES.hoodi,
  });
}

function capabilities() {
  return {
    providerSessionId: "wallet-a",
    account: operator,
    chainId: 560_048,
    observedAtMs: 100,
    evidence: "reported-by-connected-wallet" as const,
    availability: "available" as const,
    atomic: "supported" as const,
    globalAtomic: "unknown" as const,
    chainEntryPresent: true,
    globalEntryPresent: false,
  };
}

class MemoryStorage {
  private values = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function attempt(state: AtomicSetupAttemptRecord["state"] = "dispatching") {
  return {
    id: "attempt-a",
    providerSessionId: "wallet-a",
    account: operator,
    chainId: 560_048,
    sessionAddress: session,
    streamId,
    requestedFundingWei: 100n,
    state,
    createdAtMs: 1,
    updatedAtMs: 1,
  } as const;
}

describe("atomic public Patio setup", () => {
  it("is off unless the explicit experimental flag is set", () => {
    const previous = process.env.NEXT_PUBLIC_PATIO_EXPERIMENTAL_ATOMIC_SETUP;
    delete process.env.NEXT_PUBLIC_PATIO_EXPERIMENTAL_ATOMIC_SETUP;
    expect(atomicPublicSetupFeatureEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_PATIO_EXPERIMENTAL_ATOMIC_SETUP = "true";
    expect(atomicPublicSetupFeatureEnabled()).toBe(true);
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_PATIO_EXPERIMENTAL_ATOMIC_SETUP;
    } else {
      process.env.NEXT_PUBLIC_PATIO_EXPERIMENTAL_ATOMIC_SETUP = previous;
    }
  });

  it("never treats wallet success alone as permission to start media", () => {
    expect(
      assessAtomicSetupReadiness({
        walletState: "included",
        atomicReported: true,
        canonicalReceiptCount: 0,
        allCanonicalReceiptsSuccessful: false,
      }).readiness,
    ).toBe("awaiting-verification");
    expect(
      assessAtomicSetupReadiness({
        walletState: "included",
        atomicReported: true,
        canonicalReceiptCount: 1,
        allCanonicalReceiptsSuccessful: true,
        exactAnnouncementObserved: false,
        sufficientSessionBalance: true,
        sessionIsFreshPlainEoa: true,
      }).readiness,
    ).toBe("held");
    expect(
      assessAtomicSetupReadiness({
        walletState: "included",
        atomicReported: true,
        canonicalReceiptCount: 1,
        allCanonicalReceiptsSuccessful: true,
        exactAnnouncementObserved: true,
        announcementStillValid: true,
        sufficientSessionBalance: true,
        sessionIsFreshPlainEoa: true,
      }).readiness,
    ).toBe("verified");
  });

  it("preserves the classic 21k return reserve for a plain EOA", () => {
    const plan = feePlan();
    const returnPlan = createPatioReturnPlan({
      recipient: operator,
      recipientSnapshot: snapshotReturnRecipient("0x"),
      feePlan: plan,
    });
    expect(returnPlan.sweepGasLimit).toBe(21_000n);
    expect(returnPlan.cleanupReserveWei).toBe(plan.cleanupCostWei);
  });

  it("requires a bounded, explicit return reserve for code-bearing operators", () => {
    const returnPlan = createPatioReturnPlan({
      recipient: operator,
      recipientSnapshot: snapshotReturnRecipient("0x60006000"),
      feePlan: feePlan(),
      estimatedSweepGas: 50_000n,
    });
    expect(returnPlan.sweepGasLimit).toBe(60_000n);
    expect(returnPlan.cleanupReserveWei).toBeGreaterThan(
      feePlan().cleanupCostWei,
    );
    expect(() =>
      createPatioReturnPlan({
        recipient: operator,
        recipientSnapshot: snapshotReturnRecipient("0x60006000"),
        feePlan: feePlan(),
      }),
    ).toThrow("could not safely estimate");
  });

  it("keeps the existing hard session ceiling and blocks non-supported atomic routes", () => {
    const returnPlan = createPatioReturnPlan({
      recipient: operator,
      recipientSnapshot: snapshotReturnRecipient("0x"),
      feePlan: feePlan(),
    });
    expect(() =>
      assertReturnPlanFitsNetwork(returnPlan, {
        ...PATIO_NETWORK_PROFILES.hoodi,
        safety: {
          ...PATIO_NETWORK_PROFILES.hoodi.safety,
          maximumSessionExposureWei: 1n,
        },
      }),
    ).toThrow("session safety limit");
    expect(() =>
      createAtomicPublicSetupPlan({
        attemptId: "ready-request",
        providerSessionId: "wallet-a",
        account: operator,
        chainId: 560_048,
        descriptor: {
          version: 1,
          chainId: 560_048,
          operator,
          sessionAddress: session,
          streamId,
          nonceStart: "0",
        },
        announcement: {
          registry,
          streamId,
          sessionAddress: session,
          nonceStart: 0n,
          expiresAt: 1_000n,
          mediaMode: 0,
        },
        fundingAmountWei: returnPlan.requiredFundingWei,
        returnPlan,
        capabilities: { ...capabilities(), atomic: "ready" },
        reviewedAtMs: 100,
      }),
    ).toThrow("upgrade");
  });

  it("encodes exactly announcement then empty-data session funding", () => {
    const returnPlan = createPatioReturnPlan({
      recipient: operator,
      recipientSnapshot: snapshotReturnRecipient("0x"),
      feePlan: feePlan(),
    });
    const plan = createAtomicPublicSetupPlan({
      attemptId: "request-a",
      providerSessionId: "wallet-a",
      account: operator,
      chainId: 560_048,
      descriptor: {
        version: 1,
        chainId: 560_048,
        operator,
        sessionAddress: session,
        streamId,
        nonceStart: "0",
      },
      announcement: {
        registry,
        streamId,
        sessionAddress: session,
        nonceStart: 0n,
        expiresAt: 1_000n,
        mediaMode: 0,
      },
      fundingAmountWei: returnPlan.requiredFundingWei,
      returnPlan,
      capabilities: capabilities(),
      reviewedAtMs: 100,
    });
    expect(plan.walletCallPlan.calls).toHaveLength(2);
    expect(plan.walletCallPlan.calls[0]?.to).toBe(registry);
    expect(plan.walletCallPlan.calls[1]).toEqual({
      to: session,
      data: "0x",
      valueWei: returnPlan.requiredFundingWei,
    });
  });

  it("dispatches one reviewed mocked atomic setup request and never falls back", async () => {
    const returnPlan = createPatioReturnPlan({
      recipient: operator,
      recipientSnapshot: snapshotReturnRecipient("0x"),
      feePlan: feePlan(),
    });
    const plan = createAtomicPublicSetupPlan({
      attemptId: "atomic-send",
      providerSessionId: "wallet-a",
      account: operator,
      chainId: 560_048,
      descriptor: {
        version: 1,
        chainId: 560_048,
        operator,
        sessionAddress: session,
        streamId,
        nonceStart: "0",
      },
      announcement: {
        registry,
        streamId,
        sessionAddress: session,
        nonceStart: 0n,
        expiresAt: 1_000n,
        mediaMode: 0,
      },
      fundingAmountWei: returnPlan.requiredFundingWei,
      returnPlan,
      capabilities: capabilities(),
      reviewedAtMs: 100,
    });
    const provider: EthereumProvider = {
      request: vi.fn(({ method }: { method: string }) => {
        if (method === "wallet_getCapabilities") {
          return Promise.resolve({
            "0x88bb0": { atomic: { status: "supported" } },
          });
        }
        if (method === "wallet_sendCalls") {
          return Promise.resolve({ id: "atomic-send" });
        }
        return Promise.reject(new Error(method));
      }),
    };
    const result = await dispatchReviewedWalletCallBatch({
      plan: plan.walletCallPlan,
      provider,
      providerSessionId: "wallet-a",
      connectedAccount: operator,
      connectedChainId: 560_048,
      networkEnabled: true,
      explicitAuthorization: true,
      nowMs: 101,
    });
    expect(result.kind).toBe("submitted");
    expect(provider.request).toHaveBeenCalledTimes(2);
    expect(provider.request).toHaveBeenLastCalledWith({
      method: "wallet_sendCalls",
      params: [
        expect.objectContaining({
          id: "atomic-send",
          atomicRequired: true,
          from: operator,
          chainId: "0x88bb0",
        }),
      ],
    });
  });

  it("does not permit an unresolved attempt to be silently funded again", () => {
    const storage = new MemoryStorage();
    reserveAtomicSetupAttempt(storage, attempt());
    expect(() =>
      reserveAtomicSetupAttempt(storage, { ...attempt(), id: "b" }),
    ).toThrow("needs reconciliation");
    expect(loadAtomicSetupAttempts(storage)).toHaveLength(1);
  });

  it("requires a retained recovery record before dispatch", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => reserveAtomicSetupAttempt(storage, attempt())).toThrow(
      "recovery record",
    );
  });

  it("only accepts the intended operator or an empty stream slot", () => {
    expect(mayUseExistingStreamOperator(zeroAddress, operator)).toBe(true);
    expect(mayUseExistingStreamOperator(operator, operator)).toBe(true);
    expect(
      mayUseExistingStreamOperator(
        getAddress("0x4444444444444444444444444444444444444444"),
        operator,
      ),
    ).toBe(false);
  });
});
