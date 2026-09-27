import {
  createOperationStore,
  loadOperationStore,
  operationIdFor,
  registerOperation,
  saveOperationStore,
  upsertErc4337Operation,
  type Eip7702AuthorizationSummary,
  type Eip7702Operation,
  type EoaOperation,
  type Erc4337Operation,
  type OperationControl,
  type OperationStorage,
  type OperationSource,
} from "@patio/wallet-core";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

export const KNOWN_OPERATIONS_STORAGE_KEY = "patio.wallet.operations.v1";
const KNOWN_OPERATION_HISTORY_LIMIT = 100;

export interface KnownRpcTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  nonce: Hex;
  type?: Hex;
  value: Hex;
  gas?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  /** Compact EIP-7702 fields only; authorization signatures are not retained. */
  authorizationList?: readonly {
    chainId?: Hex;
    address?: Address;
    nonce?: Hex;
    authority?: Address;
  }[];
}

export interface KnownOperationTransactionReader {
  transaction(hash: Hex): Promise<KnownRpcTransaction | null>;
}

function eoaTransactionTypeFromRpc(
  type: Hex | undefined,
): EoaOperation["transactionType"] | null {
  if (!type || type === "0x0") return "legacy";
  if (type === "0x1") return "eip2930";
  if (type === "0x2") return "eip1559";
  return null;
}

function hexBigint(value: Hex | undefined): bigint | undefined {
  return value ? BigInt(value) : undefined;
}

function commonRpcTransactionIsValid(
  transaction: KnownRpcTransaction,
): boolean {
  return (
    isAddress(transaction.from) &&
    (transaction.to === null || isAddress(transaction.to)) &&
    isHex(transaction.hash, { strict: true }) &&
    isHex(transaction.nonce, { strict: true }) &&
    isHex(transaction.value, { strict: true })
  );
}

function authorizationSummary(
  authorization: NonNullable<KnownRpcTransaction["authorizationList"]>[number],
): Eip7702AuthorizationSummary | null {
  if (
    !authorization.address ||
    !authorization.nonce ||
    !authorization.chainId ||
    !isAddress(authorization.address) ||
    !isHex(authorization.nonce, { strict: true }) ||
    !isHex(authorization.chainId, { strict: true })
  ) {
    return null;
  }
  if (authorization.authority && !isAddress(authorization.authority))
    return null;
  return {
    ...(authorization.authority
      ? { authority: getAddress(authorization.authority) }
      : {}),
    delegate: getAddress(authorization.address),
    nonce: BigInt(authorization.nonce),
    chainId: BigInt(authorization.chainId),
  };
}

