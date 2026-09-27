import type {
  Eip7702Operation,
  Eip7702AuthorizationSummary,
  EoaOperation,
  Erc4337Operation,
  KnownOperation,
  OperationControl,
  OperationSource,
  OperationStatus,
  OperationStorage,
  OperationStore,
  PatioBroadcastOperationReference,
  EoaReplacementActionAudit,
  WalletCallBatchRecord,
  WalletCallBatchState,
  WalletCallReceiptSummary,
} from "./types";
import { createOperationStore } from "./engine";

interface SerializedStore {
  version: 1;
  maximumEntries: number;
  entries: unknown[];
  actionAudits?: unknown[];
  callBatches?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = finiteInteger(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function bigint(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

function optionalBigint(value: unknown): bigint | undefined | null {
  return value === undefined ? undefined : bigint(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

const OPERATION_STATUSES = [
  "created",
  "submitted",
  "pending",
  "included",
  "replaced",
  "dropped",
  "failed",
  "unknown",
] as const satisfies readonly OperationStatus[];
const OPERATION_SOURCES = [
  "patio",
  "external",
] as const satisfies readonly OperationSource[];
const OPERATION_CONTROLS = [
  "wallet-manageable",
  "read-only",
  "patio-broadcast-protected",
] as const satisfies readonly OperationControl[];
const WALLET_CALL_BATCH_STATES = [
  "submitted",
  "uncertain",
  "pending",
  "included",
  "offchain-failed",
  "execution-reverted",
  "partial-failure",
  "unknown",
] as const satisfies readonly WalletCallBatchState[];

function base(value: Record<string, unknown>): {
  id: string;
  chainId: number;
  createdAtMs: number;
  updatedAtMs: number;
  source: OperationSource;
  status: string;
  control: OperationControl;
  label?: string;
} | null {
  const id = string(value.id);
  const chainId = nonNegativeInteger(value.chainId);
  const createdAtMs = nonNegativeInteger(value.createdAtMs);
  const updatedAtMs = nonNegativeInteger(value.updatedAtMs);
  const source = oneOf(value.source, OPERATION_SOURCES);
  const status = string(value.status);
  const control = oneOf(value.control, OPERATION_CONTROLS);
  const label = value.label === undefined ? undefined : string(value.label);
  if (
    !id ||
    chainId === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    !source ||
    !status ||
    !control ||
    (value.label !== undefined && !label)
  ) {
    return null;
  }
  return {
    id,
    chainId,
    createdAtMs,
    updatedAtMs,
    source,
    status,
    control,
    ...(label ? { label } : {}),
  };
}

function parseEip7702Authorization(
  value: unknown,
): Eip7702AuthorizationSummary | null {
  if (!isRecord(value)) return null;
  const delegate = string(value.delegate);
  const nonce = bigint(value.nonce);
  const chainId = bigint(value.chainId);
  const authority =
    value.authority === undefined ? undefined : string(value.authority);
  if (
    !delegate ||
    nonce === undefined ||
    chainId === undefined ||
    (!authority && value.authority !== undefined)
  ) {
    return null;
  }
  return {
    ...(authority ? { authority: authority as `0x${string}` } : {}),
    delegate: delegate as Eip7702AuthorizationSummary["delegate"],
    nonce,
    chainId,
  };
}

function parseOperation(value: unknown): KnownOperation | null {
  if (!isRecord(value)) return null;
  const parsedBase = base(value);
  if (!parsedBase) return null;
  const executionType = string(value.executionType);
  if (executionType === "eoa") {
    const status = oneOf(parsedBase.status, OPERATION_STATUSES);
    const nonce = bigint(value.nonce);
    const valueWei = bigint(value.valueWei);
    const hash = string(value.hash);
    const from = string(value.from);
    const to = value.to === null ? null : string(value.to);
    const transactionType = value.transactionType;
    const gasLimit = optionalBigint(value.gasLimit);
    const gasPriceWei = optionalBigint(value.gasPriceWei);
    const maxFeePerGasWei = optionalBigint(value.maxFeePerGasWei);
    const maxPriorityFeePerGasWei = optionalBigint(
      value.maxPriorityFeePerGasWei,
    );
    if (
      nonce === undefined ||
      !status ||
      valueWei === undefined ||
      !hash ||
      !from ||
      to === undefined ||
      !["legacy", "eip2930", "eip1559"].includes(String(transactionType)) ||
      gasLimit === null ||
      gasPriceWei === null ||
      maxFeePerGasWei === null ||
      maxPriorityFeePerGasWei === null
    ) {
      return null;
    }
    return {
      ...parsedBase,
      status,
      executionType,
      hash: hash as EoaOperation["hash"],
      from: from as EoaOperation["from"],
      to: to as EoaOperation["to"],
      nonce,
      valueWei,
      transactionType: transactionType as EoaOperation["transactionType"],
      ...(gasLimit === undefined ? {} : { gasLimit }),
      ...(gasPriceWei === undefined ? {} : { gasPriceWei }),
      ...(maxFeePerGasWei === undefined ? {} : { maxFeePerGasWei }),
      ...(maxPriorityFeePerGasWei === undefined
        ? {}
        : { maxPriorityFeePerGasWei }),
      ...(string(value.replaces) ? { replaces: string(value.replaces)! } : {}),
      ...(string(value.replacedBy)
        ? { replacedBy: string(value.replacedBy)! }
        : {}),
      ...(string(value.replacementCandidateFor)
        ? { replacementCandidateFor: string(value.replacementCandidateFor)! }
        : {}),
      ...(Array.isArray(value.competingCandidateIds)
        ? {
            competingCandidateIds: value.competingCandidateIds.filter(
              (candidate): candidate is string => typeof candidate === "string",
            ),
          }
        : {}),
    } satisfies EoaOperation;
  }
  if (executionType === "eip7702") {
    const status = oneOf(parsedBase.status, OPERATION_STATUSES);
    const hash = string(value.hash);
    const from = string(value.from);
    const nonce = bigint(value.nonce);
    // Prompt #5 entries did not retain outer value/to. Load them as compact,
    // explicitly incomplete legacy EIP-7702 observations instead of crashing.
    const valueWei = value.valueWei === undefined ? 0n : bigint(value.valueWei);
    const to =
      value.to === undefined || value.to === null ? null : string(value.to);
    const gasLimit = optionalBigint(value.gasLimit);
    const authorizationCount = nonNegativeInteger(value.authorizationCount);
    const maxFeePerGasWei = bigint(value.maxFeePerGasWei);
    const maxPriorityFeePerGasWei = bigint(value.maxPriorityFeePerGasWei);
    const rawAuthorizations = Array.isArray(value.authorizations)
      ? value.authorizations
      : [];
    const authorizations = rawAuthorizations
      .map(parseEip7702Authorization)
      .filter(
        (authorization): authorization is Eip7702AuthorizationSummary =>
          authorization !== null,
      );
    const authorizationMetadata = oneOf(value.authorizationMetadata, [
      "complete",
      "incomplete",
    ] as const);
    if (
      !hash ||
      !from ||
      !status ||
      nonce === undefined ||
      valueWei === undefined ||
      to === undefined ||
      gasLimit === null ||
      authorizationCount === undefined ||
      maxFeePerGasWei === undefined ||
      maxPriorityFeePerGasWei === undefined
    )
      return null;
    return {
      ...parsedBase,
      status,
      executionType,
      hash: hash as Eip7702Operation["hash"],
      from: from as Eip7702Operation["from"],
      to: to as Eip7702Operation["to"],
      nonce,
      valueWei,
      ...(gasLimit === undefined ? {} : { gasLimit }),
      authorizationCount,
      authorizations,
      authorizationMetadata:
        authorizationMetadata &&
        authorizations.length === authorizationCount &&
        rawAuthorizations.length === authorizationCount
          ? authorizationMetadata
          : "incomplete",
      maxFeePerGasWei,
      maxPriorityFeePerGasWei,
      ...(string(value.replaces) ? { replaces: string(value.replaces)! } : {}),
      ...(string(value.replacedBy)
        ? { replacedBy: string(value.replacedBy)! }
        : {}),
      ...(string(value.replacementCandidateFor)
        ? { replacementCandidateFor: string(value.replacementCandidateFor)! }
        : {}),
      ...(Array.isArray(value.competingCandidateIds)
        ? {
            competingCandidateIds: value.competingCandidateIds.filter(
              (candidate): candidate is string => typeof candidate === "string",
            ),
          }
        : {}),
    } satisfies Eip7702Operation;
  }
  if (executionType === "erc4337") {
    const status = oneOf(parsedBase.status, OPERATION_STATUSES);
    const userOpHash = string(value.userOpHash);
    const sender = string(value.sender);
    const nonce = bigint(value.nonce);
    const nonceKey = optionalBigint(value.nonceKey);
    const nonceSequence = optionalBigint(value.nonceSequence);
    if (
      !userOpHash ||
      !sender ||
      !status ||
      nonce === undefined ||
      nonceKey === null ||
      nonceSequence === null
    )
      return null;
    const entryPoint =
      value.entryPoint === null
        ? null
        : value.entryPoint === undefined
          ? null
          : string(value.entryPoint);
    if (entryPoint === undefined) return null;
    const entryPointVersion = oneOf(value.entryPointVersion, [
      "0.7",
      "unknown",
    ] as const);
    const operationState = oneOf(value.operationState, [
      "prepared",
      "awaiting-approval",
      "submitted",
      "uncertain",
      "included-success",
      "included-reverted",
      "rejected",
      "unknown",
    ] as const);
    const evidence = oneOf(value.evidence, [
      "local-plan",
      "configured-bundler",
      "canonical-entrypoint-event",
      "legacy-history",
    ] as const);
    const accountImplementation = string(value.accountImplementation);
    const outerTransactionHash =
      string(value.outerTransactionHash) ?? string(value.bundlerTxHash);
    const parsedOuterTransactionHash =
      outerTransactionHash && /^0x[0-9a-f]{64}$/i.test(outerTransactionHash)
        ? (outerTransactionHash as `0x${string}`)
        : undefined;
    const executionResult = oneOf(value.executionResult, [
      "success",
      "reverted",
      "unknown",
    ] as const);
    const actualGasCostWei = optionalBigint(value.actualGasCostWei);
    const actualGasUsed = optionalBigint(value.actualGasUsed);
    const canonicalBlockHash = string(value.canonicalBlockHash);
    const canonicalBlockNumber = optionalBigint(value.canonicalBlockNumber);
    const rawGasPayment = isRecord(value.gasPayment)
      ? value.gasPayment
      : undefined;
    if (
      actualGasCostWei === null ||
      actualGasUsed === null ||
      canonicalBlockNumber === null
    ) {
      return null;
    }
    let gasPayment: Erc4337Operation["gasPayment"] = { kind: "self-paid" };
    if (rawGasPayment?.kind === "sponsored") {
      const sponsorId = string(rawGasPayment.sponsorId);
      const paymaster = string(rawGasPayment.paymaster);
      const profile = oneOf(rawGasPayment.profile, [
        "verifying-paymaster-v0.7.0",
      ] as const);
      const paymentStatus = oneOf(rawGasPayment.status, [
        "offered",
        "verified",
        "expired",
        "unavailable",
        "unknown",
      ] as const);
      const validAfter = optionalBigint(rawGasPayment.validAfter);
      const validUntil = optionalBigint(rawGasPayment.validUntil);
      const maximumSponsoredGasCostWei = optionalBigint(
        rawGasPayment.maximumSponsoredGasCostWei,
      );
      if (
        !sponsorId ||
        !paymaster ||
        !profile ||
        !paymentStatus ||
        validAfter === null ||
        validUntil === null ||
        maximumSponsoredGasCostWei === null
      ) {
        return null;
      }
      gasPayment = {
        kind: "sponsored",
        sponsorId,
        paymaster: paymaster as Erc4337Operation["sender"],
        profile,
        status: paymentStatus,
        ...(validAfter === undefined ? {} : { validAfter }),
        ...(validUntil === undefined ? {} : { validUntil }),
        ...(maximumSponsoredGasCostWei === undefined
          ? {}
          : { maximumSponsoredGasCostWei }),
      };
    }
    return {
      ...parsedBase,
      control: "read-only",
      status,
      executionType,
      userOpHash: userOpHash as Erc4337Operation["userOpHash"],
      sender: sender as Erc4337Operation["sender"],
      nonce,
      entryPoint: entryPoint as Erc4337Operation["entryPoint"],
      entryPointVersion: entryPointVersion ?? "unknown",
      accountImplementation: accountImplementation ?? "legacy-unknown",
      operationState: operationState ?? "unknown",
      evidence: evidence ?? "legacy-history",
      ...(nonceKey === undefined ? {} : { nonceKey }),
      ...(nonceSequence === undefined ? {} : { nonceSequence }),
      ...(parsedOuterTransactionHash
        ? { outerTransactionHash: parsedOuterTransactionHash }
        : {}),
      ...(executionResult ? { executionResult } : {}),
      ...(actualGasCostWei === undefined ? {} : { actualGasCostWei }),
      ...(actualGasUsed === undefined ? {} : { actualGasUsed }),
      ...(canonicalBlockHash && /^0x[0-9a-f]{64}$/i.test(canonicalBlockHash)
        ? { canonicalBlockHash: canonicalBlockHash as `0x${string}` }
        : {}),
      ...(canonicalBlockNumber === undefined ? {} : { canonicalBlockNumber }),
      gasPayment,
    } satisfies Erc4337Operation;
  }
  if (executionType === "patio-broadcast") {
    const broadcastId = string(value.broadcastId);
    const status = value.status;
    if (
      parsedBase.source !== "patio" ||
      parsedBase.control !== "patio-broadcast-protected" ||
      !broadcastId ||
      ![
        "preparing",
        "live",
        "cleaning",
        "completed",
        "held",
        "failed",
      ].includes(String(status))
    ) {
      return null;
    }
    return {
      ...parsedBase,
      executionType,
      broadcastId,
      status: status as PatioBroadcastOperationReference["status"],
      source: "patio",
      control: "patio-broadcast-protected",
    } satisfies PatioBroadcastOperationReference;
  }
  return null;
}

function parseActionAudit(value: unknown): EoaReplacementActionAudit | null {
  if (!isRecord(value)) return null;
  const id = string(value.id);
  const action = oneOf(value.action, ["speed-up", "cancel"] as const);
  const result = oneOf(value.result, [
    "planned",
    "wallet-rejected",
    "submitted",
    "verified",
    "verification-failed",
    "aborted",
  ] as const);
  const chainId = nonNegativeInteger(value.chainId);
  const originalOperationId = string(value.originalOperationId);
  const replacementOperationId =
    value.replacementOperationId === undefined
      ? undefined
      : string(value.replacementOperationId);
  const createdAtMs = nonNegativeInteger(value.createdAtMs);
  const updatedAtMs = nonNegativeInteger(value.updatedAtMs);
  const transactionType = oneOf(value.transactionType, [
    "legacy",
    "eip2930",
    "eip1559",
  ] as const);
  const gasPriceWei = optionalBigint(value.gasPriceWei);
  const maxFeePerGasWei = optionalBigint(value.maxFeePerGasWei);
  const maxPriorityFeePerGasWei = optionalBigint(value.maxPriorityFeePerGasWei);
  if (
    !id ||
    !action ||
    !result ||
    chainId === undefined ||
    !originalOperationId ||
    (value.replacementOperationId !== undefined && !replacementOperationId) ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    !transactionType ||
    gasPriceWei === null ||
    maxFeePerGasWei === null ||
    maxPriorityFeePerGasWei === null
  ) {
    return null;
  }
  return {
    id,
    action,
    result,
    chainId,
    originalOperationId,
    ...(replacementOperationId ? { replacementOperationId } : {}),
    createdAtMs,
    updatedAtMs,
    transactionType,
    ...(gasPriceWei === undefined ? {} : { gasPriceWei }),
    ...(maxFeePerGasWei === undefined ? {} : { maxFeePerGasWei }),
    ...(maxPriorityFeePerGasWei === undefined
      ? {}
      : { maxPriorityFeePerGasWei }),
  };
}

function parseWalletCallReceipt(
  value: unknown,
): WalletCallReceiptSummary | null {
  if (!isRecord(value)) return null;
  const transactionHash = string(value.transactionHash);
  const blockHash = string(value.blockHash);
  const blockNumber = bigint(value.blockNumber);
  const gasUsed = bigint(value.gasUsed);
  const status = oneOf(value.status, ["success", "reverted"] as const);
  if (
    !transactionHash ||
    !blockHash ||
    blockNumber === undefined ||
    gasUsed === undefined ||
    !status
  ) {
    return null;
  }
  return {
    transactionHash:
      transactionHash as WalletCallReceiptSummary["transactionHash"],
    blockHash: blockHash as WalletCallReceiptSummary["blockHash"],
    blockNumber,
    gasUsed,
    status,
  };
}

function parseWalletCallBatch(value: unknown): WalletCallBatchRecord | null {
  if (!isRecord(value)) return null;
  const id = string(value.id);
  const requestId = string(value.requestId);
  const walletBatchId =
    value.walletBatchId === undefined ? undefined : string(value.walletBatchId);
  const providerSessionId = string(value.providerSessionId);
  const account = string(value.account);
  const chainId = nonNegativeInteger(value.chainId);
  const callCount = nonNegativeInteger(value.callCount);
  const totalNativeValueWei = bigint(value.totalNativeValueWei);
  const state = oneOf(value.state, WALLET_CALL_BATCH_STATES);
  const createdAtMs = nonNegativeInteger(value.createdAtMs);
  const updatedAtMs = nonNegativeInteger(value.updatedAtMs);
  const rawStatusCode =
    value.rawStatusCode === undefined
      ? undefined
      : finiteInteger(value.rawStatusCode);
  const transactionHashes = Array.isArray(value.transactionHashes)
    ? value.transactionHashes.filter(
        (hash): hash is string => typeof hash === "string",
      )
    : null;
  const receipts = Array.isArray(value.receipts)
    ? value.receipts
        .map(parseWalletCallReceipt)
        .filter(
          (receipt): receipt is WalletCallReceiptSummary => receipt !== null,
        )
    : null;
  const detail = value.detail === undefined ? undefined : string(value.detail);
  if (
    !id ||
    !requestId ||
    (value.walletBatchId !== undefined && !walletBatchId) ||
    !providerSessionId ||
    !account ||
    chainId === undefined ||
    callCount === undefined ||
    totalNativeValueWei === undefined ||
    value.atomicRequired !== true ||
    !state ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    (value.rawStatusCode !== undefined && rawStatusCode === undefined) ||
    transactionHashes === null ||
    receipts === null ||
    value.evidence !== "wallet-call-api" ||
    (value.detail !== undefined && !detail)
  ) {
    return null;
  }
  return {
    id,
    requestId,
    ...(walletBatchId ? { walletBatchId } : {}),
    providerSessionId,
    account: account as WalletCallBatchRecord["account"],
    chainId,
    callCount,
    totalNativeValueWei,
    atomicRequired: true,
    ...(typeof value.atomicReported === "boolean"
      ? { atomicReported: value.atomicReported }
      : {}),
    ...(value.atomicityInconsistent === true
      ? { atomicityInconsistent: true }
      : {}),
    state,
    ...(rawStatusCode === undefined ? {} : { rawStatusCode }),
    transactionHashes:
      transactionHashes as WalletCallBatchRecord["transactionHashes"],
    receipts,
    createdAtMs,
    updatedAtMs,
    evidence: "wallet-call-api",
    ...(detail ? { detail } : {}),
  };
}

function serializeOperation(operation: unknown): unknown {
  return JSON.parse(
    JSON.stringify(operation, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

export function serializeOperationStore(store: OperationStore): string {
  const payload: SerializedStore = {
    version: 1,
    maximumEntries: store.maximumEntries,
    entries: store.entries.map(serializeOperation),
    actionAudits: store.actionAudits.map(serializeOperation),
    callBatches: store.callBatches.map(serializeOperation),
  };
  return JSON.stringify(payload);
}

export function parseOperationStore(
  raw: string | null,
  fallbackMaximumEntries = 100,
): OperationStore {
  if (!raw) return createOperationStore(fallbackMaximumEntries);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.entries)
    ) {
      return createOperationStore(fallbackMaximumEntries);
    }
    const maximumEntries = nonNegativeInteger(parsed.maximumEntries);
    if (!maximumEntries || maximumEntries > 1_000) {
      return createOperationStore(fallbackMaximumEntries);
    }
    const store = createOperationStore(maximumEntries);
    const unique = new Map<string, KnownOperation>();
    for (const value of parsed.entries) {
      const operation = parseOperation(value);
      if (operation && !unique.has(operation.id))
        unique.set(operation.id, operation);
    }
    const audits = Array.isArray(parsed.actionAudits)
      ? parsed.actionAudits
          .map(parseActionAudit)
          .filter((audit): audit is EoaReplacementActionAudit => audit !== null)
          .filter(
            (audit, index, all) =>
              all.findIndex((candidate) => candidate.id === audit.id) === index,
          )
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
          .slice(0, store.maximumEntries)
      : [];
    const callBatches = Array.isArray(parsed.callBatches)
      ? parsed.callBatches
          .map(parseWalletCallBatch)
          .filter((batch): batch is WalletCallBatchRecord => batch !== null)
          .filter(
            (batch, index, all) =>
              all.findIndex((candidate) => candidate.id === batch.id) === index,
          )
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
          .slice(0, store.maximumEntries)
      : [];
    return {
      ...store,
      entries: [...unique.values()]
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
        .slice(0, store.maximumEntries),
      actionAudits: audits,
      callBatches,
    };
  } catch {
    return createOperationStore(fallbackMaximumEntries);
  }
}

export function loadOperationStore(
  storage: OperationStorage,
  key: string,
  fallbackMaximumEntries = 100,
): OperationStore {
  try {
    return parseOperationStore(storage.getItem(key), fallbackMaximumEntries);
  } catch {
    return createOperationStore(fallbackMaximumEntries);
  }
}

export function saveOperationStore(
  storage: OperationStorage,
  key: string,
  store: OperationStore,
): void {
  storage.setItem(key, serializeOperationStore(store));
}
