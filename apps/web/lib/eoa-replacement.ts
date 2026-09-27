import {
  classifyAccountCode,
  assertOriginalTransactionMatches,
  createEoaReplacementPlan,
  doesPlanMeetCurrentFeeFloor,
  getEoaReplacementEligibility,
  linkEoaReplacement,
  loadOperationStore,
  operationIdFor,
  recordEoaReplacementActionAudit,
  registerOperation,
  saveOperationStore,
  walletSubmissionMatchesPlan,
  type EoaOperation,
  type EoaReplacementActionKind,
  type EoaReplacementNetwork,
  type EoaReplacementPlan,
  type EoaReplacementRpcTransaction,
  type OperationStorage,
  type WalletFeeRecommendation,
} from "@patio/wallet-core";
import type { PatioNetworkProfile } from "@patio/config";
import {
  getAddress,
  isAddress,
  isHex,
  numberToHex,
  type Address,
  type Hex,
} from "viem";

import type { BrowserEthereumRpc, RpcTransaction } from "./direct-hoodi";
import { KNOWN_OPERATIONS_STORAGE_KEY } from "./known-operations";
import { formatWalletError, type EthereumProvider } from "./wallet";

const KNOWN_OPERATION_HISTORY_LIMIT = 100;

function rpcType(
  type: Hex | undefined,
): EoaOperation["transactionType"] | null {
  if (!type || type === "0x0") return "legacy";
  if (type === "0x1") return "eip2930";
  if (type === "0x2") return "eip1559";
  return null;
}

function hexNumber(value: bigint): Hex {
  return numberToHex(value);
}

function rpcTransaction(
  transaction: RpcTransaction | null,
): EoaReplacementRpcTransaction | null {
  if (
    !transaction ||
    !isAddress(transaction.from) ||
    (transaction.to !== null && !isAddress(transaction.to)) ||
    !isHex(transaction.hash, { strict: true }) ||
    !isHex(transaction.nonce, { strict: true }) ||
    !isHex(transaction.value, { strict: true }) ||
    !rpcType(transaction.type)
  ) {
    return null;
  }
  const input = transaction.input ?? transaction.data ?? "0x";
  if (!isHex(input, { strict: true })) return null;
  return {
    hash: transaction.hash,
    from: getAddress(transaction.from),
    to: transaction.to === null ? null : getAddress(transaction.to),
    nonce: BigInt(transaction.nonce),
    transactionType: rpcType(transaction.type)!,
    valueWei: BigInt(transaction.value),
    gasLimit: transaction.gas ? BigInt(transaction.gas) : null,
    gasPriceWei: transaction.gasPrice ? BigInt(transaction.gasPrice) : null,
    maxFeePerGasWei: transaction.maxFeePerGas
      ? BigInt(transaction.maxFeePerGas)
      : null,
    maxPriorityFeePerGasWei: transaction.maxPriorityFeePerGas
      ? BigInt(transaction.maxPriorityFeePerGas)
      : null,
    input,
    ...(transaction.accessList ? { accessList: transaction.accessList } : {}),
  };
}

export function replacementNetworkFor(
  profile: PatioNetworkProfile,
): EoaReplacementNetwork {
  return {
    chainId: profile.chainId,
    canonicalSubmissionModel: profile.canonicalSubmissionModel,
    sameNonceReplacement:
      profile.transportCapabilities.sameNonceReplacement.status,
    replacementPropagation:
      profile.transportCapabilities.replacementPropagation.status,
  };
}

async function accountKind(
  rpc: BrowserEthereumRpc,
  address: Address,
): Promise<"plain-eoa" | "eip7702-delegated" | "code-bearing" | "unknown"> {
  try {
    const code = await rpc.request<Hex>("eth_getCode", [address, "latest"]);
    const classification = classifyAccountCode(code);
    if (classification.kind === "no-code") return "plain-eoa";
    if (classification.kind === "eip7702-delegation") {
      return "eip7702-delegated";
    }
    return classification.kind === "contract-code" ? "code-bearing" : "unknown";
  } catch {
    return "unknown";
  }
}

async function feeRecommendation(
  rpc: BrowserEthereumRpc,
): Promise<WalletFeeRecommendation> {
  const [gasPrice, baseFee, priority] = await Promise.all([
    rpc.request<Hex>("eth_gasPrice"),
    rpc.latestBaseFee(),
    rpc.priorityFee(),
  ]);
  return {
    gasPriceWei: BigInt(gasPrice),
    // A transparent current-network cap: two base fees plus the live tip.
    maxFeePerGasWei: baseFee * 2n + priority,
    maxPriorityFeePerGasWei: priority,
  };
}

