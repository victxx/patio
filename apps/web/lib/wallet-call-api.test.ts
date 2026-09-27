import {
  createWalletCallBatchPlan,
  type WalletCallBatchPlan,
} from "@patio/wallet-core";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  discoverWalletCallCapabilities,
  dispatchReviewedWalletCallBatch,
  readWalletCallBatchStatus,
  showWalletCallBatchStatus,
  watchWalletCallBatchStatus,
} from "./wallet-call-api";
import type { EthereumProvider } from "./wallet";

const account = getAddress("0x1111111111111111111111111111111111111111");
const recipient = getAddress("0x2222222222222222222222222222222222222222");
const requestId = `0x${"a".repeat(64)}`;

function provider(
  respond: (method: string, params?: unknown[]) => unknown,
): EthereumProvider {
  return {
    request: vi.fn(
      ({ method, params }: { method: string; params?: unknown[] }) =>
        Promise.resolve(respond(method, params)),
    ),
  };
}

async function supportedSnapshot(inputProvider: EthereumProvider) {
  return discoverWalletCallCapabilities({
    provider: inputProvider,
    providerSessionId: "session-a",
    account,
    chainId: 560_048,
    nowMs: 1,
  });
}

async function reviewedPlan(
  inputProvider: EthereumProvider,
): Promise<WalletCallBatchPlan> {
  return createWalletCallBatchPlan({
    requestId,
    providerSessionId: "session-a",
    account,
    chainId: 560_048,
    calls: [{ to: recipient, data: "0x1234", valueWei: 3n }],
    capabilities: await supportedSnapshot(inputProvider),
    reviewedAtMs: 1,
  });
}

