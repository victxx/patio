/** R1 experiment only. No production imports/callers, signing or pool access. */
import {
  decodePatioPacket,
  PatioCodec,
  PatioPacketType,
} from "@patio/protocol";
import {
  hexToBytes,
  isAddress,
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";

export interface Hint {
  version: 1;
  chainId: number;
  sessionAddress: Address;
  streamId: Hex;
  sequence: number;
  transactionHash: Hex;
}
export interface Context {
  chainId: number;
  sessionAddress: Address;
  streamId: Hex;
  nonce: number;
  capacity: number;
}
const hashPattern = /^0x[\da-f]{64}$/i;
export function metadataHint(value: unknown, context: Context): Hint {
  if (!value || typeof value !== "object") throw new Error("Invalid hint");
  const h = value as Hint;
  if (
    Object.keys(h).sort().join() !==
      "chainId,sequence,sessionAddress,streamId,transactionHash,version" ||
    h.version !== 1 ||
    h.chainId !== context.chainId ||
    !isAddress(h.sessionAddress) ||
    h.sessionAddress.toLowerCase() !== context.sessionAddress.toLowerCase() ||
    h.streamId !== context.streamId ||
    !Number.isInteger(h.sequence) ||
    h.sequence < 0 ||
    h.sequence >= context.capacity ||
    !hashPattern.test(h.transactionHash)
  )
    throw new Error("Untrusted hint identity");
  return Object.freeze({
    version: 1,
    chainId: h.chainId,
    sessionAddress: h.sessionAddress,
    streamId: h.streamId,
    sequence: h.sequence,
    transactionHash: h.transactionHash,
  });
}
export async function validateTransaction(
  value: unknown,
  hint: Hint,
  context: Context,
) {
  if (
    !value ||
    typeof value !== "object" ||
    JSON.stringify(value).length > 24000
  )
    throw new Error("Invalid transaction response");
  const t = value as Record<string, unknown>;
  const quantity = (key: string) => {
    const v = t[key];
    if (
      typeof v !== "string" ||
      !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) ||
      v.length > 66
    )
      throw new Error("Invalid quantity");
    return BigInt(v);
  };
  if (
    t.hash !== hint.transactionHash ||
    quantity("type") !== 2n ||
    quantity("chainId") !== BigInt(context.chainId) ||
    quantity("nonce") !== BigInt(context.nonce) ||
    quantity("value") !== 0n ||
    typeof t.from !== "string" ||
    t.from.toLowerCase() !== context.sessionAddress.toLowerCase() ||
    typeof t.to !== "string" ||
    t.to.toLowerCase() !== context.sessionAddress.toLowerCase() ||
    t.blockHash !== null ||
    t.blockNumber !== null ||
    t.transactionIndex !== null ||
    !Array.isArray(t.accessList) ||
    t.accessList.length !== 0 ||
    typeof t.input !== "string" ||
    !/^0x(?:[0-9a-f]{2})+$/i.test(t.input) ||
    t.input.length > 17000 ||
    typeof t.r !== "string" ||
    typeof t.s !== "string" ||
    !hashPattern.test(t.r) ||
    !hashPattern.test(t.s)
  )
    throw new Error("Transaction identity/context mismatch");
  const parity = quantity("yParity");
  if (parity > 1n) throw new Error("Invalid signature parity");
  const raw = serializeTransaction(
    {
      type: "eip1559",
      chainId: context.chainId,
      nonce: context.nonce,
      to: context.sessionAddress,
      value: 0n,
      data: t.input as Hex,
      gas: quantity("gas"),
      maxFeePerGas: quantity("maxFeePerGas"),
      maxPriorityFeePerGas: quantity("maxPriorityFeePerGas"),
      accessList: [],
    },
    { r: t.r as Hex, s: t.s as Hex, yParity: Number(parity) },
  );
  if (
    keccak256(raw) !== hint.transactionHash ||
    (
      await recoverTransactionAddress({ serializedTransaction: raw })
    ).toLowerCase() !== context.sessionAddress.toLowerCase()
  )
    throw new Error("Hash/signature mismatch");
  const packet = decodePatioPacket(hexToBytes(t.input as Hex));
  if (
    packet.streamId !== context.streamId ||
    packet.sequence !== hint.sequence ||
    packet.windowIndex !== 0 ||
    packet.codec !== PatioCodec.OPUS_WEBM ||
    (packet.type !== PatioPacketType.START &&
      packet.type !== PatioPacketType.AUDIO)
  )
    throw new Error("Packet identity mismatch");
  return {
    packet,
    bytes: (t.input.length - 2) / 2,
    digest: keccak256(t.input as Hex),
  };
}