export async function prepareEoaReplacement(input: {
  action: EoaReplacementActionKind;
  operation: EoaOperation;
  connectedAddress: Address | null;
  connectedChainId: number | null;
  networkProfile: PatioNetworkProfile;
  rpc: BrowserEthereumRpc;
}): Promise<EoaReplacementPlan> {
  const kind = await accountKind(input.rpc, input.operation.from);
  const eligibility = getEoaReplacementEligibility(input.operation, {
    connectedAddress: input.connectedAddress,
    connectedChainId: input.connectedChainId,
    network: replacementNetworkFor(input.networkProfile),
    accountKind: kind,
  })[input.action === "speed-up" ? "speedUp" : "cancel"];
  if (!eligibility.allowed) throw new Error(eligibility.reason);

  const [receipt, latestNonce, original, recommendation] = await Promise.all([
    input.rpc.receipt(input.operation.hash),
    input.rpc.latestTransactionCount(input.operation.from),
    input.rpc.transaction(input.operation.hash),
    feeRecommendation(input.rpc),
  ]);
  if (receipt) throw new Error("The original transaction is already included.");
  if (latestNonce > input.operation.nonce) {
    throw new Error("This nonce has already been consumed.");
  }
  return createEoaReplacementPlan({
    action: input.action,
    operation: input.operation,
    original: assertOriginalTransactionMatches(
      input.operation,
      rpcTransaction(original),
    ),
    recommendation,
  });
}

function sameReviewedPlan(
  left: EoaReplacementPlan,
  right: EoaReplacementPlan,
): boolean {
  return (
    left.action === right.action &&
    left.originalOperationId === right.originalOperationId &&
    left.originalHash.toLowerCase() === right.originalHash.toLowerCase() &&
    left.chainId === right.chainId &&
    left.from.toLowerCase() === right.from.toLowerCase() &&
    left.nonce === right.nonce &&
    left.transactionType === right.transactionType &&
    left.to?.toLowerCase() === right.to?.toLowerCase() &&
    left.valueWei === right.valueWei &&
    left.data.toLowerCase() === right.data.toLowerCase() &&
    left.gasLimit === right.gasLimit &&
    left.gasPriceWei === right.gasPriceWei &&
    left.maxFeePerGasWei === right.maxFeePerGasWei &&
    left.maxPriorityFeePerGasWei === right.maxPriorityFeePerGasWei
  );
}

function walletRequest(plan: EoaReplacementPlan): Record<string, unknown> {
  const request: Record<string, unknown> = {
    from: plan.from,
    nonce: hexNumber(plan.nonce),
    gas: hexNumber(plan.gasLimit),
    value: hexNumber(plan.valueWei),
    data: plan.data,
  };
  if (plan.to) request.to = plan.to;
  if (plan.gasPriceWei !== undefined)
    request.gasPrice = hexNumber(plan.gasPriceWei);
  if (plan.maxFeePerGasWei !== undefined)
    request.maxFeePerGas = hexNumber(plan.maxFeePerGasWei);
  if (plan.maxPriorityFeePerGasWei !== undefined)
    request.maxPriorityFeePerGas = hexNumber(plan.maxPriorityFeePerGasWei);
  if (plan.accessList) {
    request.accessList = plan.accessList;
  }
  return request;
}

function auditId(plan: EoaReplacementPlan, nowMs: number): string {
  return `eoa-replacement:${plan.chainId}:${plan.originalOperationId}:${plan.action}:${nowMs}`;
}

function persistAudit(
  storage: OperationStorage,
  plan: EoaReplacementPlan,
  result:
    | "planned"
    | "wallet-rejected"
    | "submitted"
    | "verified"
    | "verification-failed"
    | "aborted",
  nowMs: number,
  replacementOperationId?: string,
): void {
  const store = loadOperationStore(
    storage,
    KNOWN_OPERATIONS_STORAGE_KEY,
    KNOWN_OPERATION_HISTORY_LIMIT,
  );
  saveOperationStore(
    storage,
    KNOWN_OPERATIONS_STORAGE_KEY,
    recordEoaReplacementActionAudit(store, {
      id: auditId(plan, nowMs),
      action: plan.action,
      chainId: plan.chainId,
      originalOperationId: plan.originalOperationId,
      ...(replacementOperationId ? { replacementOperationId } : {}),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      result,
      transactionType: plan.transactionType,
      ...(plan.gasPriceWei === undefined
        ? {}
        : { gasPriceWei: plan.gasPriceWei }),
      ...(plan.maxFeePerGasWei === undefined
        ? {}
        : { maxFeePerGasWei: plan.maxFeePerGasWei }),
      ...(plan.maxPriorityFeePerGasWei === undefined
        ? {}
        : { maxPriorityFeePerGasWei: plan.maxPriorityFeePerGasWei }),
    }),
  );
}

