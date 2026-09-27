import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import {
  canTransitionOperationStatus,
  createOperationStore,
  createPatioBroadcastReference,
  linkEoaReplacement,
  linkOuterTransactionCandidate,
  markEoaNonceOutcomeUnknown,
  reconcileEoaNonceWinner,
  reconcileOuterTransactionWinner,
  listOperations,
  operationIdFor,
  parseOperationStore,
  refreshKnownEoaOperation,
  registerOperation,
  serializeOperationStore,
  updateOperationStatus,
  type Eip7702Operation,
  type EoaOperation,
  type Erc4337Operation,
  type OperationStatusReader,
} from "./index";

const address = (suffix: string): Address => `0x${suffix.padStart(40, "0")}`;
const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}`;

function eoa(
  transactionType: EoaOperation["transactionType"] = "eip1559",
  overrides: Partial<EoaOperation> = {},
): EoaOperation {
  const operation: EoaOperation = {
    id: "eoa:560048:0x01",
    executionType: "eoa",
    chainId: 560_048,
    createdAtMs: 1,
    updatedAtMs: 1,
    source: "patio",
    control: "wallet-manageable",
    status: "submitted",
    hash: hash("1"),
    from: address("a"),
    to: address("b"),
    nonce: 7n,
    transactionType,
    valueWei: 10n,
    ...overrides,
  };
  return { ...operation, id: operationIdFor(operation) };
}

describe("generic wallet operation engine", () => {
  it("registers an EOA operation and preserves legacy, EIP-2930, and EIP-1559 metadata", () => {
    for (const transactionType of ["legacy", "eip2930", "eip1559"] as const) {
      const operation = eoa(transactionType);
      const store = registerOperation(createOperationStore(), operation);
      expect(listOperations(store)[0]).toMatchObject({
        executionType: "eoa",
        transactionType,
        hash: operation.hash,
      });
    }
  });

  it("represents EIP-7702 and ERC-4337 metadata without an execution path", () => {
    const delegation: Eip7702Operation = {
      ...eoa("eip1559", { hash: hash("7702") }),
      id: "eip7702:560048:0x7702",
      executionType: "eip7702",
      to: address("b"),
      valueWei: 0n,
      authorizationCount: 1,
      authorizations: [
        {
          delegate: address("d"),
          nonce: 1n,
          chainId: 0n,
        },
      ],
      authorizationMetadata: "complete",
      maxFeePerGasWei: 5n,
      maxPriorityFeePerGasWei: 1n,
    };
    const userOperation: Erc4337Operation = {
      id: `erc4337:560048:${address("4337")}:${hash("4337")}`,
      executionType: "erc4337",
      chainId: 560_048,
      createdAtMs: 1,
      updatedAtMs: 1,
      source: "external",
      control: "read-only",
      status: "pending",
      userOpHash: hash("4337"),
      sender: address("c"),
      nonce: 9n,
      entryPoint: address("4337"),
      entryPointVersion: "0.7",
      accountImplementation: "simple-account-v0.7.0",
      operationState: "submitted",
      evidence: "configured-bundler",
      gasPayment: { kind: "self-paid" },
    };
    const store = registerOperation(
      registerOperation(createOperationStore(), delegation),
      userOperation,
    );
    expect(
      listOperations(store).map((operation) => operation.executionType),
    ).toEqual(["eip7702", "erc4337"]);
    expect(JSON.stringify(serializeOperationStore(store))).not.toMatch(
      /authorization.*signature|userop.*signature|rawTransaction/i,
    );
  });

  it("uses chain ID in operation identity so identical hashes cannot collide", () => {
    const first = eoa("eip1559", { chainId: 1 });
    const second = eoa("eip1559", { chainId: 100 });
    const store = registerOperation(
      registerOperation(createOperationStore(), first),
      second,
    );
    expect(store.entries).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
  });

  it("derives receipt-backed included or failed states without calling dropped", async () => {
    const operation = eoa();
    const reader: OperationStatusReader = {
      readEoaStatus: () =>
        Promise.resolve({ status: "included", observedAtMs: 2 }),
    };
    const included = await refreshKnownEoaOperation(
      registerOperation(createOperationStore(), operation),
      operation.id,
      reader,
    );
    expect(listOperations(included)[0]?.status).toBe("included");

    const failed = updateOperationStatus(
      registerOperation(createOperationStore(), operation),
      operation.id,
      { status: "failed", observedAtMs: 2 },
    );
    expect(listOperations(failed)[0]?.status).toBe("failed");
  });

  it("does not treat a missing receipt as dropped and lets unknown recover to included", () => {
    const operation = eoa();
    const submitted = registerOperation(createOperationStore(), operation);
    const unknown = updateOperationStatus(submitted, operation.id, {
      status: "unknown",
      observedAtMs: 2,
    });
    expect(listOperations(unknown)[0]?.status).toBe("unknown");
    const included = updateOperationStatus(unknown, operation.id, {
      status: "included",
      observedAtMs: 3,
    });
    expect(listOperations(included)[0]?.status).toBe("included");
    expect(canTransitionOperationStatus("pending", "dropped")).toBe(true);
  });

  it("records a competing EOA candidate without declaring the original replaced", () => {
    const first = eoa();
    const second = eoa("eip1559", { hash: hash("2") });
    const store = linkEoaReplacement(
      registerOperation(
        registerOperation(createOperationStore(), first),
        second,
      ),
      second.id,
      first.id,
      2,
    );
    expect(
      listOperations(store).find((operation) => operation.id === first.id),
    ).toMatchObject({
      status: "submitted",
      competingCandidateIds: [second.id],
    });
    expect(
      listOperations(store).find((operation) => operation.id === second.id),
    ).toMatchObject({
      replaces: first.id,
      replacementCandidateFor: first.id,
    });
    const invalid = eoa("eip1559", { hash: hash("3"), nonce: 8n });
    const invalidStore = registerOperation(store, invalid);
    expect(() =>
      linkEoaReplacement(invalidStore, invalid.id, second.id, 3),
    ).toThrow("same chain, sender, and nonce");
  });

  it("marks a same-nonce loser replaced only after canonical winner evidence", () => {
    const first = eoa();
    const second = eoa("eip1559", { hash: hash("2") });
    const candidates = linkEoaReplacement(
      registerOperation(
        registerOperation(createOperationStore(), first),
        second,
      ),
      second.id,
      first.id,
      2,
    );
    const replacementWins = reconcileEoaNonceWinner(
      candidates,
      second.id,
      "included",
      3,
    );
    expect(getOperationStatus(replacementWins, first.id)).toBe("replaced");
    expect(getOperationStatus(replacementWins, second.id)).toBe("included");

    const originalWins = reconcileEoaNonceWinner(
      candidates,
      first.id,
      "included",
      3,
    );
    expect(getOperationStatus(originalWins, first.id)).toBe("included");
    expect(getOperationStatus(originalWins, second.id)).toBe("replaced");
  });

  it("records EIP-7702 outer candidates read-only without exposing the EOA action relation", () => {
    const first = eoa();
    const delegation: Eip7702Operation = {
      ...eoa("eip1559", { hash: hash("7704") }),
      id: "eip7702:560048:0x7704",
      executionType: "eip7702",
      to: address("b"),
      valueWei: 0n,
      authorizationCount: 1,
      authorizations: [{ delegate: address("d"), nonce: 1n, chainId: 0n }],
      authorizationMetadata: "complete",
      maxFeePerGasWei: 5n,
      maxPriorityFeePerGasWei: 1n,
      control: "read-only",
    };
    const linked = linkOuterTransactionCandidate(
      registerOperation(
        registerOperation(createOperationStore(), first),
        delegation,
      ),
      delegation.id,
      first.id,
      2,
    );
    expect(
      listOperations(linked).find(
        (operation) => operation.id === delegation.id,
      ),
    ).toMatchObject({ replacementCandidateFor: first.id, status: "submitted" });
    expect(() =>
      linkEoaReplacement(linked, delegation.id, first.id, 3),
    ).toThrow("Only registered EOA operations");
    const reconciled = reconcileOuterTransactionWinner(
      linked,
      delegation.id,
      "included",
      3,
    );
    expect(getOperationStatus(reconciled, delegation.id)).toBe("included");
    expect(getOperationStatus(reconciled, first.id)).toBe("replaced");
  });

  it("does not guess a canonical winner from an advanced nonce", () => {
    const first = eoa();
    const second = eoa("eip1559", { hash: hash("2") });
    const candidates = linkEoaReplacement(
      registerOperation(
        registerOperation(createOperationStore(), first),
        second,
      ),
      second.id,
      first.id,
      2,
    );
    const unresolved = markEoaNonceOutcomeUnknown(candidates, {
      chainId: first.chainId,
      from: first.from,
      nonce: first.nonce,
      observedAtMs: 3,
    });
    expect(getOperationStatus(unresolved, first.id)).toBe("unknown");
    expect(getOperationStatus(unresolved, second.id)).toBe("unknown");
  });

  it("keeps Patio broadcast references protected and separate from wallet operations", () => {
    const reference = createPatioBroadcastReference({
      chainId: 560_048,
      broadcastId: "stream-1",
      status: "live",
      createdAtMs: 1,
    });
    const store = registerOperation(createOperationStore(), reference);
    const unchanged = updateOperationStatus(store, reference.id, {
      status: "included",
      observedAtMs: 2,
    });
    expect(listOperations(unchanged)[0]).toMatchObject({
      executionType: "patio-broadcast",
      control: "patio-broadcast-protected",
      status: "live",
    });
    const invalidControl = eoa("eip1559", {
      hash: hash("protected"),
      control: "patio-broadcast-protected",
    });
    expect(
      registerOperation(createOperationStore(), invalidControl).entries,
    ).toEqual([]);
  });

  it("persists bounded metadata safely and ignores corrupt history", () => {
    let store = createOperationStore(2);
    store = registerOperation(store, eoa("eip1559", { hash: hash("1") }));
    store = registerOperation(
      store,
      eoa("eip1559", { hash: hash("2"), updatedAtMs: 2 }),
    );
    store = registerOperation(
      store,
      eoa("eip1559", { hash: hash("3"), updatedAtMs: 3 }),
    );
    const loaded = parseOperationStore(serializeOperationStore(store));
    expect(loaded.entries).toHaveLength(2);
    expect(parseOperationStore("{not-json").entries).toEqual([]);
    expect(serializeOperationStore(loaded)).not.toMatch(
      /payload|calldata|rawTransaction|privateKey/i,
    );
  });
});

function getOperationStatus(
  store: ReturnType<typeof createOperationStore>,
  id: string,
) {
  return listOperations(store).find((operation) => operation.id === id)?.status;
}
