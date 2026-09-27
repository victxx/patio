/** Lab-only pre-media cancellation. Not streaming cleanup, not live-process recovery. */
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  classicCanonicalReceipt,
  classicReceiptFee,
  type ClassicRpc,
} from "../../lib/classic-session";
import { CHAIN, OPERATOR, json, type Review } from "./core";

type Read = Omit<ClassicRpc, "sendRawTransaction">;
type Block = { number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas: Hex };
const same = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();
export type FundingObservation = {
  hash: Hex;
  from: Address;
  to: Address;
  value: bigint;
  block: Hex;
  blockHash: Hex;
  operatorGas: bigint | null;
};

/** Observed transfer is separate from the immutable spending review. Never rewrites it. */
export async function observeFunding(
  read: Read,
  hash: Hex,
  session: Address,
): Promise<FundingObservation> {
  if ((await read.chainId()) !== CHAIN) throw new Error("Wrong chain");
  const receipt = await classicCanonicalReceipt(
    read as ClassicRpc,
    hash,
    OPERATOR,
  );
  const tx = await read.transaction(hash);
  if (
    !receipt ||
    !tx ||
    BigInt(receipt.status) !== 1n ||
    !same(tx.to, session) ||
    (tx.input ?? "0x") !== "0x" ||
    BigInt(tx.value) <= 0n
  )
    throw new Error("Exact successful operator funding not established");
  return {
    hash,
    from: OPERATOR,
    to: session,
    value: BigInt(tx.value),
    block: receipt.blockNumber,
    blockHash: receipt.blockHash!,
    operatorGas: classicReceiptFee(receipt),
  };
}

export class FundingLedger {
  observation: FundingObservation | null = null;
  recognizedExcess: {
    hash: Hex;
    actualWei: bigint;
    originalPlannedWei: bigint;
  } | null = null;
  constructor(readonly plannedWei: bigint) {}
  observe(value: FundingObservation) {
    if (
      this.observation &&
      (this.observation.hash !== value.hash ||
        this.observation.value !== value.value)
    )
      throw new Error("Funding identity changed; reconciliation required");
    this.observation = value;
  }
  recognize(hash: string, actual: string) {
    const o = this.observation;
    if (
      !o ||
      o.hash !== hash ||
      String(o.value) !== actual ||
      o.value <= this.plannedWei
    )
      throw new Error("Explicit exact excess recognition required");
    this.recognizedExcess = {
      hash: o.hash,
      actualWei: o.value,
      originalPlannedWei: this.plannedWei,
    };
  }
  get ready() {
    const o = this.observation;
    return (
      !!o &&
      (o.value === this.plannedWei ||
        (this.recognizedExcess?.hash === o.hash &&
          this.recognizedExcess.actualWei === o.value))
    );
  }
}

export type CancellationQuote = {
  purpose: "pre-media-cancellation";
  chainId: typeof CHAIN;
  provider: "chainstack";
  session: Address;
  recipient: typeof OPERATOR;
  fundingHash: Hex;
  observedFundingWei: bigint;
  nonce: 0;
  balance: bigint;
  gas: 21000n;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maximumCostWei: bigint;
  returnValueWei: bigint;
  block: Hex;
  blockHash: Hex;
  quotedAt: number;
};
export const cancellationId = (q: CancellationQuote) =>
  keccak256(new TextEncoder().encode(json(q)));

