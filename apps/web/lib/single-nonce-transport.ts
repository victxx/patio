import { bytesToHex, isAddress, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PatioCodec } from "@patio/protocol";
import { encodePatioPacket, PatioPacketType } from "@patio/protocol";
import {
  buildRetirementCandidate,
  validateRetirementSignatures,
} from "./retirement-candidate";
import {
  affordableSingleNonce,
  RETIREMENT_MODE,
  type SingleNoncePlan,
} from "./single-nonce-plan";
import { RetirementInventory } from "./single-nonce-state";
import type { PrivateRetirementEnvironment } from "./private-retirement-environment";
import {
  assertPrivateEnvironment,
  readCanonicalRetirement,
  type PrivateRetirementRpc,
} from "./private-retirement-environment";
import {
  flattenTxpoolTransactions,
  type DirectSessionDescriptor,
} from "./direct-hoodi";

interface CanonicalReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
}
export interface RetirementEvent {
  stage: string;
  role?: string;
  hash?: Hex;
  nonce?: string;
  sequence?: number;
  replacementIndex?: number;
  bytes?: number;
  outcome?: string;
  status?: string;
  errorClass?: string;
  atMonotonicMs: number;
}
export interface PrivateSessionOptions {
  operator: Address;
  candidates: number;
  budget?: bigint;
  packetDurationMs?: 1500 | 3000;
  onEvent?: (event: RetirementEvent) => void;
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Owns a newly generated key exclusively. No key/raw transaction accessor, no
 * generic signer, legacy artifact, fee escalation or send retry. Private only. */
export class SingleNonceTransport {
  readonly mode = RETIREMENT_MODE;
  readonly descriptor: Readonly<DirectSessionDescriptor>;
  readonly plan: SingleNoncePlan;
  #account: ReturnType<typeof privateKeyToAccount>;
  #inventory: RetirementInventory;
  #events: RetirementEvent[] = [];
  #onEvent?: PrivateSessionOptions["onEvent"];
  #queue: Promise<unknown> = Promise.resolve();
  #stopping = false;
  #stopPromise?: Promise<void>;
  #fundAttempted = false;
  #funded = false;
  #closeHash?: Hex;
  #sweepHash?: Hex;
  #receipts: CanonicalReceipt[] = [];

