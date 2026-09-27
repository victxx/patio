import {
  keccak256,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { MEDIA_TRANSACTION_GAS, type FeePlan } from "@patio/ethereum";
import type { BrowserEthereumRpc, RpcReceipt } from "./direct-hoodi";
import { submitKnownTransaction } from "./direct-transaction-submission";
import {
  createPatioReturnPlan,
  snapshotReturnRecipient,
  type PatioReturnPlan,
} from "./atomic-public-setup";

export type ClassicRole = "media" | "seal" | "release" | "sweep" | "cancel";
export type CancellationReview = {
  balance: bigint;
  value: bigint;
  maximumGasCost: bigint;
  gas: bigint;
  block: Hex;
  blockHash: Hex;
  reviewedAt: number;
  fundingHashes: Hex[];
};
export type ClassicSignature = {
  role: ClassicRole;
  hash: Hex;
  nonce: bigint;
  index: number;
  window: number;
  gas: bigint;
  maxFee: bigint;
  tip: bigint;
  signedAt: number;
  outcome:
    | "signed"
    | "send-attempted"
    | "accepted"
    | "known"
    | "uncertain"
    | "rejected"
    | "included";
};
export type FinancialAttempt = {
  id: string;
  role: "registry" | "funding";
  to: Address;
  value: bigint;
  state: "requested" | "rejected" | "hash-received" | "uncertain" | "confirmed";
  hash?: Hex;
};
export type ClassicRpc = Pick<
  BrowserEthereumRpc,
  | "request"
  | "chainId"
  | "receipt"
  | "transaction"
  | "latestTransactionCount"
  | "balance"
  | "code"
  | "sendRawTransaction"
  | "estimateGas"
>;
type Block = { number: Hex; hash: Hex; baseFeePerGas: Hex };
const same = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exact receipt identity + canonical block, not a balance or pending nonce heuristic.
 * No chain scan, no claim of finality. A later reconciliation can invalidate inclusion. */
export async function classicCanonicalReceipt(
  rpc: ClassicRpc,
  hash: Hex,
  from: Address,
  nonce?: bigint,
): Promise<RpcReceipt | null> {
  const receipt = await rpc.receipt(hash);
  if (!receipt) return null;
  if (!same(receipt.transactionHash, hash) || !receipt.blockHash)
    throw new Error("Canonical receipt identity unavailable");
  const [block, tx] = await Promise.all([
    rpc.request<Block | null>("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]),
    rpc.transaction(hash),
  ]);
  if (!block || !same(block.hash, receipt.blockHash))
    throw new Error(
      "Canonical evidence changed (possible reorg); keep session open",
    );
  if (
    !tx ||
    !same(tx.hash, hash) ||
    !same(tx.from, from) ||
    (nonce !== undefined && BigInt(tx.nonce) !== nonce)
  )
    throw new Error("Canonical transaction identity mismatch");
  return receipt;
}

export function classicReceiptFee(receipt: RpcReceipt): bigint | null {
  return receipt.gasUsed === undefined ||
    receipt.effectiveGasPrice === undefined
    ? null
    : BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
}

/** Scoped to NEW classic-v2 sessions. In-memory ownership only; never a public
 * authorization or sender capability. Retirement and legacy pre-signed sweeps
 * cannot enter this class. The coordinator retains it BEFORE any wallet call. */
export class ClassicSession {
  readonly mode = "classic-v2";
  readonly signatures: ClassicSignature[] = [];
  readonly financial: FinancialAttempt[] = [];
  readonly financialFees = new Map<FinancialAttempt["role"], bigint | null>();
  readonly mediaIncluded = new Set<Hex>(); // sticky even across later sweep/reorg
  readonly receipts = new Map<Hex, RpcReceipt>();
  frozen = false;
  cleanupStarted = false;
  held = false;
  sweepClaimed = false;
  returned: bigint | null = null;
  residual: bigint | null = null;
  sweepSnapshot: {
    blockNumber: Hex;
    blockHash: Hex;
    balance: bigint;
    nonce: bigint;
  } | null = null;
  private signing = false;
  private captureClaimed = false;
  cancellationClaimed = false;
  cancellationReview: CancellationReview | null = null;
  readonly fundings = new Map<
    Hex,
    { value: bigint; gas: bigint | null; blockHash: Hex }
  >();
  private readonly usedSlots = new Set<string>();
  private nextMedia = 0;
  constructor(
    readonly input: {
      attemptId: string;
      account: PrivateKeyAccount;
      operator: Address;
      chainId: number;
      g: bigint;
      plan: FeePlan;
      replacements: number;
      returnPlan: PatioReturnPlan;
      fromBlock: bigint;
      clients: {
        read: ClassicRpc;
        send: ClassicRpc;
        observer: BrowserEthereumRpc;
      };
    },
  ) {
    if (
      input.plan.windows < 1 ||
      !("exposurePolicy" in input.plan) ||
      input.plan.exposurePolicy !== "classic-per-nonce-v2" ||
      input.replacements !== input.plan.mediaFeeLadderWei.length
    )
      throw new Error("Invalid classic inventory capacity");
  }
  get sweepNonce() {
    return this.input.g + BigInt(this.input.plan.windows) + 1n;
  }
  get capacity() {
    return (
      this.input.plan.windows * this.input.replacements +
      this.input.plan.windows +
      2
    );
  }
  freeze() {
    this.frozen = true;
  }
  beginCleanup() {
    if (this.cancellationClaimed)
      throw new Error(
        "Cancellation owns this session; streaming cleanup forbidden",
      );
    this.freeze();
    if (this.cleanupStarted || this.signing)
      throw new Error(
        "Cleanup already requested or signing still active; reconciliation only",
      );
    this.cleanupStarted = true;
  }
  claimCapture() {
    if (
      this.captureClaimed ||
      this.cancellationClaimed ||
      this.frozen ||
      this.held ||
      this.signing
    )
      throw new Error("Capture unavailable for this retained session");
    this.captureClaimed = true;
  }
  private assertPreMediaCancellation() {
    if (
      this.captureClaimed ||
      this.cleanupStarted ||
      this.signing ||
      this.sweepClaimed ||
      this.financial.some((f) => f.state === "requested") ||
      this.signatures.some(
        (s) => !["seal", "release"].includes(s.role) || s.outcome !== "signed",
      )
    )
      throw new Error(
        "Pre-media cancellation requires exclusively local, unexposed empty cleanup signatures and idle operations",
      );
    // sign() enforces zero value/data, self destination, approved nonces/fees for
    // these slots. Raw bytes remain exclusively owned by this browser session.
  }
  async reviewCancellation(
    hashes: readonly Hex[],
  ): Promise<CancellationReview> {
    if (this.cancellationClaimed)
      throw new Error("Cancellation already claimed; reconcile only");
    this.assertPreMediaCancellation();
    const { read } = this.input.clients;
    const unique = [...new Set(hashes.map((h) => h.toLowerCase() as Hex))];
    if (!unique.length || unique.length > 16)
      throw new Error("Provide bounded exact funding hashes");
    let total = 0n;
    for (const hash of unique) {
      const receipt = await classicCanonicalReceipt(
        read,
        hash,
        this.input.operator,
      );
      const tx = await read.transaction(hash);
      if (
        !receipt ||
        !tx ||
        BigInt(receipt.status) !== 1n ||
        !same(tx.to, this.input.account.address) ||
        (tx.input ?? tx.data ?? "0x") !== "0x" ||
        BigInt(tx.value) <= 0n
      )
        throw new Error("Exact canonical operator funding required");
      total += BigInt(tx.value);
      this.fundings.set(hash, {
        value: BigInt(tx.value),
        gas: classicReceiptFee(receipt),
        blockHash: receipt.blockHash!,
      });
    }
    const block = await read.request<Block>("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const [balance, nonce, pending, sessionCode, recipientCode, chain] =
      await Promise.all([
        read.request<Hex>("eth_getBalance", [
          this.input.account.address,
          block.number,
        ]),
        read.request<Hex>("eth_getTransactionCount", [
          this.input.account.address,
          block.number,
        ]),
        read.request<Hex>("eth_getTransactionCount", [
          this.input.account.address,
          "pending",
        ]),
        read.request<Hex>("eth_getCode", [
          this.input.account.address,
          block.number,
        ]),
        read.request<Hex>("eth_getCode", [this.input.operator, block.number]),
        read.chainId(),
      ]);
    const gas = this.input.returnPlan.sweepGasLimit;
    const maximumGasCost = gas * this.input.plan.sealMaxFeePerGasWei;
    if (
      chain !== this.input.chainId ||
      BigInt(nonce) !== this.input.g ||
      BigInt(pending) !== this.input.g ||
      sessionCode !== "0x" ||
      !same(recipientCode, this.input.returnPlan.recipientCode) ||
      BigInt(balance) !== total ||
      BigInt(block.baseFeePerGas) + this.input.plan.sealPriorityFeePerGasWei >
        this.input.plan.sealMaxFeePerGasWei ||
      total <= maximumGasCost
    )
      throw new Error(
        "Cancellation balance, nonce, code or fees need reconciliation; no signature",
      );
    if (recipientCode !== "0x") {
      const estimate = await read.estimateGas({
        from: this.input.account.address,
        to: this.input.operator,
        value: total - maximumGasCost,
        data: "0x",
      });
      const simulated = createPatioReturnPlan({
        recipient: this.input.operator,
        recipientSnapshot: snapshotReturnRecipient(recipientCode),
        feePlan: this.input.plan,
        estimatedSweepGas: estimate,
      });
      if (simulated.sweepGasLimit > gas)
        throw new Error("Cancellation simulation exceeds reviewed reserve");
    }
    this.assertPreMediaCancellation();
    return (this.cancellationReview = {
      balance: total,
      value: total - maximumGasCost,
      maximumGasCost,
      gas,
      block: block.number,
      blockHash: block.hash,
      reviewedAt: Date.now(),
      fundingHashes: unique,
    });
  }
  async cancelBeforeMedia(approved: CancellationReview): Promise<Hex> {
    if (
      approved !== this.cancellationReview ||
      Date.now() - approved.reviewedAt > 120_000 ||
      this.cancellationClaimed
    )
      throw new Error("Separate current cancellation approval required");
    this.assertPreMediaCancellation();
    // Synchronous exclusive claim wins against Start and cleanup before reads.
    this.cancellationClaimed = true;
    this.freeze();
    try {
      // reviewCancellation is deliberately unavailable after the claim; validate
      // again through the same checks without releasing the ownership latch.
      const read = this.input.clients.read;
      const [chain, balance, nonce, pending, code, recipientCode, block] =
        await Promise.all([
          read.chainId(),
          read.balance(this.input.account.address),
          read.latestTransactionCount(this.input.account.address),
          read.request<Hex>("eth_getTransactionCount", [
            this.input.account.address,
            "pending",
          ]),
          read.code(this.input.account.address),
          read.code(this.input.operator),
          read.request<Block>("eth_getBlockByNumber", ["latest", false]),
        ]);
      for (const hash of approved.fundingHashes) {
        const receipt = await classicCanonicalReceipt(
          read,
          hash,
          this.input.operator,
        );
        if (
          !receipt ||
          receipt.blockHash !== this.fundings.get(hash)?.blockHash
        )
          throw new Error("Funding canonical evidence changed");
      }
      if (
        chain !== this.input.chainId ||
        balance !== approved.balance ||
        nonce !== this.input.g ||
        BigInt(pending) !== nonce ||
        code !== "0x" ||
        !same(recipientCode, this.input.returnPlan.recipientCode) ||
        BigInt(block.baseFeePerGas) + this.input.plan.sealPriorityFeePerGasWei >
          this.input.plan.sealMaxFeePerGasWei
      )
        throw new Error(
          "Cancellation review changed; retained without automatic retry",
        );
      this.signing = true;
      const raw = await this.input.account.signTransaction({
        type: "eip1559",
        chainId: chain,
        nonce: Number(nonce),
        to: this.input.operator,
        value: approved.value,
        data: "0x",
        gas: approved.gas,
        maxFeePerGas: this.input.plan.sealMaxFeePerGasWei,
        maxPriorityFeePerGas: this.input.plan.sealPriorityFeePerGasWei,
      });
      const hash = keccak256(raw);
      this.signatures.push({
        role: "cancel",
        hash,
        nonce,
        index: 0,
        window: -1,
        gas: approved.gas,
        maxFee: this.input.plan.sealMaxFeePerGasWei,
        tip: this.input.plan.sealPriorityFeePerGasWei,
        signedAt: Date.now(),
        outcome: "signed",
      });
      this.signing = false;
      return await this.send(raw);
    } catch (cause) {
      this.held = true;
      throw cause;
    } finally {
      this.signing = false;
    }
  }
  async confirmCancellation(): Promise<boolean> {
    const signature = this.signatures.find((s) => s.role === "cancel");
    if (!signature || !this.cancellationReview)
      throw new Error("No cancellation signature to reconcile");
    const receipt = await classicCanonicalReceipt(
      this.input.clients.read,
      signature.hash,
      this.input.account.address,
      this.input.g,
    );
    if (!receipt) return false;
    const tx = await this.input.clients.read.transaction(signature.hash);
    if (
      !tx ||
      !same(tx.to, this.input.operator) ||
      BigInt(tx.value) !== this.cancellationReview.value ||
      BigInt(receipt.status) !== 1n
    )
      throw new Error("Cancellation did not confirm the reviewed return");
    signature.outcome = "included";
    this.receipts.set(signature.hash, receipt);
    this.returned = BigInt(tx.value);
    this.residual = await this.input.clients.read.balance(
      this.input.account.address,
    );
    this.held = false;
    return true;
  }
  async financialRequest(
    role: FinancialAttempt["role"],
    to: Address,
    value: bigint,
    revalidate: () => Promise<void>,
    send: () => Promise<Hex>,
  ): Promise<Hex> {
    if (this.financial.some((entry) => entry.role === role))
      throw new Error("Financial attempt already retained; no retry");
    if (this.financial.some((entry) => entry.state !== "confirmed"))
      throw new Error("Earlier financial attempt unresolved");
    // Claim before the first await; a double click cannot enter the wallet twice.
    const entry: FinancialAttempt = {
      id: `${this.input.attemptId}:${role}`,
      role,
      to,
      value,
      state: "requested",
    };
    this.financial.push(entry);
    let dispatched = false;
    try {
      await revalidate();
      dispatched = true;
      const hash = await send();
      entry.hash = hash;
      entry.state = "hash-received";
      return hash;
    } catch (cause) {
      // Only an explicit EIP-1193 user rejection proves no wallet submission.
      const rejected =
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === 4001;
      entry.state = !dispatched || rejected ? "rejected" : "uncertain";
      this.held = true;
      throw cause;
    }
  }
  async confirmFinancial(
    role: FinancialAttempt["role"],
    attempts = 1,
    wait = delay,
  ): Promise<RpcReceipt> {
    const entry = this.financial.find((item) => item.role === role);
    if (!entry?.hash)
      throw new Error(
        "Financial result unknown: no exact hash; do not prepare again",
      );
    try {
      for (let i = 0; i < attempts; i++) {
        const receipt = await classicCanonicalReceipt(
          this.input.clients.read,
          entry.hash,
          this.input.operator,
        );
        if (receipt) {
          const tx = await this.input.clients.read.transaction(entry.hash);
          if (
            !tx ||
            !same(tx.to, entry.to) ||
            BigInt(tx.value) !== entry.value ||
            BigInt(receipt.status) !== 1n
          )
            throw new Error(
              "Financial transaction did not confirm the reviewed action",
            );
          entry.state = "confirmed";
          this.financialFees.set(role, classicReceiptFee(receipt));
          return receipt;
        }
        if (i + 1 < attempts) await wait(2_000);
      }
      throw new Error("Financial confirmation pending; keep this tab open");
    } catch (cause) {
      entry.state = "uncertain";
      this.held = true;
      throw cause;
    }
  }
  async reconcileFunding(attempts = 1): Promise<void> {
    if (this.frozen || this.signatures.some((entry) => entry.role === "media"))
      throw new Error("Funding readiness cannot restart an exposed session");
    try {
      await this.confirmFinancial("funding", attempts);
      const funding = this.financial.find((entry) => entry.role === "funding")!;
      if (
        (await this.input.clients.read.balance(this.input.account.address)) <
        funding.value
      )
        throw new Error(
          "Confirmed funding balance changed; retained for reconciliation",
        );
      this.held = false;
    } catch (cause) {
      this.held = true;
      throw cause;
    }
  }
  async sign(
    role: ClassicRole,
    tx: TransactionSerializableEIP1559,
    index = 0,
  ): Promise<Hex> {
    if (this.cancellationClaimed || role === "cancel")
      throw new Error("Cancellation owns signing; no streaming signatures");
    const { plan, g, replacements, account, chainId, operator, returnPlan } =
      this.input;
    const window =
      role === "media"
        ? Math.floor(index / replacements)
        : role === "seal"
          ? index
          : -1;
    const nonce =
      role === "release"
        ? g
        : role === "sweep"
          ? this.sweepNonce
          : g + 1n + BigInt(window);
    const step = index % replacements;
    const maxFee =
      role === "media"
        ? plan.mediaFeeLadderWei[step]!
        : plan.sealMaxFeePerGasWei;
    const tip =
      role === "media"
        ? plan.mediaPriorityFeeLadderWei[step]!
        : plan.sealPriorityFeePerGasWei;
    const gas =
      role === "media"
        ? MEDIA_TRANSACTION_GAS
        : role === "sweep"
          ? returnPlan.sweepGasLimit
          : 21_000n;
    const slot = `${role}:${index}`;
    if (this.signing)
      throw new Error(`Signing already in progress; cannot sign ${slot}`);
    if (this.usedSlots.has(slot))
      throw new Error(
        `Signature already reserved for ${slot}; never sign it twice`,
      );
    if (this.signatures.length >= this.capacity)
      throw new Error(
        `Signature inventory full (${this.signatures.length}/${this.capacity}); cannot sign ${slot}`,
      );
    if (
      role === "media" &&
      (this.frozen ||
        this.held ||
        index !== this.nextMedia ||
        index >= plan.windows * replacements)
    )
      throw new Error("Media signing frozen or outside approved sequence");
    if (
      role === "sweep" &&
      (!this.sweepClaimed || !this.frozen || !this.sweepSnapshot)
    )
      throw new Error("Sweep not reconciled");
    if (
      role === "sweep" &&
      tx.value !== this.sweepSnapshot!.balance - gas * maxFee
    )
      throw new Error("Sweep value outside reconciled reserve");
    if (role === "seal" && (index < 0 || index >= plan.windows))
      throw new Error("Seal outside plan");
    if (
      tx.type !== "eip1559" ||
      tx.chainId !== chainId ||
      BigInt(tx.nonce ?? -1) !== nonce ||
      !same(tx.to, role === "sweep" ? operator : account.address) ||
      tx.gas !== gas ||
      tx.maxFeePerGas !== maxFee ||
      tx.maxPriorityFeePerGas !== tip ||
      (role !== "sweep" && tx.value !== 0n) ||
      (role !== "media" && tx.data !== "0x")
    )
      throw new Error("Signature outside approved classic plan");
    this.signing = true;
    this.usedSlots.add(slot);
    try {
      const raw = await account.signTransaction(tx);
      this.signatures.push({
        role,
        hash: keccak256(raw),
        nonce,
        index,
        window,
        gas,
        maxFee,
        tip,
        signedAt: Date.now(),
        outcome: "signed",
      });
      if (role === "media") this.nextMedia++;
      return raw;
    } catch (cause) {
      this.held = true;
      this.freeze();
      throw cause;
    } finally {
      this.signing = false;
    }
  }
  async send(raw: Hex): Promise<Hex> {
    const signature = this.signatures.find((item) =>
      same(item.hash, keccak256(raw)),
    );
    if (!signature) throw new Error("Unregistered signature: send forbidden");
    if (this.cancellationClaimed && signature.role !== "cancel")
      throw new Error("Prepared cleanup disabled by exclusive cancellation");
    if (signature.outcome !== "signed") {
      if (
        signature.outcome === "accepted" ||
        signature.outcome === "known" ||
        signature.outcome === "included"
      )
        return signature.hash;
      throw new Error("Submission already attempted; reconciliation only");
    }
    if (signature.role === "media" && (this.frozen || this.held))
      throw new Error("Media exposure frozen before send");
    signature.outcome = "send-attempted";
    try {
      const result = await submitKnownTransaction(this.input.clients.send, raw);
      signature.outcome = result.evidence === "accepted" ? "accepted" : "known";
      return result.hash;
    } catch (cause) {
      signature.outcome = "uncertain";
      this.held = true;
      if (signature.role === "media") this.freeze();
      throw cause;
    }
  }
  async reconcile(
    attempts = 1,
    wait = delay,
    afterSweep = false,
  ): Promise<void> {
    const { read } = this.input.clients;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const nonce = await read.latestTransactionCount(
          this.input.account.address,
        );
        let complete = true;
        for (let n = this.input.g; n < this.sweepNonce; n++) {
          const candidates = this.signatures.filter((item) => item.nonce === n);
          let winner: ClassicSignature | undefined;
          for (const candidate of candidates) {
            const receipt = await classicCanonicalReceipt(
              read,
              candidate.hash,
              this.input.account.address,
              n,
            );
            if (!receipt) {
              this.receipts.delete(candidate.hash);
              continue;
            }
            if (BigInt(receipt.blockNumber) < this.input.fromBlock || winner)
              throw new Error("Inconsistent canonical winner evidence");
            winner = candidate;
            candidate.outcome = "included";
            this.receipts.set(candidate.hash, receipt);
            if (candidate.role === "media")
              this.mediaIncluded.add(candidate.hash);
            else if (BigInt(receipt.status) !== 1n)
              throw new Error(
                "Classic cleanup reverted; reconciliation required",
              );
          }
          if (nonce > n && !winner)
            throw new Error(
              "UNKNOWN WINNER: consumed nonce without an identified canonical candidate",
            );
          if (!winner || nonce <= n) complete = false;
        }
        if (
          complete &&
          (nonce === this.sweepNonce ||
            (afterSweep && nonce === this.sweepNonce + 1n))
        ) {
          this.held = false;
          return;
        }
        if (nonce > this.sweepNonce)
          throw new Error(
            "Sweep nonce already consumed; do not sign another transaction",
          );
        if (attempt + 1 < attempts) await wait(2_000);
      }
      throw new Error(
        "Classic closure pending: not all media nonces reconciled",
      );
    } catch (cause) {
      this.held = true;
      throw cause;
    }
  }
  async sweep(): Promise<Hex | null> {
    if (this.sweepClaimed || !this.frozen || !this.cleanupStarted)
      throw new Error(
        "Sweep unavailable or already attempted; reconciliation only",
      );
    this.sweepClaimed = true; // never released on timeout/error
    const { read } = this.input.clients;
    try {
      await this.reconcile();
      const block = await read.request<Block>("eth_getBlockByNumber", [
        "latest",
        false,
      ]);
      const [balanceHex, nonceHex, code] = await Promise.all([
        read.request<Hex>("eth_getBalance", [
          this.input.account.address,
          block.number,
        ]),
        read.request<Hex>("eth_getTransactionCount", [
          this.input.account.address,
          block.number,
        ]),
        read.request<Hex>("eth_getCode", [this.input.operator, block.number]),
      ]);
      const balance = BigInt(balanceHex),
        nonce = BigInt(nonceHex);
      const plan = this.input.returnPlan,
        fee = this.input.plan.sealMaxFeePerGasWei;
      if (
        nonce !== this.sweepNonce ||
        !same(code, plan.recipientCode) ||
        BigInt(block.baseFeePerGas) + this.input.plan.sealPriorityFeePerGasWei >
          fee
      )
        throw new Error(
          "Return snapshot outside reviewed nonce/code/fees; held",
        );
      this.sweepSnapshot = {
        blockNumber: block.number,
        blockHash: block.hash,
        balance,
        nonce,
      };
      const value = balance - plan.sweepGasLimit * fee;
      if (value <= 0n) {
        this.residual = balance;
        return null;
      }
      if (code !== "0x") {
        const estimatedSweepGas = await read.estimateGas({
          from: this.input.account.address,
          to: this.input.operator,
          value,
          data: "0x",
        });
        const simulated = createPatioReturnPlan({
          recipient: this.input.operator,
          recipientSnapshot: snapshotReturnRecipient(code),
          feePlan: this.input.plan,
          estimatedSweepGas,
        });
        if (simulated.sweepGasLimit > plan.sweepGasLimit)
          throw new Error("Return simulation exceeds reviewed gas reserve");
      }
      const [
        current,
        anchored,
        currentCode,
        currentBalance,
        currentNonce,
        chainId,
      ] = await Promise.all([
        read.request<Block>("eth_getBlockByNumber", ["latest", false]),
        read.request<Block | null>("eth_getBlockByNumber", [
          block.number,
          false,
        ]),
        read.code(this.input.operator),
        read.balance(this.input.account.address),
        read.latestTransactionCount(this.input.account.address),
        read.chainId(),
      ]);
      if (
        // A normal new block is not a reorg. Keep the snapshot anchored and
        // recheck the actual nonce/balance/code/fee conditions before signing.
        !anchored ||
        !same(anchored.hash, block.hash) ||
        BigInt(current.baseFeePerGas) +
          this.input.plan.sealPriorityFeePerGasWei >
          fee ||
        !same(currentCode, code) ||
        currentBalance !== balance ||
        currentNonce !== nonce ||
        chainId !== this.input.chainId
      )
        throw new Error(
          "Return snapshot changed before signing; held without automatic retry",
        );
      const raw = await this.sign("sweep", {
        type: "eip1559",
        chainId,
        to: this.input.operator,
        nonce: Number(nonce),
        gas: plan.sweepGasLimit,
        value,
        data: "0x",
        maxFeePerGas: fee,
        maxPriorityFeePerGas: this.input.plan.sealPriorityFeePerGasWei,
      });
      return await this.send(raw);
    } catch (cause) {
      this.held = true;
      throw cause;
    }
  }
  async confirmSweep(attempts = 1, wait = delay): Promise<void> {
    try {
      await this.verifySweep(attempts, wait);
    } catch (cause) {
      this.held = true;
      // Earlier inclusion is not a current confirmation after missing evidence
      // or reorg. The signed hash and sticky media incident remain retained.
      this.returned = null;
      this.residual = null;
      throw cause;
    }
  }
  private async verifySweep(
    attempts: number,
    wait: typeof delay,
  ): Promise<void> {
    const signature = this.signatures.find((item) => item.role === "sweep");
    if (!signature || !this.sweepSnapshot)
      throw new Error("No signed sweep to reconcile");
    const read = this.input.clients.read;
    for (let i = 0; i < attempts; i++) {
      const receipt = await classicCanonicalReceipt(
        read,
        signature.hash,
        this.input.account.address,
        this.sweepNonce,
      );
      if (receipt) {
        await this.reconcile(1, wait, true);
        if (BigInt(receipt.status) !== 1n)
          throw new Error("Sweep reverted; return not confirmed");
        const tx = await read.transaction(signature.hash);
        if (
          !tx ||
          !same(tx.to, this.input.operator) ||
          BigInt(tx.value) !==
            this.sweepSnapshot.balance - signature.gas * signature.maxFee
        )
          throw new Error("Sweep value/recipient mismatch");
        signature.outcome = "included";
        this.receipts.set(signature.hash, receipt);
        this.returned = BigInt(tx.value);
        this.residual = await read.balance(this.input.account.address);
        this.held = false;
        return;
      }
      if (i + 1 < attempts) await wait(2_000);
    }
    this.held = true;
    throw new Error("Sweep pending; do not submit another return");
  }
}