/** Quote has no signer, no account creation and no send capability. */
export async function quoteCancellation(
  read: Read,
  session: Address,
  fundingHash: Hex,
): Promise<CancellationQuote> {
  const funding = await observeFunding(read, fundingHash, session);
  const block = await read.request<Block>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  const [balance, nonce, pending, code, recipientCode, tip] = await Promise.all(
    [
      read.request<Hex>("eth_getBalance", [session, block.number]),
      read.request<Hex>("eth_getTransactionCount", [session, block.number]),
      read.request<Hex>("eth_getTransactionCount", [session, "pending"]),
      read.request<Hex>("eth_getCode", [session, block.number]),
      read.request<Hex>("eth_getCode", [OPERATOR, block.number]),
      read.request<Hex>("eth_maxPriorityFeePerGas"),
    ],
  );
  if (
    BigInt(nonce) !== 0n ||
    BigInt(pending) !== 0n ||
    code !== "0x" ||
    recipientCode !== "0x" ||
    BigInt(balance) !== funding.value ||
    Date.now() / 1000 - Number(BigInt(block.timestamp)) > 300
  )
    throw new Error(
      "Cancellation state changed, code present or unexplained balance",
    );
  const maxPriorityFeePerGas = BigInt(tip),
    maxFeePerGas = BigInt(block.baseFeePerGas) * 2n + maxPriorityFeePerGas;
  const maximumCostWei = 21000n * maxFeePerGas,
    returnValueWei = BigInt(balance) - maximumCostWei;
  if (returnValueWei <= 0n || maxFeePerGas <= 0n)
    throw new Error("No transferable balance");
  if (
    (await read.estimateGas({
      from: session,
      to: OPERATOR,
      value: returnValueWei,
      data: "0x",
    })) !== 21000n
  )
    throw new Error("Not a plain EOA cancellation");
  const canonical = await read.request<Block>("eth_getBlockByNumber", [
    block.number,
    false,
  ]);
  if (canonical.hash !== block.hash)
    throw new Error("Cancellation snapshot changed");
  return {
    purpose: "pre-media-cancellation",
    chainId: CHAIN,
    provider: "chainstack",
    session,
    recipient: OPERATOR,
    fundingHash,
    observedFundingWei: funding.value,
    nonce: 0,
    balance: BigInt(balance),
    gas: 21000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maximumCostWei,
    returnValueWei,
    block: block.number,
    blockHash: block.hash,
    quotedAt: Date.now(),
  };
}

export type CancellationRecord = {
  hash: Hex;
  nonce: 0;
  recipient: Address;
  value: bigint;
  gas: bigint;
  maxFee: bigint;
  tip: bigint;
  outcome: "signed" | "send-attempted" | "accepted" | "uncertain" | "included";
};

/** Installed BEFORE funding in NEW processes only. Exclusive claim never resets.
 * The original retained B3 process does NOT contain this capability. */