  private constructor(
    readonly environment: PrivateRetirementEnvironment,
    plan: SingleNoncePlan,
    options: PrivateSessionOptions,
    account: ReturnType<typeof privateKeyToAccount>,
    gap: number,
  ) {
    this.#account = account;
    this.plan = plan;
    this.#onEvent = options.onEvent;
    this.#inventory = new RetirementInventory(gap, plan.candidates);
    this.descriptor = Object.freeze({
      version: 1,
      chainId: 1337,
      operator: options.operator,
      sessionAddress: this.#account.address,
      streamId: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      nonceStart: String(gap),
      transportMode: RETIREMENT_MODE,
    });
  }
  static async prepare(
    environment: PrivateRetirementEnvironment,
    options: PrivateSessionOptions,
  ) {
    assertPrivateEnvironment(environment);
    await environment.revalidate();
    if (!isAddress(options.operator))
      throw new Error("Original private operator required");
    const [block, tip, code] = await Promise.all([
      environment.close.request<{ baseFeePerGas: Hex }>(
        "eth_getBlockByNumber",
        ["latest", false],
      ),
      environment.close.request<Hex>("eth_maxPriorityFeePerGas"),
      environment.observer.request<Hex>("eth_getCode", [
        options.operator,
        "latest",
      ]),
    ]);
    if (code !== "0x")
      throw new Error(
        "Private retirement return path requires a plain operator EOA",
      );
    const plan = affordableSingleNonce({
      baseFee: BigInt(block.baseFeePerGas),
      priorityFee: BigInt(tip),
      candidates: options.candidates,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.packetDurationMs === undefined
        ? {}
        : { packetDurationMs: options.packetDurationMs }),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const gap = BigInt(
      await environment.observer.request<Hex>("eth_getTransactionCount", [
        account.address,
        "latest",
      ]),
    );
    if (gap < 0n || gap > BigInt(Number.MAX_SAFE_INTEGER - 2))
      throw new Error("Canonical nonce out of supported bounds");
    const session = new SingleNonceTransport(
      environment,
      plan,
      options,
      account,
      Number(gap),
    );
    await session.assertGap();
    return session;
  }
  snapshot() {
    return {
      mode: this.mode,
      descriptor: { ...this.descriptor },
      ...this.#inventory.snapshot(),
      funded: this.#funded,
      fundingAttempted: this.#fundAttempted,
      closeHash: this.#closeHash,
      sweepHash: this.#sweepHash,
      plan: {
        capacity: this.plan.candidates,
        mediaFees: this.plan.mediaFees.map(String),
        mediaTips: this.plan.mediaTips.map(String),
        requiredExposure: String(this.plan.requiredExposure),
        closeReserve: String(this.plan.closeReserve),
        sweepReserve: String(this.plan.sweepReserve),
        estimatedDurationSeconds: this.plan.estimatedDurationSeconds,
      },
      receipts: this.#receipts.map((r) => ({ ...r })),
      events: this.#events.map((e) => ({ ...e })),
    };
  }
  private event(event: Omit<RetirementEvent, "atMonotonicMs">) {
    const item = Object.freeze({ ...event, atMonotonicMs: performance.now() });
    this.#events.push(item);
    if (this.#events.length > 128) this.#events.shift();
    try {
      this.#onEvent?.(item);
    } catch {
      /* Metrics cannot control transport. */
    }
  }
  private async assertGap() {
    for (const rpc of [
      this.environment.media,
      this.environment.close,
      this.environment.observer,
    ]) {
      const [nonce, code] = await Promise.all([
        rpc.request<Hex>("eth_getTransactionCount", [
          this.#account.address,
          "latest",
        ]),
        rpc.request<Hex>("eth_getCode", [this.#account.address, "latest"]),
      ]);
      if (BigInt(nonce) !== BigInt(this.#inventory.g) || code !== "0x")
        throw new Error("Gap/code changed; session held");
    }
  }
  /** Trusted fixture funding callback only. One attempt, no wallet or fallback.
   * Retain this object if funding becomes uncertain; never regenerate a key to retry. */
  async fund(funder: (address: Address, value: bigint) => Promise<void>) {
    if (this.#fundAttempted)
      throw new Error("Funding already attempted; reconcile only");
    if (this.#inventory.state !== "prepared" || this.#stopping)
      throw new Error("Funding requires an unfrozen prepared session");
    await this.environment.revalidate();
    await this.assertGap();
    const quoteBlock = await this.environment.close.request<{
      baseFeePerGas: Hex;
    }>("eth_getBlockByNumber", ["latest", false]);
    if (
      BigInt(quoteBlock.baseFeePerGas) >
      (this.plan.closeFee - this.plan.closeTip) / 2n
    )
      throw new Error(
        "Fees increased before funding; explicit new review required",
      );
    // Recheck after asynchronous validation: two concurrent clicks may have
    // started validation, but only one may enter the funding callback.
    if (
      this.#fundAttempted ||
      this.#inventory.state !== "prepared" ||
      this.#stopping
    )
      throw new Error("Funding attempt no longer eligible; no duplicate send");
    this.#fundAttempted = true;
    await funder(this.#account.address, this.plan.requiredExposure);
    await this.confirmFunding();
  }
  async confirmFunding() {
    if (!this.#fundAttempted) throw new Error("No funding attempt");
    await this.environment.revalidate();
    await this.assertGap();
    for (const rpc of [
      this.environment.media,
      this.environment.close,
      this.environment.observer,
    ]) {
      if (
        BigInt(
          await rpc.request<Hex>("eth_getBalance", [
            this.#account.address,
            "latest",
          ]),
        ) < this.plan.requiredExposure
      )
        throw new Error("Canonical funding not yet verified");
    }
    this.#funded = true;
  }
  start() {
    if (!this.#funded || this.#stopping)
      throw new Error("Session is not funded or is frozen");
    this.#inventory.transition("broadcasting");
  }
  sendMedia(
    payload: Uint8Array,
    type: PatioPacketType,
    codec: PatioCodec,
    capturedAtMs: bigint,
  ): Promise<Hex> {
    if (this.#stopping || this.#inventory.state !== "broadcasting")
      return Promise.reject(
        new Error("Media permanently frozen or not started"),
      );
    // Retained only for this serialized send, never for diagnostics/history.
    const result = this.#queue.then(() =>
      this.sendMediaSerial(payload, type, codec, capturedAtMs),
    );
    this.#queue = result.catch(() => undefined);
    return result;
  }
  private async sendMediaSerial(
    payload: Uint8Array,
    type: PatioPacketType,
    codec: PatioCodec,
    capturedAtMs: bigint,
  ) {
    const index = this.#inventory.mediaCount;
    this.#inventory.assertIntent("media", this.#inventory.m, index);
    if (
      payload.length > 8192 ||
      ![
        PatioPacketType.START,
        PatioPacketType.AUDIO,
        PatioPacketType.VIDEO,
      ].includes(type)
    )
      throw new Error("Invalid media packet");
    try {
      await this.environment.revalidate();
      await this.assertGap();
      const currentBlock = await this.environment.media.request<{
        baseFeePerGas: Hex;
      }>("eth_getBlockByNumber", ["latest", false]);
      if (
        BigInt(currentBlock.baseFeePerGas) + this.plan.mediaTips[index]! >
        this.plan.mediaFees[index]!
      )
        throw new Error(
          "Planned media fee no longer sufficient; freeze without escalation",
        );
      const data = bytesToHex(
        encodePatioPacket({
          version: 1,
          type,
          codec,
          flags: 0,
          streamId: this.descriptor.streamId,
          windowIndex: 0,
          sequence: index,
          capturedAtMs,
          payload,
        }),
      );
      // Signing boundary: state/index checked again after all asynchronous reads.
      this.#inventory.assertIntent("media", this.#inventory.m, index);
      const maxFeePerGas = this.plan.mediaFees[index]!;
      const maxPriorityFeePerGas = this.plan.mediaTips[index]!;
      const raw = await this.#account.signTransaction({
        type: "eip1559",
        chainId: 1337,
        to: this.#account.address,
        nonce: this.#inventory.m,
        value: 0n,
        data,
        gas: this.plan.mediaGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const hash = keccak256(raw);
      this.#inventory.record({
        role: "media",
        hash,
        nonce: this.#inventory.m,
        index,
        maxFee: String(maxFeePerGas),
        tip: String(maxPriorityFeePerGas),
      });
      this.event({
        stage: "send-attempt",
        role: "media",
        hash,
        nonce: String(this.#inventory.m),
        sequence: index,
        replacementIndex: index,
        bytes: (data.length - 2) / 2,
      });
      await this.submit(this.environment.media, raw, hash, "media");
      await this.observe(hash);
      this.event({ stage: "observed", role: "media", hash, sequence: index });
      if (this.#inventory.mediaCount === this.plan.candidates)
        this.freeze("capacity");
      return hash;
    } catch (error) {
      this.freeze("media-error-or-uncertain");
      throw error;
    }
  }
  private freeze(reason: string) {
    this.#inventory.freeze();
    this.event({ stage: "media-frozen", status: reason });
  }
  private async submit(
    rpc: PrivateRetirementRpc,
    raw: Hex,
    expected: Hex,
    role: string,
  ) {
    try {
      const returned = await rpc.request<Hex>("eth_sendRawTransaction", [raw]);
      if (returned !== expected) throw new Error("Unexpected RPC hash");
      this.event({
        stage: "rpc-response",
        role,
        hash: expected,
        outcome: "hash-returned-not-inclusion",
      });
    } catch {
      this.event({
        stage: "rpc-response",
        role,
        hash: expected,
        outcome: "uncertain",
        errorClass: "submission-uncertain",
      });
      throw new Error(`${role} submission uncertain; no automatic retry`);
    }
  }
  private async observe(hash: Hex) {
    for (let i = 0; i < 80; i++) {
      const pool =
        await this.environment.observer.request<unknown>("txpool_content");
      if (
        flattenTxpoolTransactions(pool).some(
          (tx) =>
            tx.hash === hash &&
            tx.from.toLowerCase() === this.#account.address.toLowerCase(),
        )
      )
        return;
      await delay(250);
    }
    throw new Error("Exact candidate not observed; no retry");
  }
  private async receipt(hash: Hex): Promise<CanonicalReceipt | null> {
    const receipt =
      await this.environment.observer.request<CanonicalReceipt | null>(
        "eth_getTransactionReceipt",
        [hash],
      );
    if (!receipt) return null;
    const block = await this.environment.observer.request<{
      hash: Hex;
      transactions: Hex[];
    }>("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (
      receipt.transactionHash !== hash ||
      block.hash !== receipt.blockHash ||
      !block.transactions.includes(hash)
    )
      throw new Error("Noncanonical or inconsistent receipt");
    return {
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
    };
  }
  private async checkMedia() {
    for (const entry of this.#inventory
      .snapshot()
      .signatures.filter((r) => r.role === "media")) {
      if (await this.receipt(entry.hash)) {
        this.#inventory.safetyFailure();
        this.event({
          stage: "safety-failed",
          role: "media",
          hash: entry.hash,
          status: "canonical-media-inclusion",
        });
        throw new Error(
          "Canonical media inclusion: permanent safety failure, including reverted media",
        );
      }
    }
  }
  private async waitReceipt(hash: Hex) {
    for (let i = 0; i < 80; i++) {
      const receipt = await this.receipt(hash);
      if (receipt) return receipt;
      const nonce = BigInt(
        await this.environment.observer.request<Hex>(
          "eth_getTransactionCount",
          [this.#account.address, "latest"],
        ),
      );
      if (hash === this.#closeHash && nonce > BigInt(this.#inventory.g)) {
        await this.checkMedia();
        throw new Error("Nonce consumed without exact close receipt; held");
      }
      await delay(250);
    }
    throw new Error("Receipt unknown after bounded wait");
  }
  /** Call only after recorder final-data and its media queue have settled. */
  stop(): Promise<void> {
    this.#stopping = true;
    this.#stopPromise ??= this.#queue.then(() => this.closeAndSweep());
    return this.#stopPromise;
  }
  private async closeAndSweep() {
    this.freeze("stop");
    try {
      await this.environment.revalidate();
      await this.assertGap();
      await this.checkMedia();
      const closeBlock = await this.environment.close.request<{
        baseFeePerGas: Hex;
      }>("eth_getBlockByNumber", ["latest", false]);
      if (
        BigInt(closeBlock.baseFeePerGas) + this.plan.closeTip >
        this.plan.closeFee
      )
        throw new Error(
          "Planned close fee no longer sufficient; hold without ordinary release",
        );
      const balance = BigInt(
        await this.environment.close.request<Hex>("eth_getBalance", [
          this.#account.address,
          "latest",
        ]),
      );
      this.#inventory.assertIntent("retirement-close", this.#inventory.g);
      // With no media signed, the authorized architecture is still exactly m; it
      // retires that permitted nonce rather than inventing an ordinary refund at g.
      const candidate = buildRetirementCandidate({
        session: this.#account.address,
        chainId: 1337,
        gap: this.#inventory.g,
        highestMediaNonce: this.#inventory.m,
        code: "0x",
        balance,
        maxFeePerGas: this.plan.closeFee,
        maxPriorityFeePerGas: this.plan.closeTip,
        inventory: {
          freshExclusiveLocalKey: true,
          frozen: true,
          ordinaryNonces: [],
          authorityNonces: [],
          mediaNonces: [this.#inventory.m],
        },
      });
      if (candidate.authorizationRequests.length !== 1)
        throw new Error("Exactly one retirement authorization required");
      const authorization = await this.#account.signAuthorization(
        candidate.authorizationRequests[0]!,
      );
      await validateRetirementSignatures(candidate, [authorization]);
      this.#inventory.assertIntent("retirement-close", this.#inventory.g);
      const {
        authorizationRequests: _requests,
        expectedNonce: _expected,
        sweepReserve: _reserve,
        ...outer
      } = candidate;
      const raw = await this.#account.signTransaction({
        ...outer,
        authorizationList: [authorization],
      });
      this.#closeHash = keccak256(raw);
      this.#inventory.record({
        role: "retirement-close",
        hash: this.#closeHash,
        nonce: this.#inventory.g,
        maxFee: String(this.plan.closeFee),
        tip: String(this.plan.closeTip),
      });
      this.#inventory.transition("close-submitting");
      await this.submit(
        this.environment.close,
        raw,
        this.#closeHash,
        "retirement-close",
      );
      this.#inventory.transition("close-pending");
      await this.observe(this.#closeHash);
      this.event({
        stage: "observed",
        role: "retirement-close",
        hash: this.#closeHash,
      });
      await this.waitReceipt(this.#closeHash);
      await this.verifyClose();
    } catch (error) {
      const state = this.#inventory.state;
      if (state === "media-frozen")
        this.#inventory.transition("held-before-close");
      else if (state === "close-submitting" || state === "close-pending")
        this.#inventory.transition("held-close-uncertain");
      this.event({
        stage: this.#inventory.state,
        errorClass: "retirement-unverified",
      });
      throw error;
    }
    await this.sweepOnce();
  }
  private async verifyClose() {
    if (!this.#closeHash) throw new Error("Close not signed");
    await this.checkMedia();
    const receipt = await this.receipt(this.#closeHash);
    if (!receipt || receipt.status !== "0x1")
      throw new Error("Close not canonically successful");
    const state = await readCanonicalRetirement(
      this.environment,
      this.#account.address,
      this.#inventory.s,
    );
    const closeStateNonce = await this.environment.observer.request<Hex>(
      "eth_getTransactionCount",
      [this.#account.address, receipt.blockNumber],
    );
    const closeStateCode = await this.environment.observer.request<Hex>(
      "eth_getCode",
      [this.#account.address, receipt.blockNumber],
    );
    if (
      !state.retired ||
      BigInt(closeStateNonce) !== BigInt(this.#inventory.s) ||
      closeStateCode !== "0x"
    )
      throw new Error("Expected retirement transition/code absent");
    if (
      !this.#receipts.some((r) => r.transactionHash === receipt.transactionHash)
    )
      this.#receipts.push(receipt);
    if (
      this.#inventory.state === "close-pending" ||
      this.#inventory.state === "held-close-uncertain"
    )
      this.#inventory.transition("close-included");
    this.event({
      stage: "close-included",
      role: "retirement-close",
      hash: this.#closeHash,
      nonce: String(state.nonce),
      status: "empty-code-canonical",
    });
  }
  private async sweepOnce() {
    try {
      await this.environment.revalidate();
      await this.verifyClose();
      const [nonce, code, balance] = await Promise.all([
        this.environment.observer.request<Hex>("eth_getTransactionCount", [
          this.#account.address,
          "latest",
        ]),
        this.environment.observer.request<Hex>("eth_getCode", [
          this.descriptor.operator,
          "latest",
        ]),
        this.environment.observer.request<Hex>("eth_getBalance", [
          this.#account.address,
          "latest",
        ]),
      ]);
      if (
        BigInt(nonce) !== BigInt(this.#inventory.s) ||
        code !== "0x" ||
        BigInt(balance) <= this.plan.sweepReserve
      )
        throw new Error("Sweep nonce, recipient code or reserve changed");
      this.#inventory.assertIntent("sweep", this.#inventory.s);
      const raw = await this.#account.signTransaction({
        type: "eip1559",
        chainId: 1337,
        nonce: this.#inventory.s,
        to: this.descriptor.operator,
        value: BigInt(balance) - this.plan.sweepReserve,
        data: "0x",
        gas: this.plan.sweepGas,
        maxFeePerGas: this.plan.closeFee,
        maxPriorityFeePerGas: this.plan.closeTip,
      });
      this.#sweepHash = keccak256(raw);
      this.#inventory.record({
        role: "sweep",
        nonce: this.#inventory.s,
        hash: this.#sweepHash,
        maxFee: String(this.plan.closeFee),
        tip: String(this.plan.closeTip),
      });
      this.#inventory.transition("sweep-submitting");
      await this.submit(this.environment.close, raw, this.#sweepHash, "sweep");
      const receipt = await this.waitReceipt(this.#sweepHash);
      await this.checkMedia();
      if (receipt.status !== "0x1") throw new Error("Sweep reverted");
      this.#receipts.push(receipt);
      this.#inventory.transition("complete");
      this.event({ stage: "complete", role: "sweep", hash: this.#sweepHash });
    } catch (error) {
      if (this.#inventory.state === "close-included")
        this.#inventory.transition("held-after-close");
      else if (this.#inventory.state === "sweep-submitting")
        this.#inventory.transition("sweep-pending");
      this.event({
        stage: this.#inventory.state,
        errorClass: "sweep-unverified",
      });
      throw error;
    }
  }
  /** Explicit read-only reconciliation. It NEVER signs or resubmits, including a sweep. */
  async reconcile() {
    await this.environment.revalidate();
    await this.checkMedia();
    if (this.#closeHash) {
      try {
        await this.verifyClose();
      } catch (error) {
        this.#inventory.invalidateCanonicalEvidence();
        this.#receipts = [];
        this.event({
          stage: "held-close-uncertain",
          errorClass: "canonical-evidence-invalidated",
        });
        throw error;
      }
    }
    if (this.#sweepHash && this.#inventory.state === "sweep-pending") {
      const receipt = await this.receipt(this.#sweepHash);
      if (receipt) {
        this.#receipts.push(receipt);
        this.#inventory.transition(
          receipt.status === "0x1" ? "complete" : "held-after-close",
        );
      }
    }
    return this.snapshot();
  }
}
