/** B3 lab only. No production caller; no provider discovery or generic proxy. */
import { PATIO_DEFAULTS, PATIO_NETWORK_PROFILES } from "@patio/config";
import { createFeePlan, MEDIA_TRANSACTION_GAS } from "@patio/ethereum";
import { packetToHex } from "@patio/protocol";
import {
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ClassicSession, type ClassicRpc } from "../../lib/classic-session";
import type { BrowserEthereumRpc } from "../../lib/direct-hoodi";
import type { FundingLedger } from "./cancellation";
import { classicExposurePlan } from "../../lib/direct-plan";
import {
  createPatioReturnPlan,
  snapshotReturnRecipient,
} from "../../lib/atomic-public-setup";

export const CHAIN = 560048;
export const OPERATOR = getAddress(
  "0xca490deA7D7D79Bac4537D5Fe68fF10cd9c7EbEd",
);
export const GENESIS =
  "0xbbe312868b376a3001692a646dd2d7d1e4406380dfd86b98aa8a34d1557c971b";
export const PROVIDERS = ["chainstack", "alchemy", "drpc"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const CADENCE = PATIO_DEFAULTS.chunkDurationMs;
export const CAPACITY = 5;
export const json = (v: unknown) =>
  JSON.stringify(
    v,
    (_, x: unknown) => (typeof x === "bigint" ? x.toString() : x),
    2,
  );
export const delay = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
export function packet(streamId: Hex, sequence: number) {
  return packetToHex({
    version: 1,
    type: 2,
    codec: 1,
    flags: 0,
    streamId,
    windowIndex: 0,
    sequence,
    capturedAtMs: BigInt(sequence * CADENCE),
    // Valid framing/checksum with synthetic bytes, NOT decodable WebM/audio.
    payload: new Uint8Array(6000).fill(65 + sequence),
  });
}
export function planFor(base: bigint, tip: bigint) {
  const plan = classicExposurePlan(
    createFeePlan({
      baseFeePerGasWei: base,
      priorityFeePerGasWei: tip,
      requestedWindows: 1,
      replacementsPerWindow: CAPACITY,
      chunkDurationMs: CADENCE,
      budgetWei: PATIO_NETWORK_PROFILES.hoodi.safety.maximumSessionExposureWei,
      networkProfile: PATIO_NETWORK_PROFILES.hoodi,
    }),
  );
  const returnPlan = createPatioReturnPlan({
    recipient: OPERATOR,
    recipientSnapshot: snapshotReturnRecipient("0x"),
    feePlan: plan,
  });
  if (
    plan.windows !== 1 ||
    plan.mediaFeeLadderWei.length !== CAPACITY ||
    returnPlan.requiredFundingWei >
      PATIO_NETWORK_PROFILES.hoodi.safety.maximumSessionExposureWei
  )
    throw new Error("Plan exceeds existing ceiling; no automatic smaller test");
  return { plan, returnPlan };
}
export type Review = {
  schema: 1;
  chainId: number;
  sender: "chainstack";
  readers: readonly Provider[];
  operator: Address;
  session: Address;
  streamId: Hex;
  g: 0;
  m: 1;
  sweepNonce: 2;
  candidates: 5;
  cadenceMs: number;
  fundingWei: bigint;
  maximumSessionGasWei: bigint;
  marginWei: bigint;
  mediaFees: bigint[];
  mediaTips: bigint[];
  cleanupFee: bigint;
  cleanupTip: bigint;
  mediaGas: bigint;
  sweepGas: bigint;
  fundingGas: bigint;
  fundingFeeCap: bigint;
  fundingTip: bigint;
  quotedAt: number;
  block: Hex;
  blockHash: Hex;
};
export const reviewId = (review: Review) =>
  keccak256(new TextEncoder().encode(json(review)));

/** A capability only this retained lab instance can arm, after exact review approval.
 * Expiry prevents a new funding start, never reconciliation/closure after funding. */
export class Permit {
  #approved = false;
  #funding = false;
  #confirmed = false;
  #attempted = new Set<Hex>();
  #signing = false;
  #signatureAttempted = false;
  #cancelled = false;
  constructor(readonly review: Review) {}
  approve(id: string, amount: string, now = Date.now()) {
    if (
      this.#approved ||
      id !== reviewId(this.review) ||
      amount !== String(this.review.fundingWei) ||
      now - this.review.quotedAt > 30 * 60_000
    )
      throw new Error("Explicit current exact-plan approval required");
    this.#approved = true;
  }
  claimFunding(chain: number, operator: Address, to: Address, amount: bigint) {
    if (
      !this.#approved ||
      this.#funding ||
      chain !== CHAIN ||
      operator.toLowerCase() !== this.review.operator.toLowerCase() ||
      to.toLowerCase() !== this.review.session.toLowerCase() ||
      amount !== this.review.fundingWei ||
      Date.now() - this.review.quotedAt > 30 * 60_000
    )
      throw new Error("Funding not authorized or already claimed");
    this.#funding = true;
  }
  get fundingClaimed() {
    return this.#funding;
  }
  confirmFunding(session: ClassicSession) {
    const attempt = session.financial.find((f) => f.role === "funding");
    if (
      !this.#approved ||
      !this.#funding ||
      !attempt?.hash ||
      attempt.state !== "confirmed" ||
      attempt.to.toLowerCase() !== this.review.session.toLowerCase() ||
      attempt.value !== this.review.fundingWei ||
      session.held
    )
      throw new Error("Exact funding not confirmed; signing forbidden");
    this.#confirmed = true;
  }
  assertSign() {
    if (
      this.#cancelled ||
      !this.#approved ||
      !this.#funding ||
      !this.#confirmed
    )
      throw new Error(
        "No signing before explicit approval and confirmed funding",
      );
  }
  beginSign() {
    this.assertSign();
    if (this.#signing) throw new Error("Concurrent signature forbidden");
    this.#signing = true;
    this.#signatureAttempted = true;
  }
  endSign() {
    this.#signing = false;
  }
  get signatureAttempted() {
    return this.#signatureAttempted;
  }
  assertCancellationAvailable(session: ClassicSession) {
    if (
      this.#cancelled ||
      this.#signing ||
      this.#signatureAttempted ||
      this.#attempted.size ||
      session.signatures.length ||
      session.cleanupStarted ||
      session.sweepClaimed
    )
      throw new Error(
        "Any signature/operation prevents pre-media cancellation",
      );
  }
  claimCancellation(session: ClassicSession) {
    this.assertCancellationAvailable(session);
    this.#cancelled = true;
    session.freeze(); // irreversible; cancellation never re-enables streaming
  }
  confirmObservedFunding(session: ClassicSession, ledger: FundingLedger) {
    const attempt = session.financial.find((f) => f.role === "funding");
    if (
      !this.#approved ||
      !this.#funding ||
      !ledger.ready ||
      this.#cancelled ||
      this.#signatureAttempted ||
      session.signatures.length !== 0 ||
      session.frozen ||
      attempt?.hash !== ledger.observation?.hash ||
      ledger.plannedWei !== this.review.fundingWei ||
      ledger.observation?.to.toLowerCase() !==
        this.review.session.toLowerCase() ||
      ledger.observation?.from.toLowerCase() !==
        this.review.operator.toLowerCase()
    )
      throw new Error("Funding observation/recognition not approved");
    this.#confirmed = true;
  }
  async claimSend(raw: Hex, session: ClassicSession) {
    this.assertSign();
    const hash = keccak256(raw),
      tx = parseTransaction(raw);
    const sig = session.signatures.find((s) => s.hash === hash);
    if (
      !sig ||
      sig.outcome !== "send-attempted" ||
      this.#attempted.has(hash) ||
      this.#attempted.size >= 8 ||
      tx.type !== "eip1559" ||
      tx.chainId !== CHAIN ||
      (
        await recoverTransactionAddress({
          serializedTransaction: raw as TransactionSerialized,
        })
      ).toLowerCase() !== this.review.session.toLowerCase() ||
      tx.nonce !== Number(sig.nonce) ||
      tx.gas !== sig.gas ||
      tx.maxFeePerGas !== sig.maxFee ||
      tx.maxPriorityFeePerGas !== sig.tip ||
      tx.to?.toLowerCase() !==
        (sig.role === "sweep"
          ? this.review.operator
          : this.review.session
        ).toLowerCase() ||
      (sig.role !== "sweep" && (tx.value ?? 0n) !== 0n) ||
      (sig.role === "media"
        ? tx.data !== packet(this.review.streamId, sig.index)
        : (tx.data ?? "0x") !== "0x") ||
      (sig.role === "sweep" &&
        (tx.value ?? 0n) !==
          (session.sweepSnapshot?.balance ?? 0n) - sig.gas * sig.maxFee)
    )
      throw new Error("Send outside registered approved envelope");
    // Claimed before network. No timeout, rejection or 429 permits another attempt.
    this.#attempted.add(hash);
  }
}

export function retainedSession(
  account: PrivateKeyAccount,
  review: Review,
  fees: ReturnType<typeof planFor>,
  read: ClassicRpc,
  send: ClassicRpc,
  permit: Permit,
) {
  // Wrap the actual signer boundary; key never leaves this process.
  const guarded = {
    ...account,
    signTransaction: (async (
      ...args: Parameters<PrivateKeyAccount["signTransaction"]>
    ) => {
      permit.beginSign();
      try {
        return await account.signTransaction(...args);
      } finally {
        permit.endSign();
      }
    }) as PrivateKeyAccount["signTransaction"],
  };
  return new ClassicSession({
    attemptId: reviewId(review),
    account: guarded,
    operator: review.operator,
    chainId: CHAIN,
    g: 0n,
    ...fees,
    replacements: CAPACITY,
    fromBlock: BigInt(review.block),
    clients: { read, send, observer: read as BrowserEthereumRpc },
  });
}

/** Seal observation is explicitly by hash, never a fake txpool response.
 * Reconstruct signature/hash from the actual RPC object before permitting release. */
export async function verifySeal(
  value: unknown,
  session: ClassicSession,
  hash: Hex,
) {
  if (!value || typeof value !== "object")
    throw new Error("Seal not observed; release held");
  const t = value as Record<string, unknown>;
  const q = (k: string) => {
    const v = t[k];
    if (typeof v !== "string" || !/^0x[0-9a-f]+$/i.test(v))
      throw new Error("Invalid seal field");
    return BigInt(v);
  };
  const seal = session.signatures.find(
    (s) => s.role === "seal" && s.hash === hash,
  );
  if (
    !seal ||
    t.hash !== hash ||
    q("chainId") !== BigInt(CHAIN) ||
    q("type") !== 2n ||
    q("nonce") !== 1n ||
    q("value") !== 0n ||
    t.input !== "0x" ||
    typeof t.from !== "string" ||
    t.from.toLowerCase() !== session.input.account.address.toLowerCase() ||
    typeof t.to !== "string" ||
    t.to.toLowerCase() !== session.input.account.address.toLowerCase() ||
    q("gas") !== seal.gas ||
    q("maxFeePerGas") !== seal.maxFee ||
    q("maxPriorityFeePerGas") !== seal.tip ||
    !Array.isArray(t.accessList) ||
    t.accessList.length ||
    t.blockHash !== null ||
    t.blockNumber !== null ||
    t.transactionIndex !== null ||
    q("yParity") > 1n ||
    typeof t.r !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(t.r) ||
    typeof t.s !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(t.s)
  )
    throw new Error("Seal identity mismatch; release held");
  const raw = serializeTransaction(
    {
      type: "eip1559",
      chainId: CHAIN,
      nonce: 1,
      to: session.input.account.address,
      value: 0n,
      data: "0x",
      gas: seal.gas,
      maxFeePerGas: seal.maxFee,
      maxPriorityFeePerGas: seal.tip,
      accessList: [],
    },
    { r: t.r as Hex, s: t.s as Hex, yParity: Number(q("yParity")) },
  );
  if (
    keccak256(raw) !== hash ||
    (
      await recoverTransactionAddress({ serializedTransaction: raw })
    ).toLowerCase() !== session.input.account.address.toLowerCase()
  )
    throw new Error("Seal signature mismatch; release held");
}
export async function closeByHash(
  session: ClassicSession,
  observe: (hash: Hex) => Promise<unknown>,
  onSeal: (hash: Hex) => void = () => {},
) {
  session.beginCleanup();
  const p = session.input.plan;
  const common = {
    type: "eip1559" as const,
    chainId: CHAIN,
    to: session.input.account.address,
    value: 0n,
    data: "0x" as Hex,
    gas: 21_000n,
    maxFeePerGas: p.sealMaxFeePerGasWei,
    maxPriorityFeePerGas: p.sealPriorityFeePerGasWei,
  };
  try {
    const seal = await session.sign("seal", { ...common, nonce: 1 });
    const hash = await session.send(seal);
    await verifySeal(await observe(hash), session, hash);
    if (
      (await session.input.clients.read.latestTransactionCount(
        session.input.account.address,
      )) !== 0n
    )
      throw new Error("Gap consumed before release; reconcile only");
    onSeal(hash);
    const release = await session.sign("release", { ...common, nonce: 0 });
    await session.send(release);
  } catch (error) {
    session.held = true;
    throw error;
  }
}

export function mediaTx(review: Review, sequence: number) {
  return {
    type: "eip1559" as const,
    chainId: CHAIN,
    to: review.session,
    nonce: 1,
    value: 0n,
    data: packet(review.streamId, sequence),
    gas: MEDIA_TRANSACTION_GAS,
    maxFeePerGas: review.mediaFees[sequence]!,
    maxPriorityFeePerGas: review.mediaTips[sequence]!,
  };
}