export async function executeReviewedEoaReplacement(input: {
  plan: EoaReplacementPlan;
  operation: EoaOperation;
  connectedAddress: Address;
  connectedChainId: number;
  networkProfile: PatioNetworkProfile;
  rpc: BrowserEthereumRpc;
  wallet: EthereumProvider;
  storage: OperationStorage;
  nowMs?: () => number;
}): Promise<{ hash: Hex; operationId: string }> {
  const now = input.nowMs ?? Date.now;
  let liveChainId: number;
  let liveAccounts: unknown;
  try {
    [liveChainId, liveAccounts] = await Promise.all([
      input.wallet
        .request({ method: "eth_chainId" })
        .then((value) => Number(BigInt(String(value)))),
      input.wallet.request({ method: "eth_accounts" }),
    ]);
  } catch {
    throw new Error(
      "Wallet connection is unavailable. Reconnect and try again.",
    );
  }
  if (
    liveChainId !== input.connectedChainId ||
    !Array.isArray(liveAccounts) ||
    !liveAccounts.some(
      (account) =>
        typeof account === "string" &&
        account.toLowerCase() === input.operation.from.toLowerCase(),
    )
  ) {
    throw new Error(
      "Wallet account or network changed. Review the replacement again.",
    );
  }
  // Second read immediately before the wallet receives a signing request.
  let revalidated: EoaReplacementPlan;
  try {
    revalidated = await prepareEoaReplacement({
      action: input.plan.action,
      operation: input.operation,
      connectedAddress: input.connectedAddress,
      connectedChainId: input.connectedChainId,
      networkProfile: input.networkProfile,
      rpc: input.rpc,
    });
  } catch (cause) {
    persistAudit(input.storage, input.plan, "aborted", now());
    throw cause;
  }
  if (!sameReviewedPlan(input.plan, revalidated)) {
    persistAudit(input.storage, input.plan, "aborted", now());
    throw new Error(
      "Transaction details changed. Review a new replacement proposal.",
    );
  }
  const recommendation = await feeRecommendation(input.rpc);
  if (!doesPlanMeetCurrentFeeFloor(input.plan, recommendation)) {
    persistAudit(input.storage, input.plan, "aborted", now());
    throw new Error("Network fees changed. Review a new replacement proposal.");
  }

  let hash: Hex;
  try {
    const result = await input.wallet.request({
      method: "eth_sendTransaction",
      params: [walletRequest(input.plan)],
    });
    if (!isHex(result, { strict: true }) || result.length !== 66) {
      throw new Error("Wallet returned an invalid transaction hash.");
    }
    hash = result;
  } catch (cause) {
    const message = formatWalletError(
      cause,
      "Wallet could not submit the replacement.",
    );
    persistAudit(
      input.storage,
      input.plan,
      message === "Wallet request was rejected."
        ? "wallet-rejected"
        : "aborted",
      now(),
    );
    throw new Error(message);
  }

  persistAudit(input.storage, input.plan, "submitted", now());
  const submitted = rpcTransaction(await input.rpc.transaction(hash));
  if (!submitted || !walletSubmissionMatchesPlan(input.plan, submitted)) {
    persistAudit(input.storage, input.plan, "verification-failed", now());
    throw new Error(
      "Wallet submitted a transaction different from the reviewed replacement.",
    );
  }

  const replacement: EoaOperation = {
    id: "",
    executionType: "eoa",
    chainId: input.plan.chainId,
    createdAtMs: now(),
    updatedAtMs: now(),
    source: "external",
    control: "wallet-manageable",
    status: "submitted",
    label:
      input.plan.action === "cancel"
        ? "Cancellation candidate"
        : "Speed-up candidate",
    hash,
    from: submitted.from,
    to: submitted.to,
    nonce: submitted.nonce,
    transactionType: submitted.transactionType,
    valueWei: submitted.valueWei,
    ...(submitted.gasLimit === null ? {} : { gasLimit: submitted.gasLimit }),
    ...(submitted.gasPriceWei === null
      ? {}
      : { gasPriceWei: submitted.gasPriceWei }),
    ...(submitted.maxFeePerGasWei === null
      ? {}
      : { maxFeePerGasWei: submitted.maxFeePerGasWei }),
    ...(submitted.maxPriorityFeePerGasWei === null
      ? {}
      : { maxPriorityFeePerGasWei: submitted.maxPriorityFeePerGasWei }),
  };
  const registered = { ...replacement, id: operationIdFor(replacement) };
  const current = loadOperationStore(
    input.storage,
    KNOWN_OPERATIONS_STORAGE_KEY,
    KNOWN_OPERATION_HISTORY_LIMIT,
  );
  const linked = linkEoaReplacement(
    registerOperation(registerOperation(current, input.operation), registered),
    registered.id,
    input.operation.id,
    now(),
  );
  saveOperationStore(input.storage, KNOWN_OPERATIONS_STORAGE_KEY, linked);
  persistAudit(input.storage, input.plan, "verified", now(), registered.id);
  return { hash, operationId: registered.id };
}
