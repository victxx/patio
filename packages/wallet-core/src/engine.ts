import type {
  Eip7702Operation,
  EoaOperation,
  Erc4337Operation,
  KnownOperation,
  OperationStatus,
  OperationStatusEvidence,
  OperationStatusReader,
  OperationStore,
  EoaReplacementActionAudit,
  PatioBroadcastOperationReference,
  WalletCallBatchRecord,
  WalletOperation,
} from "./types";

const DEFAULT_MAXIMUM_ENTRIES = 100;

const ALLOWED_TRANSITIONS: Readonly<
  Record<OperationStatus, readonly OperationStatus[]>
> = {
  created: ["submitted", "pending", "failed", "unknown"],
  submitted: ["pending", "included", "replaced", "failed", "unknown"],
  pending: ["included", "replaced", "failed", "dropped", "unknown"],
  included: [],
  replaced: [],
  dropped: ["included", "unknown"],
  failed: [],
  unknown: ["pending", "included", "replaced", "failed", "dropped"],
};

export function operationIdFor(operation: WalletOperation): string {
  if (operation.executionType === "erc4337") {
    const entryPoint = operation.entryPoint?.toLowerCase() ?? "unknown";
    return `erc4337:${operation.chainId}:${entryPoint}:${operation.userOpHash.toLowerCase()}`;
  }
  return `${operation.executionType}:${operation.chainId}:${operation.hash.toLowerCase()}`;
}

export function patioBroadcastOperationId(
  chainId: number,
  broadcastId: string,
): string {
  return `patio-broadcast:${chainId}:${broadcastId}`;
}

export function createOperationStore(
  maximumEntries = DEFAULT_MAXIMUM_ENTRIES,
): OperationStore {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new Error("Operation history must retain at least one entry.");
  }
  return {
    version: 1,
    maximumEntries,
    entries: [],
    actionAudits: [],
    callBatches: [],
  };
}

function operationSort(left: KnownOperation, right: KnownOperation): number {
  return right.updatedAtMs - left.updatedAtMs;
}

function capEntries(
  entries: readonly KnownOperation[],
  maximumEntries: number,
): readonly KnownOperation[] {
  return [...entries].sort(operationSort).slice(0, maximumEntries);
}

export function getOperation(
  store: OperationStore,
  id: string,
): KnownOperation | undefined {
  return store.entries.find((operation) => operation.id === id);
}

export function listOperations(
  store: OperationStore,
): readonly KnownOperation[] {
  return [...store.entries].sort(operationSort);
}

export function registerOperation(
  store: OperationStore,
  operation: KnownOperation,
): OperationStore {
  if (
    (operation.executionType === "patio-broadcast" &&
      (operation.source !== "patio" ||
        operation.control !== "patio-broadcast-protected")) ||
    (operation.executionType !== "patio-broadcast" &&
      operation.control === "patio-broadcast-protected") ||
    (operation.executionType === "erc4337" && operation.control !== "read-only")
  ) {
    return store;
  }
  const existing = getOperation(store, operation.id);
  if (existing) return store;
  return {
    ...store,
    entries: capEntries([...store.entries, operation], store.maximumEntries),
  };
}

