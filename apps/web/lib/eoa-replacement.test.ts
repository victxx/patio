import { describe, expect, it } from "vitest";
import {
  getOperation,
  loadOperationStore,
  type EoaOperation,
} from "@patio/wallet-core";
import type { Address, Hex } from "viem";

import { BrowserEthereumRpc } from "./direct-hoodi";
import {
  executeReviewedEoaReplacement,
  prepareEoaReplacement,
} from "./eoa-replacement";
import { KNOWN_OPERATIONS_STORAGE_KEY } from "./known-operations";
import { PATIO_NETWORK_PROFILES } from "@patio/config";

const address = (suffix: string): Address => `0x${suffix.padStart(40, "0")}`;
const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}`;

function operation(): EoaOperation {
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
  };
}

function transaction(transactionHash: Hex): Record<string, unknown> {
  return {
    hash: transactionHash,
    from: address("a"),
    to: address("b"),
    nonce: "0x7",
    type: "0x2",
    value: "0xa",
    gas: "0xc350",
    maxFeePerGas: "0x6e",
    maxPriorityFeePerGas: "0xf",
    input: "0x1234",
  };
}

class MemoryStorage {
  private value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

function wallet(send: () => Promise<unknown>) {
  return {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x88bb0";
      if (method === "eth_accounts") return [address("a")];
      if (method === "eth_sendTransaction") return send();
      throw new Error(`unexpected wallet ${method}`);
    },
  };
}

function rpc(
  input: {
    receipt?: Record<string, unknown> | null;
    latestNonce?: Hex;
    submitted?: Record<string, unknown> | null;
    afterFirstReceipt?: Record<string, unknown> | null;
  } = {},
): BrowserEthereumRpc {
  let receiptReads = 0;
  return new BrowserEthereumRpc(
    { url: "https://rpc.invalid" },
    (_url, init) => {
      const body = init?.body;
      if (typeof body !== "string")
        throw new Error("Missing RPC request body.");
      const request = JSON.parse(body) as {
        method: string;
        params: unknown[];
      };
      let result: unknown;
      if (request.method === "eth_getCode") result = "0x";
      else if (request.method === "eth_getTransactionReceipt") {
        receiptReads += 1;
        result =
          receiptReads > 1
            ? (input.afterFirstReceipt ?? input.receipt ?? null)
            : (input.receipt ?? null);
      } else if (request.method === "eth_getTransactionCount")
        result = input.latestNonce ?? "0x7";
      else if (request.method === "eth_getTransactionByHash") {
        result =
          request.params[0] === hash("2")
            ? (input.submitted ?? {
                ...transaction(hash("2")),
                maxFeePerGas: "0x7f",
                maxPriorityFeePerGas: "0x12",
              })
            : transaction(hash("1"));
      } else if (request.method === "eth_getBlockByNumber")
        result = { baseFeePerGas: "0x32" };
      else if (request.method === "eth_maxPriorityFeePerGas") result = "0xa";
      else if (request.method === "eth_gasPrice") result = "0x64";
      else throw new Error(`unexpected ${request.method}`);
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        }),
      );
    },
  );
}

describe("EOA replacement wallet executor", () => {
  it("aborts preparation when the original receipt already exists or nonce is consumed", async () => {
    await expect(
      prepareEoaReplacement({
        action: "speed-up",
        operation: operation(),
        connectedAddress: address("a"),
        connectedChainId: 560_048,
        networkProfile: PATIO_NETWORK_PROFILES.hoodi,
        rpc: rpc({ receipt: { status: "0x1" } }),
      }),
    ).rejects.toThrow(/already included/i);
    await expect(
      prepareEoaReplacement({
        action: "cancel",
        operation: operation(),
        connectedAddress: address("a"),
        connectedChainId: 560_048,
        networkProfile: PATIO_NETWORK_PROFILES.hoodi,
        rpc: rpc({ latestNonce: "0x8" }),
      }),
    ).rejects.toThrow(/consumed/i);
  });

  it("does not send after the second pre-send check observes the original included", async () => {
    const storage = new MemoryStorage();
    const client = rpc({ afterFirstReceipt: { status: "0x1" } });
    const plan = await prepareEoaReplacement({
      action: "speed-up",
      operation: operation(),
      connectedAddress: address("a"),
      connectedChainId: 560_048,
      networkProfile: PATIO_NETWORK_PROFILES.hoodi,
      rpc: client,
    });
    let sends = 0;
    await expect(
      executeReviewedEoaReplacement({
        plan,
        operation: operation(),
        connectedAddress: address("a"),
        connectedChainId: 560_048,
        networkProfile: PATIO_NETWORK_PROFILES.hoodi,
        rpc: client,
        wallet: wallet(() => {
          sends += 1;
          return Promise.resolve(hash("2"));
        }),
        storage,
      }),
    ).rejects.toThrow(/already included/i);
    expect(sends).toBe(0);
  });

  it("submits one reviewed candidate, verifies it, and does not mark the original replaced", async () => {
    const storage = new MemoryStorage();
    const client = rpc();
    const original = operation();
    const plan = await prepareEoaReplacement({
      action: "speed-up",
      operation: original,
      connectedAddress: address("a"),
      connectedChainId: 560_048,
      networkProfile: PATIO_NETWORK_PROFILES.hoodi,
      rpc: client,
    });
    let sends = 0;
    const result = await executeReviewedEoaReplacement({
      plan,
      operation: original,
      connectedAddress: address("a"),
      connectedChainId: 560_048,
      networkProfile: PATIO_NETWORK_PROFILES.hoodi,
      rpc: client,
      wallet: wallet(() => {
        sends += 1;
        return Promise.resolve(hash("2"));
      }),
      storage,
    });
    expect(sends).toBe(1);
    const stored = loadOperationStore(storage, KNOWN_OPERATIONS_STORAGE_KEY);
    const candidate = getOperation(stored, result.operationId);
    expect(candidate?.executionType).toBe("eoa");
    expect(
      candidate?.executionType === "eoa"
        ? candidate.replacementCandidateFor
        : undefined,
    ).toBe(original.id);
    expect(getOperation(stored, original.id)?.status).toBe("pending");
    expect(stored.actionAudits.at(0)?.result).toBe("verified");
  });

  it("keeps an unexpected wallet transaction out of replacement relationships", async () => {
    const storage = new MemoryStorage();
    const client = rpc({
      submitted: { ...transaction(hash("2")), input: "0xbeef" },
    });
    const plan = await prepareEoaReplacement({
      action: "speed-up",
      operation: operation(),
      connectedAddress: address("a"),
      connectedChainId: 560_048,
      networkProfile: PATIO_NETWORK_PROFILES.hoodi,
      rpc: client,
    });
    await expect(
      executeReviewedEoaReplacement({
        plan,
        operation: operation(),
        connectedAddress: address("a"),
        connectedChainId: 560_048,
        networkProfile: PATIO_NETWORK_PROFILES.hoodi,
        rpc: client,
        wallet: wallet(() => Promise.resolve(hash("2"))),
        storage,
      }),
    ).rejects.toThrow(/different from the reviewed/i);
    expect(
      loadOperationStore(storage, KNOWN_OPERATIONS_STORAGE_KEY).entries,
    ).toEqual([]);
  });

  it("handles user rejection without submitting a second candidate", async () => {
    const storage = new MemoryStorage();
    const client = rpc();
    const plan = await prepareEoaReplacement({
      action: "cancel",
      operation: operation(),
      connectedAddress: address("a"),
      connectedChainId: 560_048,
      networkProfile: PATIO_NETWORK_PROFILES.hoodi,
      rpc: client,
    });
    await expect(
      executeReviewedEoaReplacement({
        plan,
        operation: operation(),
        connectedAddress: address("a"),
        connectedChainId: 560_048,
        networkProfile: PATIO_NETWORK_PROFILES.hoodi,
        rpc: client,
        wallet: wallet(() =>
          Promise.reject(Object.assign(new Error("rejected"), { code: 4001 })),
        ),
        storage,
      }),
    ).rejects.toThrow(/rejected/i);
    expect(
      loadOperationStore(storage, KNOWN_OPERATIONS_STORAGE_KEY).entries,
    ).toEqual([]);
  });
});
