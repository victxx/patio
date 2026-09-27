import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import {
  applyWalletCallBatchStatus,
  assertReviewedWalletCallBatchPlan,
  atomicBatchAvailability,
  createOperationStore,
  createWalletCallBatchPlan,
  parseWalletCallCapabilities,
  parseOperationStore,
  serializeOperationStore,
  submittedWalletCallBatchRecord,
  upsertWalletCallBatch,
} from "./index";

const account = getAddress("0x1111111111111111111111111111111111111111");
const recipient = getAddress("0x2222222222222222222222222222222222222222");
const batchId = `0x${"a".repeat(64)}`;
const receiptHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"c".repeat(64)}`;

function capabilities(
  response: unknown = { "0x88bb0": { atomic: { status: "supported" } } },
) {
  return parseWalletCallCapabilities({
    response,
    providerSessionId: "wallet-session-1",
    account,
    chainId: 560_048,
    observedAtMs: 1,
  });
}

function plan() {
  return createWalletCallBatchPlan({
    requestId: batchId,
    providerSessionId: "wallet-session-1",
    account,
    chainId: 560_048,
    calls: [{ to: recipient, data: "0x1234", valueWei: 7n }],
    capabilities: capabilities(),
    reviewedAtMs: 1,
  });
}

function status(statusCode: number, atomic = true) {
  return {
    version: "2.0.0",
    id: batchId,
    chainId: "0x88bb0",
    status: statusCode,
    atomic,
    receipts:
      statusCode === 100
        ? []
        : [
            {
              transactionHash: receiptHash,
              blockHash,
              blockNumber: "0x2",
              gasUsed: "0x5208",
              status: statusCode === 500 ? "0x0" : "0x1",
              logs: [{ private: "not persisted" }],
            },
          ],
  };
}

describe("Wallet Call API core model", () => {
  it("keeps global capability data distinct from the requested chain", () => {
    const snapshot = capabilities({
      "0x0": { atomic: { status: "supported" } },
    });
    expect(snapshot.globalAtomic).toBe("supported");
    expect(snapshot.atomic).toBe("unknown");
    expect(snapshot.chainEntryPresent).toBe(false);
    expect(atomicBatchAvailability(snapshot).allowed).toBe(false);
  });

  it("accepts only a per-chain supported atomic route for planning", () => {
    const supported = plan();
    expect(supported.atomicRequired).toBe(true);
    expect(supported.totalNativeValueWei).toBe(7n);
    for (const state of ["ready", "unsupported"] as const) {
      expect(() =>
        createWalletCallBatchPlan({
          requestId: batchId,
          providerSessionId: "wallet-session-1",
          account,
          chainId: 560_048,
          calls: [{ to: recipient }],
          capabilities: capabilities({
            "0x88bb0": { atomic: { status: state } },
          }),
          reviewedAtMs: 1,
        }),
      ).toThrow();
    }
  });

  it("rejects protected Patio or setup references instead of batching them", () => {
    expect(() =>
      createWalletCallBatchPlan({
        requestId: batchId,
        providerSessionId: "wallet-session-1",
        account,
        chainId: 560_048,
        calls: [{ to: recipient }],
        capabilities: capabilities(),
        reviewedAtMs: 1,
        operationReferences: [
          { source: "patio", control: "patio-broadcast-protected" },
        ],
      }),
    ).toThrow(/cannot be placed/i);
  });

  it("normalizes standard Wallet Call API status codes without receipt logs", () => {
    const record = submittedWalletCallBatchRecord({
      plan: plan(),
      walletBatchId: batchId,
      nowMs: 2,
    });
    const expected = new Map([
      [100, "pending"],
      [200, "included"],
      [400, "offchain-failed"],
      [500, "execution-reverted"],
      [600, "partial-failure"],
    ]);
    for (const [code, state] of expected) {
      const updated = applyWalletCallBatchStatus({
        record,
        response: status(code),
        observedAtMs: 3,
      });
      expect(updated.state).toBe(state);
      expect(updated.rawStatusCode).toBe(code);
      if (updated.receipts[0]) {
        expect(updated.receipts[0]).not.toHaveProperty("logs");
      }
    }
  });

  it("flags non-atomic success and partial execution instead of claiming the requested guarantee", () => {
    const record = submittedWalletCallBatchRecord({
      plan: plan(),
      walletBatchId: batchId,
      nowMs: 2,
    });
    const nonAtomic = applyWalletCallBatchStatus({
      record,
      response: status(200, false),
      observedAtMs: 3,
    });
    expect(nonAtomic.state).toBe("unknown");
    expect(nonAtomic.atomicityInconsistent).toBe(true);
    const partial = applyWalletCallBatchStatus({
      record,
      response: status(600, true),
      observedAtMs: 3,
    });
    expect(partial.state).toBe("partial-failure");
    expect(partial.atomicityInconsistent).toBe(true);
  });

  it("rejects status responses that belong to another chain or batch", () => {
    const record = submittedWalletCallBatchRecord({
      plan: plan(),
      walletBatchId: batchId,
      nowMs: 2,
    });
    expect(() =>
      applyWalletCallBatchStatus({
        record,
        response: { ...status(200), chainId: "0x1" },
        observedAtMs: 3,
      }),
    ).toThrow(/did not match/i);
  });

  it("keeps batch records bounded and outside the EOA operation list", () => {
    let store = createOperationStore(1);
    const first = submittedWalletCallBatchRecord({
      plan: plan(),
      walletBatchId: batchId,
      nowMs: 2,
    });
    store = upsertWalletCallBatch(store, first);
    store = upsertWalletCallBatch(store, {
      ...first,
      id: "other",
      updatedAtMs: 3,
    });
    expect(store.entries).toEqual([]);
    expect(store.callBatches).toHaveLength(1);
    expect(store.callBatches[0]?.id).toBe("other");
  });

  it("treats malformed capability entries as unknown and refuses planning", () => {
    const malformed = capabilities({
      "0x88bb0": { atomic: { status: "unexpected" } },
    });
    expect(malformed.availability).toBe("malformed");
    expect(malformed.atomic).toBe("unknown");
    expect(atomicBatchAvailability(malformed).allowed).toBe(false);
  });

  it("rejects a plan changed after review", () => {
    const reviewed = plan();
    const altered = {
      ...reviewed,
      calls: [{ to: recipient, data: "0x5678" as `0x${string}` }],
    };
    expect(() => assertReviewedWalletCallBatchPlan(altered, 2)).toThrow(
      /changed after review/i,
    );
  });

  it("persists only compact batch metadata and loads histories from before batches", () => {
    const stored = upsertWalletCallBatch(
      createOperationStore(2),
      submittedWalletCallBatchRecord({
        plan: plan(),
        walletBatchId: batchId,
        nowMs: 2,
      }),
    );
    const raw = serializeOperationStore(stored);
    expect(raw).not.toContain("0x1234");
    expect(raw).not.toContain("signature");
    expect(parseOperationStore(raw).callBatches).toHaveLength(1);
    const old = parseOperationStore(
      JSON.stringify({
        version: 1,
        maximumEntries: 2,
        entries: [],
        actionAudits: [],
      }),
    );
    expect(old.callBatches).toEqual([]);
  });
});