export class PreMediaCancellation {
  #claimed = false;
  #quote: CancellationQuote | null = null;
  record: CancellationRecord | null = null;
  constructor(
    private readonly input: {
      account: PrivateKeyAccount;
      review: Review;
      read: Read;
      assertIdleUnsigned: () => void;
      claimExclusive: () => void;
      send: (raw: Hex, guard: (raw: Hex) => Promise<void>) => Promise<Hex>;
      persist: () => void;
    },
  ) {
    if (
      !same(input.account.address, input.review.session) ||
      input.review.chainId !== CHAIN ||
      !same(input.review.operator, OPERATOR) ||
      input.review.sender !== "chainstack"
    )
      throw new Error("Cancellation identity mismatch");
  }
  get claimed() {
    return this.#claimed;
  }
  async quote(hash: Hex) {
    if (this.#claimed) throw new Error("Cancellation already claimed");
    this.input.assertIdleUnsigned();
    const q = await quoteCancellation(
      this.input.read,
      this.input.account.address,
      hash,
    );
    this.input.assertIdleUnsigned();
    if (q.maximumCostWei > this.input.review.maximumSessionGasWei)
      throw new Error("Exceeds original gas envelope");
    this.#quote = Object.freeze(q);
    return this.#quote;
  }
  async execute(id: string, maximumCost: string) {
    const q = this.#quote;
    if (
      !q ||
      this.#claimed ||
      id !== cancellationId(q) ||
      maximumCost !== String(q.maximumCostWei) ||
      Date.now() - q.quotedAt > 300_000
    )
      throw new Error("Separate current cancellation approval required");
    this.input.assertIdleUnsigned();
    this.input.claimExclusive(); // locks ALL streaming signatures before any await
    this.#claimed = true; // even failed validation requires read-only reconciliation, never automatic retry
    const fresh = await quoteCancellation(
      this.input.read,
      q.session,
      q.fundingHash,
    );
    if (
      fresh.balance !== q.balance ||
      fresh.maximumCostWei > q.maximumCostWei ||
      fresh.maxPriorityFeePerGas > q.maxPriorityFeePerGas
    )
      throw new Error("Cancellation state/fees changed; no signature");
    const raw = await this.input.account.signTransaction({
      type: "eip1559",
      chainId: CHAIN,
      nonce: 0,
      to: OPERATOR,
      value: q.returnValueWei,
      gas: q.gas,
      maxFeePerGas: q.maxFeePerGas,
      maxPriorityFeePerGas: q.maxPriorityFeePerGas,
      data: "0x",
    });
    const hash = keccak256(raw);
    this.record = {
      hash,
      nonce: 0,
      recipient: OPERATOR,
      value: q.returnValueWei,
      gas: q.gas,
      maxFee: q.maxFeePerGas,
      tip: q.maxPriorityFeePerGas,
      outcome: "signed",
    };
    this.input.persist(); // metadata committed before any send-capable callback
    const decoded = parseTransaction(raw);
    if (
      decoded.type !== "eip1559" ||
      decoded.chainId !== CHAIN ||
      decoded.nonce !== 0 ||
      !same(decoded.to, OPERATOR) ||
      decoded.value !== q.returnValueWei ||
      decoded.gas !== q.gas ||
      decoded.maxFeePerGas !== q.maxFeePerGas ||
      decoded.maxPriorityFeePerGas !== q.maxPriorityFeePerGas ||
      (decoded.data ?? "0x") !== "0x" ||
      !same(
        await recoverTransactionAddress({
          serializedTransaction: raw as TransactionSerialized,
        }),
        q.session,
      )
    )
      throw new Error(
        "Signed cancellation differs from reviewed envelope; no send",
      );
    let sent = false;
    try {
      const result = await this.input.send(raw, (bytes) => {
        if (
          sent ||
          keccak256(bytes) !== hash ||
          this.record?.outcome !== "signed"
        )
          throw new Error("Unregistered or duplicate cancellation send");
        sent = true;
        this.record.outcome = "send-attempted";
        this.input.persist();
        return Promise.resolve();
      });
      if (!sent || result !== hash)
        throw new Error("Cancellation outcome uncertain");
      this.record.outcome = "accepted";
    } catch {
      this.record.outcome = "uncertain";
      throw new Error("Cancellation outcome uncertain; no resend");
    } finally {
      this.input.persist();
    }
    return hash;
  }
  async reconcile() {
    const r = this.record;
    if (!r) throw new Error("No signed cancellation; no transaction invented");
    const receipt = await classicCanonicalReceipt(
      this.input.read as ClassicRpc,
      r.hash,
      this.input.account.address,
      0n,
    );
    if (!receipt) return { status: "pending-or-unknown" as const };
    const tx = await this.input.read.transaction(r.hash);
    if (
      !tx ||
      !same(tx.to, OPERATOR) ||
      BigInt(tx.value) !== r.value ||
      (tx.input ?? "0x") !== "0x" ||
      BigInt(receipt.status) !== 1n
    )
      throw new Error("Cancellation not confirmed successfully");
    r.outcome = "included";
    this.input.persist();
    return {
      status: "included-not-finalized" as const,
      hash: r.hash,
      block: receipt.blockNumber,
      blockHash: receipt.blockHash,
      returnedWei: r.value,
      gasWei: classicReceiptFee(receipt),
      residualWei: await this.input.read.balance(this.input.account.address),
    };
  }
}
