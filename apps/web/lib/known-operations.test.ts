import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import {
  ERC4337_ENTRY_POINT_V07,
  createErc4337Operation,
  loadOperationStore,
} from "@patio/wallet-core";

import {
  KNOWN_OPERATIONS_STORAGE_KEY,
  knownOperationFromRpcTransaction,
  patioEoaOperationFromRpcTransaction,
  registerKnownErc4337Operation,
  registerKnownPatioEoaOperation,
} from "./known-operations";
import { browserEvmOperationStatusReader } from "./operation-status-reader";

const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}`;
const address = (suffix: string): Address => `0x${suffix.padStart(40, "0")}`;

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("known Patio wallet operations", () => {
  it("registers submitted funding metadata after a transaction hash without a signer or sender", async () => {
    const local = storage();
    let reads = 0;
    await registerKnownPatioEoaOperation({
      storage: local,
      reader: {
        transaction: (submittedHash) => {
          reads += 1;
          expect(submittedHash).toBe(hash("10"));
          return Promise.resolve({
            hash: submittedHash,
            from: address("a"),
            to: address("b"),
            nonce: "0x7",
            type: "0x2",
            value: "0x10",
            gas: "0x5208",
            maxFeePerGas: "0x3b9aca00",
            maxPriorityFeePerGas: "0x3b9aca00",
          });
        },
      },
      hash: hash("10"),
      chainId: 560_048,
      label: "Session funding",
      nowMs: 1,
    });
    expect(reads).toBe(1);
    const saved = local.getItem(KNOWN_OPERATIONS_STORAGE_KEY);
    expect(saved).toContain("Session funding");
    expect(saved).toContain("read-only");
    expect(saved).not.toMatch(/payload|calldata|rawTransaction|privateKey/i);
  });

  it("does not let registration observation failures affect the submitted operation", async () => {
    const local = storage();
    await expect(
      registerKnownPatioEoaOperation({
        storage: local,
        reader: {
          transaction: async () => Promise.reject(new Error("offline")),
        },
        hash: hash("10"),
        chainId: 560_048,
        label: "Session funding",
      }),
    ).resolves.toBeUndefined();
    expect(local.getItem(KNOWN_OPERATIONS_STORAGE_KEY)).toBeNull();
  });

  it("maps the normal EVM receipt evidence without treating no receipt as dropped", async () => {
    const operation = patioEoaOperationFromRpcTransaction({
      transaction: {
        hash: hash("1"),
        from: address("a"),
        to: null,
        nonce: "0x0",
        type: "0x0",
        value: "0x0",
      },
      chainId: 560_048,
      label: "Registry announcement",
      nowMs: 1,
    });
    if (!operation) throw new Error("Expected valid operation.");
    const pending = await browserEvmOperationStatusReader({
      receipt: () => Promise.resolve(null),
    }).readEoaStatus(operation);
    expect(pending.status).toBe("pending");
    const failed = await browserEvmOperationStatusReader({
      receipt: () =>
        Promise.resolve({
          transactionHash: hash("1"),
          blockNumber: "0x1",
          status: "0x0",
        }),
    }).readEoaStatus(operation);
    expect(failed.status).toBe("failed");
  });

  it("decodes type-0x04 as compact EIP-7702 metadata without signatures", () => {
    const operation = knownOperationFromRpcTransaction({
      transaction: {
        hash: hash("7702"),
        from: address("a"),
        to: address("b"),
        nonce: "0x7",
        type: "0x4",
        value: "0x0",
        gas: "0x5208",
        maxFeePerGas: "0x10",
        maxPriorityFeePerGas: "0x2",
        authorizationList: [
          {
            authority: address("c"),
            address: address("d"),
            chainId: "0x0",
            nonce: "0x3",
            // An RPC may return signatures too; the compact interface excludes them.
          },
          {
            authority: address("e"),
            address: address("d"),
            chainId: "0xaa36a7",
            nonce: "0x4",
          },
        ],
      },
      chainId: 560_048,
      label: "Observed delegation",
      nowMs: 1,
      source: "external",
      control: "read-only",
    });
    expect(operation).toMatchObject({
      executionType: "eip7702",
      authorizationCount: 2,
      authorizationMetadata: "complete",
      authorizations: [
        {
          authority: getAddress(address("c")),
          delegate: address("d"),
          nonce: 3n,
          chainId: 0n,
        },
        {
          authority: getAddress(address("e")),
          delegate: address("d"),
          nonce: 4n,
          chainId: 11_155_111n,
        },
      ],
    });
    if (!operation || operation.executionType !== "eip7702") {
      throw new Error("Expected EIP-7702 metadata.");
    }
    expect(Object.keys(operation.authorizations[0] ?? {})).not.toContain("r");
    expect(Object.keys(operation.authorizations[0] ?? {})).not.toContain("s");
    expect(Object.keys(operation.authorizations[0] ?? {})).not.toContain(
      "yParity",
    );
  });

  it("keeps incomplete authorization metadata conservative", () => {
    const operation = knownOperationFromRpcTransaction({
      transaction: {
        hash: hash("7703"),
        from: address("a"),
        to: null,
        nonce: "0x1",
        type: "0x4",
        value: "0x0",
        maxFeePerGas: "0x10",
        maxPriorityFeePerGas: "0x2",
        authorizationList: [{}],
      },
      chainId: 560_048,
      label: "Incomplete",
      nowMs: 1,
    });
    expect(operation).toMatchObject({
      executionType: "eip7702",
      authorizationMetadata: "incomplete",
      authorizations: [],
    });
  });

  it("registers known ERC-4337 outcomes as read-only compact activity", () => {
    const local = storage();
    registerKnownErc4337Operation({
      storage: local,
      operation: createErc4337Operation({
        chainId: 560_048,
        entryPoint: ERC4337_ENTRY_POINT_V07,
        userOpHash: hash("4337"),
        sender: address("a"),
        nonce: 2n,
        state: "submitted",
        evidence: "configured-bundler",
        nowMs: 1,
      }),
    });
    expect(
      loadOperationStore(local, KNOWN_OPERATIONS_STORAGE_KEY).entries[0],
    ).toMatchObject({
      executionType: "erc4337",
      control: "read-only",
      operationState: "submitted",
    });
    expect(local.getItem(KNOWN_OPERATIONS_STORAGE_KEY)).not.toMatch(
      /callData|signature|logs/i,
    );
  });
});
