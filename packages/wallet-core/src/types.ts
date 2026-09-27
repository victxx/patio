import type { Address, Hex } from "viem";

export type OperationSource = "patio" | "external";
export type OperationControl =
  "wallet-manageable" | "read-only" | "patio-broadcast-protected";
export type OperationStatus =
  | "created"
  | "submitted"
  | "pending"
  | "included"
  | "replaced"
  | "dropped"
  | "failed"
  | "unknown";

export interface OperationBase {
  id: string;
  chainId: number;
  createdAtMs: number;
  updatedAtMs: number;
  source: OperationSource;
  status: OperationStatus;
  control: OperationControl;
  label?: string;
}

export interface EoaOperation extends OperationBase {
  executionType: "eoa";
  hash: Hex;
  from: Address;
  to: Address | null;
  nonce: bigint;
  transactionType: "legacy" | "eip2930" | "eip1559";
  valueWei: bigint;
  gasLimit?: bigint;
  gasPriceWei?: bigint;
  maxFeePerGasWei?: bigint;
  maxPriorityFeePerGasWei?: bigint;
  /** A submitted competitor; it is not a claim that this operation lost. */
  replacementCandidateFor?: string;
  /** Known same-nonce competitors submitted after this operation. */
  competingCandidateIds?: readonly string[];
  replaces?: string;
  replacedBy?: string;
}

/** Safe EIP-7702 authorization metadata. Signature fields are deliberately absent. */
export interface Eip7702AuthorizationSummary {
  /** Present only when an RPC/library supplied or safely recovered it. */
  authority?: Address;
  delegate: Address;
  nonce: bigint;
  /** `0` is the EIP-7702 all-chain scope. */
  chainId: bigint;
}

/** Metadata only; Patio does not construct or sign type-0x04 transactions. */
export interface Eip7702Operation extends OperationBase {
  executionType: "eip7702";
  hash: Hex;
  from: Address;
  to: Address | null;
  nonce: bigint;
  valueWei: bigint;
  gasLimit?: bigint;
  authorizationCount: number;
  /** Parsed summaries only; never the authorization signatures. */
  authorizations: readonly Eip7702AuthorizationSummary[];
  authorizationMetadata: "complete" | "incomplete";
  delegateAddresses?: readonly Address[];
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  replacementCandidateFor?: string;
  competingCandidateIds?: readonly string[];
  replaces?: string;
  replacedBy?: string;
}

export type Erc4337EntryPointVersion = "0.7" | "unknown";
export type Erc4337OperationState =
  | "prepared"
  | "awaiting-approval"
  | "submitted"
  | "uncertain"
  | "included-success"
  | "included-reverted"
  | "rejected"
  | "unknown";
export type Erc4337Evidence =
  | "local-plan"
  | "configured-bundler"
  | "canonical-entrypoint-event"
  | "legacy-history";

export type Erc4337GasPayment =
  | { kind: "self-paid" }
  | {
      kind: "sponsored";
      sponsorId: string;
      paymaster: Address;
      profile: "verifying-paymaster-v0.7.0";
      status: "offered" | "verified" | "expired" | "unavailable" | "unknown";
      validAfter?: bigint;
      validUntil?: bigint;
      maximumSponsoredGasCostWei?: bigint;
    };

/** Compact UserOperation metadata. Full requests, signatures and calldata are absent. */
export interface Erc4337Operation extends OperationBase {
  executionType: "erc4337";
  userOpHash: Hex;
  sender: Address;
  nonce: bigint;
  /** Null only for backward-compatible Prompt #5 history. */
  entryPoint: Address | null;
  entryPointVersion: Erc4337EntryPointVersion;
  accountImplementation: string;
  operationState: Erc4337OperationState;
  evidence: Erc4337Evidence;
  nonceKey?: bigint;
  nonceSequence?: bigint;
  outerTransactionHash?: Hex;
  executionResult?: "success" | "reverted" | "unknown";
  actualGasCostWei?: bigint;
  actualGasUsed?: bigint;
  canonicalBlockHash?: Hex;
  canonicalBlockNumber?: bigint;
  gasPayment: Erc4337GasPayment;
}

export type WalletOperation =
  EoaOperation | Eip7702Operation | Erc4337Operation;