/** Narrow injected read interface; implementations only issue eth_getTransactionByHash. */
export type HashRead = (hash: Hex, signal: AbortSignal) => Promise<unknown>;
export class HashReceiver {
  #seen = new Map<string, Promise<unknown>>();
  #active = 0;
  #abort = new AbortController();
  readonly metrics: {
    hash: Hex;
    sequence: number;
    attempts: number;
    nulls: number;
    responseBytes: number;
    elapsedMs: number;
    outcome: string;
  }[] = [];
  constructor(
    readonly context: Context,
    private readonly read: HashRead,
    readonly attempts = 8,
    readonly intervalMs = 200,
  ) {
    if (
      context.capacity < 1 ||
      context.capacity > 20 ||
      attempts < 1 ||
      attempts > 12 ||
      intervalMs < 0 ||
      intervalMs > 500
    )
      throw new Error("Invalid receiver bounds");
  }
  stop() {
    this.#abort.abort();
  }
  receive(value: unknown): Promise<unknown> {
    const hint = metadataHint(value, this.context);
    const key = `${hint.sequence}:${hint.transactionHash}`;
    const prior = this.#seen.get(key);
    if (prior) return prior;
    if (
      this.#abort.signal.aborted ||
      this.#active >= 2 ||
      this.#seen.size >= 32
    )
      return Promise.resolve({ outcome: "bounded-or-stopped" });
    this.#active++;
    const task = this.lookup(hint).finally(() => {
      this.#active--;
    });
    this.#seen.set(key, task);
    // Promises retain only metadata: validated payload is never retained by the receiver.
    return task;
  }
  private async lookup(hint: Hint) {
    const start = performance.now();
    const m = {
      hash: hint.transactionHash,
      sequence: hint.sequence,
      attempts: 0,
      nulls: 0,
      responseBytes: 0,
      elapsedMs: 0,
      outcome: "unavailable-not-dropped",
    };
    try {
      for (let i = 0; i < this.attempts && !this.#abort.signal.aborted; i++) {
        m.attempts++;
        const signal = AbortSignal.any([
          this.#abort.signal,
          AbortSignal.timeout(1000),
        ]);
        const response = await new Promise<unknown>((resolve, reject) => {
          const abort = () => reject(new Error("Read aborted"));
          signal.addEventListener("abort", abort, { once: true });
          this.read(hint.transactionHash, signal)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        });
        if (this.#abort.signal.aborted) break;
        m.responseBytes += JSON.stringify(response).length;
        if (response === null) m.nulls++;
        else {
          const valid = await validateTransaction(response, hint, this.context);
          if (this.#abort.signal.aborted) break;
          m.outcome = "validated-unincluded";
          return {
            outcome: m.outcome,
            bytes: valid.bytes,
            digest: valid.digest,
          };
        }
        if (i + 1 < this.attempts)
          await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
      }
      return { outcome: m.outcome };
    } catch {
      m.outcome = this.#abort.signal.aborted
        ? "stopped"
        : "invalid-or-read-failure";
      return { outcome: m.outcome };
    } finally {
      m.elapsedMs = performance.now() - start;
      this.metrics.push(m);
    }
  }
}

/** LOCAL metadata bus, not a deployed signalling service. Rejects payload-bearing extras. */
export function deliverHint(receiver: HashReceiver, value: unknown) {
  return receiver.receive(metadataHint(value, receiver.context));
}