export function knownOperationFromRpcTransaction(input: {
  transaction: KnownRpcTransaction;
  chainId: number;
  label: string;
  nowMs: number;
  source?: OperationSource;
  control?: OperationControl;
}): EoaOperation | Eip7702Operation | null {
  const { transaction } = input;
  if (!commonRpcTransactionIsValid(transaction)) {
    return null;
  }
  const source = input.source ?? "patio";
  const control = input.control ?? "read-only";
  if (transaction.type === "0x4") {
    if (
      !isHex(transaction.maxFeePerGas, { strict: true }) ||
      !isHex(transaction.maxPriorityFeePerGas, { strict: true })
    ) {
      return null;
    }
    const rawAuthorizations = transaction.authorizationList;
    const summaries = (rawAuthorizations ?? [])
      .map(authorizationSummary)
      .filter(
        (summary): summary is Eip7702AuthorizationSummary => summary !== null,
      );
    const authorizationMetadata =
      rawAuthorizations !== undefined &&
      summaries.length === rawAuthorizations.length
        ? "complete"
        : "incomplete";
    const operation: Eip7702Operation = {
      id: "",
      executionType: "eip7702",
      chainId: input.chainId,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
      source,
      control,
      status: "submitted",
      label: input.label,
      hash: transaction.hash,
      from: getAddress(transaction.from),
      to: transaction.to === null ? null : getAddress(transaction.to),
      nonce: BigInt(transaction.nonce),
      valueWei: BigInt(transaction.value),
      ...(hexBigint(transaction.gas) === undefined
        ? {}
        : { gasLimit: hexBigint(transaction.gas)! }),
      authorizationCount: rawAuthorizations?.length ?? 0,
      authorizations: summaries,
      authorizationMetadata,
      delegateAddresses: [
        ...new Set(summaries.map((summary) => summary.delegate)),
      ],
      maxFeePerGasWei: BigInt(transaction.maxFeePerGas),
      maxPriorityFeePerGasWei: BigInt(transaction.maxPriorityFeePerGas),
    };
    return { ...operation, id: operationIdFor(operation) };
  }
  const transactionType = eoaTransactionTypeFromRpc(transaction.type);
  if (!transactionType) return null;
  const operation: EoaOperation = {
    id: "",
    executionType: "eoa",
    chainId: input.chainId,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    source,
    // Registry and funding are tied to the Patio broadcast lifecycle. They are
    // observable here, but never generic speed-up/cancel targets.
    control,
    status: "submitted",
    label: input.label,
    hash: transaction.hash,
    from: getAddress(transaction.from),
    to: transaction.to === null ? null : getAddress(transaction.to),
    nonce: BigInt(transaction.nonce),
    transactionType,
    valueWei: BigInt(transaction.value),
    ...(hexBigint(transaction.gas) === undefined
      ? {}
      : { gasLimit: hexBigint(transaction.gas)! }),
    ...(hexBigint(transaction.gasPrice) === undefined
      ? {}
      : { gasPriceWei: hexBigint(transaction.gasPrice)! }),
    ...(hexBigint(transaction.maxFeePerGas) === undefined
      ? {}
      : { maxFeePerGasWei: hexBigint(transaction.maxFeePerGas)! }),
    ...(hexBigint(transaction.maxPriorityFeePerGas) === undefined
      ? {}
      : {
          maxPriorityFeePerGasWei: hexBigint(transaction.maxPriorityFeePerGas)!,
        }),
  };
  return { ...operation, id: operationIdFor(operation) };
}

/** Patio setup only creates ordinary EOA operations; 7702 stays observational. */
export function patioEoaOperationFromRpcTransaction(input: {
  transaction: KnownRpcTransaction;
  chainId: number;
  label: string;
  nowMs: number;
}): EoaOperation | null {
  const operation = knownOperationFromRpcTransaction(input);
  return operation?.executionType === "eoa" ? operation : null;
}

/**
 * Best-effort registration after an already-submitted normal wallet operation.
 * It deliberately catches observation failures so it can never affect broadcast submission.
 */
export async function registerKnownPatioEoaOperation(input: {
  storage: OperationStorage;
  reader: KnownOperationTransactionReader;
  hash: Hex;
  chainId: number;
  label: string;
  nowMs?: number;
}): Promise<void> {
  try {
    const transaction = await input.reader.transaction(input.hash);
    if (!transaction) return;
    const operation = patioEoaOperationFromRpcTransaction({
      transaction,
      chainId: input.chainId,
      label: input.label,
      nowMs: input.nowMs ?? Date.now(),
    });
    if (!operation) return;
    const current = loadOperationStore(
      input.storage,
      KNOWN_OPERATIONS_STORAGE_KEY,
      KNOWN_OPERATION_HISTORY_LIMIT,
    );
    saveOperationStore(
      input.storage,
      KNOWN_OPERATIONS_STORAGE_KEY,
      registerOperation(current, operation),
    );
  } catch {
    // Read-only history is intentionally non-blocking for Patio setup.
  }
}

/**
 * Explicit read-only ingestion for an already-known UserOperation outcome.
 * The ERC-4337 adapter never calls this from page render and this helper has no
 * signer, bundler or transaction submission capability.
 */
export function registerKnownErc4337Operation(input: {
  storage: OperationStorage;
  operation: Erc4337Operation;
}): void {
  if (input.operation.control !== "read-only") {
    throw new Error("ERC-4337 operations must remain read-only.");
  }
  const current = loadOperationStore(
    input.storage,
    KNOWN_OPERATIONS_STORAGE_KEY,
    KNOWN_OPERATION_HISTORY_LIMIT,
  );
  saveOperationStore(
    input.storage,
    KNOWN_OPERATIONS_STORAGE_KEY,
    upsertErc4337Operation(current, input.operation),
  );
}

export function clearKnownOperationHistoryForTests(
  storage: OperationStorage,
): void {
  saveOperationStore(
    storage,
    KNOWN_OPERATIONS_STORAGE_KEY,
    createOperationStore(KNOWN_OPERATION_HISTORY_LIMIT),
  );
}