/** A high-level, protected pointer. Detailed media replacements stay in Patio lineage. */
export interface PatioBroadcastOperationReference {
  id: string;
  chainId: number;
  createdAtMs: number;
  updatedAtMs: number;
  source: "patio";
  control: "patio-broadcast-protected";
  executionType: "patio-broadcast";
  broadcastId: string;
  status: "preparing" | "live" | "cleaning" | "completed" | "held" | "failed";
  label?: string;
}

export type KnownOperation = WalletOperation | PatioBroadcastOperationReference;

export type EoaReplacementActionKind = "speed-up" | "cancel";
export type EoaReplacementAuditResult =
  | "planned"
  | "wallet-rejected"
  | "submitted"
  | "verified"
  | "verification-failed"
  | "aborted";

/** Persisted review metadata only. It deliberately excludes call data and signed bytes. */
export interface EoaReplacementActionAudit {
  id: string;
  action: EoaReplacementActionKind;
  chainId: number;
  originalOperationId: string;
  replacementOperationId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  result: EoaReplacementAuditResult;
  transactionType: EoaOperation["transactionType"];
  gasPriceWei?: bigint;
  maxFeePerGasWei?: bigint;
  maxPriorityFeePerGasWei?: bigint;
}

/** Compact evidence from a connected wallet. It never changes chain evidence. */
export type WalletCallApiAvailability =
  | "available"
  | "unavailable"
  | "unauthorized"
  | "malformed"
  | "temporary-failure"
  | "unknown";

/** EIP-5792's atomic capability, kept separate from Patio transport policy. */
export type WalletCallAtomicCapability =
  "supported" | "ready" | "unsupported" | "unknown";

export interface WalletCallCapabilitySnapshot {
  providerSessionId: string;
  account: Address;
  chainId: number;
  observedAtMs: number;
  evidence: "reported-by-connected-wallet";
  availability: WalletCallApiAvailability;
  /** The capability declared for exactly `chainId`, never inferred from `0x0`. */
  atomic: WalletCallAtomicCapability;
  /** Global data is visible for explanation, but cannot authorize this chain. */
  globalAtomic: WalletCallAtomicCapability;
  chainEntryPresent: boolean;
  globalEntryPresent: boolean;
  detail?: string;
}

/** A single ordinary Wallet Call API input. Contract creation is out of scope. */
export interface WalletCall {
  to: Address;
  data?: Hex;
  valueWei?: bigint;
}

export interface WalletCallBatchPlan {
  version: "2.0.0";
  requestId: string;
  providerSessionId: string;
  account: Address;
  chainId: number;
  calls: readonly WalletCall[];
  callCount: number;
  totalNativeValueWei: bigint;
  atomicRequired: true;
  capabilityObservedAtMs: number;
  reviewedAtMs: number;
  reviewExpiresAtMs: number;
  reviewFingerprint: string;
}

export type WalletCallBatchState =
  | "submitted"
  | "uncertain"
  | "pending"
  | "included"
  | "offchain-failed"
  | "execution-reverted"
  | "partial-failure"
  | "unknown";

/** Receipt summary intentionally excludes logs and every call's calldata. */
export interface WalletCallReceiptSummary {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  status: "success" | "reverted";
}

/** A batch ID is opaque: it is not a transaction hash or a single EOA nonce. */
export interface WalletCallBatchRecord {
  id: string;
  requestId: string;
  walletBatchId?: string;
  providerSessionId: string;
  account: Address;
  chainId: number;
  callCount: number;
  totalNativeValueWei: bigint;
  atomicRequired: true;
  atomicReported?: boolean;
  atomicityInconsistent?: boolean;
  state: WalletCallBatchState;
  rawStatusCode?: number;
  transactionHashes: readonly Hex[];
  receipts: readonly WalletCallReceiptSummary[];
  createdAtMs: number;
  updatedAtMs: number;
  evidence: "wallet-call-api";
  detail?: string;
}

export interface OperationStore {
  version: 1;
  maximumEntries: number;
  entries: readonly KnownOperation[];
  actionAudits: readonly EoaReplacementActionAudit[];
  callBatches: readonly WalletCallBatchRecord[];
}

export interface OperationStatusEvidence {
  status: OperationStatus;
  observedAtMs: number;
}

/** Read-only adapter boundary. It intentionally has no signer or send method. */
export interface OperationStatusReader {
  readEoaStatus(operation: EoaOperation): Promise<OperationStatusEvidence>;
}

export interface OperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