describe("Wallet Call API provider adapter", () => {
  it("queries the connected account and selected chain only", async () => {
    const mock = provider((method) => {
      if (method === "wallet_getCapabilities") {
        return { "0x88bb0": { atomic: { status: "supported" } } };
      }
      throw new Error(method);
    });
    const snapshot = await supportedSnapshot(mock);
    expect(snapshot.atomic).toBe("supported");
    expect(mock.request).toHaveBeenCalledWith({
      method: "wallet_getCapabilities",
      params: [account, ["0x88bb0"]],
    });
  });

  it("distinguishes unsupported method, unauthorized wallet and temporary failure", async () => {
    const unavailable = await discoverWalletCallCapabilities({
      provider: provider(() => {
        throw Object.assign(new Error("Unsupported method"), { code: 4200 });
      }),
      providerSessionId: "session-a",
      account,
      chainId: 560_048,
      nowMs: 1,
    });
    expect(unavailable.availability).toBe("unavailable");
    const unauthorized = await discoverWalletCallCapabilities({
      provider: provider(() => {
        throw Object.assign(new Error("Unauthorized"), { code: 4100 });
      }),
      providerSessionId: "session-a",
      account,
      chainId: 560_048,
      nowMs: 1,
    });
    expect(unauthorized.availability).toBe("unauthorized");
    const temporary = await discoverWalletCallCapabilities({
      provider: provider(() => {
        throw new Error("offline");
      }),
      providerSessionId: "session-a",
      account,
      chainId: 560_048,
      nowMs: 1,
    });
    expect(temporary.availability).toBe("temporary-failure");
  });

  it("dispatches exactly once only after a supported atomic recheck", async () => {
    const mock = provider((method) => {
      if (method === "wallet_getCapabilities") {
        return { "0x88bb0": { atomic: { status: "supported" } } };
      }
      if (method === "wallet_sendCalls") return { id: requestId };
      throw new Error(method);
    });
    const result = await dispatchReviewedWalletCallBatch({
      plan: await reviewedPlan(mock),
      provider: mock,
      providerSessionId: "session-a",
      connectedAccount: account,
      connectedChainId: 560_048,
      networkEnabled: true,
      explicitAuthorization: true,
      nowMs: 2,
    });
    expect(result.kind).toBe("submitted");
    expect(mock.request).toHaveBeenCalledTimes(3);
    expect(mock.request).toHaveBeenLastCalledWith({
      method: "wallet_sendCalls",
      params: [
        {
          version: "2.0.0",
          id: requestId,
          from: account,
          chainId: "0x88bb0",
          atomicRequired: true,
          calls: [{ to: recipient, data: "0x1234", value: "0x3" }],
        },
      ],
    });
  });

  it("blocks ready, unsupported, stale and disabled routes without sending", async () => {
    const ready = provider((method) => {
      if (method === "wallet_getCapabilities") {
        return { "0x88bb0": { atomic: { status: "ready" } } };
      }
      throw new Error(method);
    });
    const supported = provider((method) => {
      if (method === "wallet_getCapabilities") {
        return { "0x88bb0": { atomic: { status: "supported" } } };
      }
      if (method === "wallet_sendCalls") return { id: requestId };
      throw new Error(method);
    });
    const plan = await reviewedPlan(supported);
    const result = await dispatchReviewedWalletCallBatch({
      plan,
      provider: ready,
      providerSessionId: "session-a",
      connectedAccount: account,
      connectedChainId: 560_048,
      networkEnabled: true,
      explicitAuthorization: true,
      nowMs: 2,
    });
    expect(result.kind).toBe("unavailable");
    expect(ready.request).toHaveBeenCalledTimes(1);
    const stale = await dispatchReviewedWalletCallBatch({
      plan,
      provider: supported,
      providerSessionId: "session-b",
      connectedAccount: account,
      connectedChainId: 560_048,
      networkEnabled: true,
      explicitAuthorization: true,
      nowMs: 2,
    });
    expect(stale.kind).toBe("unavailable");
    expect(supported.request).toHaveBeenCalledTimes(1);
  });

  it("preserves uncertainty after a send timeout and never retries or falls back", async () => {
    const mock = provider((method) => {
      if (method === "wallet_getCapabilities") {
        return { "0x88bb0": { atomic: { status: "supported" } } };
      }
      if (method === "wallet_sendCalls") return new Promise(() => undefined);
      throw new Error(method);
    });
    const result = await dispatchReviewedWalletCallBatch({
      plan: await reviewedPlan(mock),
      provider: mock,
      providerSessionId: "session-a",
      connectedAccount: account,
      connectedChainId: 560_048,
      networkEnabled: true,
      explicitAuthorization: true,
      nowMs: 2,
      submissionTimeoutMs: 5,
    });
    expect(result.kind).toBe("uncertain");
    expect(mock.request).toHaveBeenCalledTimes(3);
    expect(mock.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_sendTransaction" }),
    );
  });

  it("tracks status with the originating provider and keeps unknown responses conservative", async () => {
    const mock = provider((method) => {
      if (method === "wallet_getCapabilities") {
        return { "0x88bb0": { atomic: { status: "supported" } } };
      }
      if (method === "wallet_sendCalls") return { id: requestId };
      if (method === "wallet_getCallsStatus") {
        return {
          version: "2.0.0",
          id: requestId,
          chainId: "0x88bb0",
          status: 100,
          atomic: true,
          receipts: [],
        };
      }
      throw new Error(method);
    });
    const sent = await dispatchReviewedWalletCallBatch({
      plan: await reviewedPlan(mock),
      provider: mock,
      providerSessionId: "session-a",
      connectedAccount: account,
      connectedChainId: 560_048,
      networkEnabled: true,
      explicitAuthorization: true,
      nowMs: 2,
    });
    if (sent.kind !== "submitted") throw new Error("Expected a mock batch.");
    const status = await readWalletCallBatchStatus({
      record: sent.record,
      provider: mock,
      providerSessionId: "session-a",
      connectedAccount: account,
      connectedChainId: 560_048,
      nowMs: 3,
    });
    expect(status.kind).toBe("updated");
    if (status.kind === "updated") expect(status.record.state).toBe("pending");
    const wrongSession = await readWalletCallBatchStatus({
      record: sent.record,
      provider: mock,
      providerSessionId: "session-b",
      connectedAccount: account,
      connectedChainId: 560_048,
    });
    expect(wrongSession.kind).toBe("unavailable");
  });

  it("only opens wallet batch status through an explicit caller and cleans up local watchers", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() =>
      Promise.resolve({ kind: "unknown" as const, reason: "waiting" }),
    );
    const update = vi.fn();
    const stop = watchWalletCallBatchStatus({
      read,
      onUpdate: update,
      intervalsMs: [5],
    });
    await Promise.resolve();
    await Promise.resolve();
    stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(read).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    const mock = provider((method) => {
      if (method === "wallet_showCallsStatus") return Promise.resolve(null);
      throw new Error(method);
    });
    await showWalletCallBatchStatus({
      record: {
        id: "record",
        requestId,
        walletBatchId: requestId,
        providerSessionId: "session-a",
        account,
        chainId: 560_048,
        callCount: 1,
        totalNativeValueWei: 0n,
        atomicRequired: true,
        state: "pending",
        transactionHashes: [],
        receipts: [],
        createdAtMs: 1,
        updatedAtMs: 1,
        evidence: "wallet-call-api",
      },
      provider: mock,
      providerSessionId: "session-a",
      connectedAccount: account,
      connectedChainId: 560_048,
    });
    expect(mock.request).toHaveBeenCalledWith({
      method: "wallet_showCallsStatus",
      params: [requestId],
    });
  });
});