export function canTransitionOperationStatus(
  from: OperationStatus,
  to: OperationStatus,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function updateOperationStatus(
  store: OperationStore,
  id: string,
  evidence: OperationStatusEvidence,
): OperationStore {
  const current = getOperation(store, id);
  if (!current || current.executionType === "patio-broadcast") return store;
  if (!canTransitionOperationStatus(current.status, evidence.status)) {
    return store;
  }
  return {
    ...store,
    entries: store.entries.map((operation): KnownOperation => {
      if (
        operation.id !== id ||
        operation.executionType === "patio-broadcast"
      ) {
        return operation;
      }
      return {
        ...operation,
        status: evidence.status,
        updatedAtMs: evidence.observedAtMs,
      };
    }),
  };
}

export function updatePatioBroadcastReference(
  store: OperationStore,
  id: string,
  status: PatioBroadcastOperationReference["status"],
  updatedAtMs: number,
): OperationStore {
  const current = getOperation(store, id);
  if (!current || current.executionType !== "patio-broadcast") return store;
  return {
    ...store,
    entries: store.entries.map((operation): KnownOperation => {
      if (
        operation.id !== id ||
        operation.executionType !== "patio-broadcast"
      ) {
        return operation;
      }
      return { ...operation, status, updatedAtMs };
    }),
  };
}

function isEoaOperation(operation: KnownOperation): operation is EoaOperation {
  return operation.executionType === "eoa";
}

type OuterTransactionOperation = EoaOperation | Eip7702Operation;

function isOuterTransactionOperation(
  operation: KnownOperation,
): operation is OuterTransactionOperation {
  return (
    operation.executionType === "eoa" || operation.executionType === "eip7702"
  );
}

/**
 * Read-only relation between known outer transaction candidates. It deliberately
 * does not make a canonical replacement claim until receipt evidence arrives.
 */
export function linkOuterTransactionCandidate(
  store: OperationStore,
  replacementId: string,
  replacedId: string,
  updatedAtMs: number,
): OperationStore {
  const replacement = getOperation(store, replacementId);
  const replaced = getOperation(store, replacedId);
  if (
    !replacement ||
    !replaced ||
    !isOuterTransactionOperation(replacement) ||
    !isOuterTransactionOperation(replaced)
  ) {
    throw new Error(
      "Only known EOA or EIP-7702 outer transactions can compete.",
    );
  }
  if (
    replacement.chainId !== replaced.chainId ||
    replacement.from.toLowerCase() !== replaced.from.toLowerCase() ||
    replacement.nonce !== replaced.nonce
  ) {
    throw new Error(
      "Outer transaction candidates require the same chain, sender, and nonce.",
    );
  }
  if (replacement.id === replaced.id) {
    throw new Error("An operation cannot replace itself.");
  }
  return {
    ...store,
    entries: store.entries.map((operation): KnownOperation => {
      if (
        operation.id === replacement.id &&
        isOuterTransactionOperation(operation)
      ) {
        return {
          ...operation,
          replacementCandidateFor: replaced.id,
          replaces: replaced.id,
          updatedAtMs,
          status:
            operation.status === "created" ? "submitted" : operation.status,
        };
      }
      if (
        operation.id === replaced.id &&
        isOuterTransactionOperation(operation)
      ) {
        return {
          ...operation,
          competingCandidateIds: [
            ...(operation.competingCandidateIds ?? []),
            replacement.id,
          ].filter((id, index, candidates) => candidates.indexOf(id) === index),
          updatedAtMs,
        };
      }
      return operation;
    }),
  };
}

export function linkEoaReplacement(
  store: OperationStore,
  replacementId: string,
  replacedId: string,
  updatedAtMs: number,
): OperationStore {
  const replacement = getOperation(store, replacementId);
  const replaced = getOperation(store, replacedId);
  if (
    !replacement ||
    !replaced ||
    !isEoaOperation(replacement) ||
    !isEoaOperation(replaced)
  ) {
    throw new Error(
      "Only registered EOA operations can form a replacement relationship.",
    );
  }
  if (
    replacement.chainId !== replaced.chainId ||
    replacement.from.toLowerCase() !== replaced.from.toLowerCase() ||
    replacement.nonce !== replaced.nonce
  ) {
    throw new Error(
      "EOA replacements require the same chain, sender, and nonce.",
    );
  }
  return linkOuterTransactionCandidate(
    store,
    replacementId,
    replacedId,
    updatedAtMs,
  );
}

/**
 * Canonical receipt evidence, not candidate submission, decides which known
 * same-nonce operation lost. This is intentionally separate from Patio media
 * lineage and only accepts normal EOA operation identities.
 */
export function reconcileEoaNonceWinner(
  store: OperationStore,
  winnerId: string,
  winnerStatus: "included" | "failed",
  observedAtMs: number,
): OperationStore {
  const winner = getOperation(store, winnerId);
  if (!winner || !isEoaOperation(winner)) return store;
  return reconcileOuterTransactionWinner(
    store,
    winnerId,
    winnerStatus,
    observedAtMs,
  );
}

/** Canonical receipt evidence also reconciles known EIP-7702 outer candidates. */
export function reconcileOuterTransactionWinner(
  store: OperationStore,
  winnerId: string,
  winnerStatus: "included" | "failed",
  observedAtMs: number,
): OperationStore {
  const winner = getOperation(store, winnerId);
  if (!winner || !isOuterTransactionOperation(winner)) return store;
  return {
    ...store,
    entries: store.entries.map((operation): KnownOperation => {
      if (!isOuterTransactionOperation(operation)) return operation;
      const sameNonce =
        operation.chainId === winner.chainId &&
        operation.from.toLowerCase() === winner.from.toLowerCase() &&
        operation.nonce === winner.nonce;
      if (!sameNonce) return operation;
      if (operation.id === winner.id) {
        return {
          ...operation,
          status: winnerStatus,
          updatedAtMs: observedAtMs,
        };
      }
      if (operation.status === "included" || operation.status === "failed") {
        return operation;
      }
      return {
        ...operation,
        status: "replaced",
        replacedBy: winner.id,
        updatedAtMs: observedAtMs,
      };
    }),
  };
}

/** An advanced nonce without a known receipt is evidence of ambiguity, not a winner. */
export function markEoaNonceOutcomeUnknown(
  store: OperationStore,
  input: { chainId: number; from: string; nonce: bigint; observedAtMs: number },
): OperationStore {
  return markOuterTransactionNonceOutcomeUnknown(store, input);
}

/** An advanced canonical nonce never identifies a winner by itself. */
export function markOuterTransactionNonceOutcomeUnknown(
  store: OperationStore,
  input: { chainId: number; from: string; nonce: bigint; observedAtMs: number },
): OperationStore {
  return {
    ...store,
    entries: store.entries.map((operation): KnownOperation => {
      if (
        !isOuterTransactionOperation(operation) ||
        operation.chainId !== input.chainId ||
        operation.from.toLowerCase() !== input.from.toLowerCase() ||
        operation.nonce !== input.nonce ||
        operation.status === "included" ||
        operation.status === "failed" ||
        operation.status === "replaced"
      ) {
        return operation;
      }
      return {
        ...operation,
        status: "unknown",
        updatedAtMs: input.observedAtMs,
      };
    }),
  };
}

export function recordEoaReplacementActionAudit(
  store: OperationStore,
  audit: EoaReplacementActionAudit,
): OperationStore {
  const next = [
    ...store.actionAudits.filter((item) => item.id !== audit.id),
    audit,
  ]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, store.maximumEntries);
  return { ...store, actionAudits: next };
}

/**
 * Wallet Call API batches are not wallet transactions. They have no single
 * nonce and intentionally never enter the EOA replacement operation graph.
 */
export function upsertWalletCallBatch(
  store: OperationStore,
  batch: WalletCallBatchRecord,
): OperationStore {
  const next = [
    ...store.callBatches.filter((candidate) => candidate.id !== batch.id),
    batch,
  ]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, store.maximumEntries);
  return { ...store, callBatches: next };
}

export function getWalletCallBatch(
  store: OperationStore,
  id: string,
): WalletCallBatchRecord | undefined {
  return store.callBatches.find((batch) => batch.id === id);
}

/**
 * ERC-4337 observations are evidence snapshots, not EOA transaction actions.
 * A later canonical re-check may invalidate an earlier inclusion observation,
 * so this read-only record can move back to `unknown` without guessing.
 */
export function upsertErc4337Operation(
  store: OperationStore,
  operation: Erc4337Operation,
): OperationStore {
  if (operation.control !== "read-only") return store;
  const existing = getOperation(store, operation.id);
  if (existing && existing.executionType !== "erc4337") return store;
  const next = existing
    ? store.entries.map((candidate): KnownOperation =>
        candidate.id === operation.id
          ? {
              ...operation,
              createdAtMs: candidate.createdAtMs,
            }
          : candidate,
      )
    : [...store.entries, operation];
  return {
    ...store,
    entries: capEntries(next, store.maximumEntries),
  };
}

export async function refreshKnownEoaOperation(
  store: OperationStore,
  id: string,
  reader: OperationStatusReader,
): Promise<OperationStore> {
  const operation = getOperation(store, id);
  if (!operation || operation.executionType !== "eoa") return store;
  return updateOperationStatus(
    store,
    id,
    await reader.readEoaStatus(operation),
  );
}

export function createPatioBroadcastReference(input: {
  chainId: number;
  broadcastId: string;
  status: PatioBroadcastOperationReference["status"];
  createdAtMs: number;
  label?: string;
}): PatioBroadcastOperationReference {
  return {
    id: patioBroadcastOperationId(input.chainId, input.broadcastId),
    chainId: input.chainId,
    broadcastId: input.broadcastId,
    executionType: "patio-broadcast",
    source: "patio",
    control: "patio-broadcast-protected",
    status: input.status,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.createdAtMs,
    ...(input.label ? { label: input.label } : {}),
  };
}

export type { Eip7702Operation, EoaOperation, Erc4337Operation };
