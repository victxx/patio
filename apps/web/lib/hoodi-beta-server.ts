/** Narrow QuickNode transport for the classic beta. No keys, arbitrary URLs,
 * generic forwarding, server-side signing, automatic retry or provider switch.
 * ClassicSession remains the owner of approval, inventory, freeze and sends.
 * Request-carried public plan metadata avoids process-local Vercel leases. */
import {
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { MEDIA_TRANSACTION_GAS } from "@patio/ethereum";
import { PATIO_DEFAULTS } from "@patio/config";
import { packetFromHex, PatioCodec, PatioPacketType } from "@patio/protocol";
import { createRequiredDirectPlan } from "./direct-plan";
import type { DirectSessionDescriptor } from "./direct-hoodi";
import type { HoodiBetaContext } from "./hoodi-beta";

type Upstream = <T>(method: string, params: unknown[]) => Promise<T>;

/** Only static categories cross the adapter boundary. Never reflect an RPC
 * message: some providers include the signed transaction or credential URL. */
export class HoodiBetaRpcError extends Error {
  constructor(
    readonly category: string,
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

export function classifyBetaRpcError(
  method: string,
  code: number | null,
  message: unknown,
) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  const categories: [RegExp, string, string][] = [
    [
      /(?:^|\W)(?:already known|known transaction)(?:$|\W)/,
      "already-known",
      "Transaction already known.",
    ],
    [
      /nonce too low/,
      "nonce-too-low",
      "Transaction nonce too low; checking its status.",
    ],
    [
      /replacement.*underpriced|fee too low to replace/,
      "replacement-underpriced",
      "The node rejected the replacement fee. Broadcast paused; no resend.",
    ],
    [
      /insufficient funds/,
      "insufficient-funds",
      "The node reports insufficient broadcast funds. No automatic top-up.",
    ],
    [
      /max fee.*base fee|fee cap.*base fee/,
      "fee-below-base",
      "Network fees exceed this broadcast's approved limit.",
    ],
    [
      /rate limit|too many requests|quota/,
      "rate-limit",
      "Hoodi is busy. Checking transaction status without resending.",
    ],
  ];
  const match = categories.find(([pattern]) => pattern.test(text));
  return new HoodiBetaRpcError(
    match?.[1] ?? "rpc-error",
    method,
    code,
    match?.[2] ?? "The Hoodi node rejected this request. Keep this tab open.",
  );
}
const same = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (x: unknown): x is Hex =>
  typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const tag = (x: unknown) =>
  typeof x === "string" &&
  /^(latest|pending|safe|finalized|0x[0-9a-f]+)$/.test(x);
function descriptor(c: HoodiBetaContext): DirectSessionDescriptor {
  const d = c.descriptor;
  if (
    !d ||
    d.chainId !== 560048 ||
    !isAddress(d.sessionAddress) ||
    !isAddress(d.operator) ||
    same(d.sessionAddress, d.operator) ||
    d.nonceStart !== "0" ||
    !/^0x[0-9a-fA-F]{32}$/.test(d.streamId) ||
    d.transportMode === "single-nonce-retirement-v1"
  )
    throw Error("Invalid Hoodi classic session");
  return d;
}
function plan(c: HoodiBetaContext) {
  descriptor(c);
  const p = c.plan;
  if (
    !p ||
    !Number.isInteger(p.duration) ||
    p.duration < 1 ||
    p.duration > 3600 ||
    (p.mediaMode !== undefined && !["audio", "video"].includes(p.mediaMode)) ||
    ![p.base, p.tip, p.funding].every(
      (x) => typeof x === "string" && /^\d{1,20}$/.test(x),
    )
  )
    throw Error("Invalid reviewed plan");
  const value = createRequiredDirectPlan(
    BigInt(p.base),
    BigInt(p.tip),
    p.duration,
    undefined,
    p.mediaMode === "video"
      ? PATIO_DEFAULTS.videoTimesliceMs
      : PATIO_DEFAULTS.chunkDurationMs,
    undefined,
    "classic-per-nonce-v2",
  );
  if (!value || value.requiredFundingWei !== BigInt(p.funding))
    throw Error("Plan outside beta budget");
  return value;
}

export class HoodiBetaAdapter {
  constructor(
    private readonly upstream: Upstream,
    private readonly registryAddress?: string,
  ) {}
  async review(c: HoodiBetaContext) {
    const d = descriptor(c),
      p = plan(c);
    const [chain, balance, nonce, pending, code, operatorCode, block] =
      await Promise.all([
        this.upstream<Hex>("eth_chainId", []),
        this.upstream<Hex>("eth_getBalance", [d.sessionAddress, "latest"]),
        this.upstream<Hex>("eth_getTransactionCount", [
          d.sessionAddress,
          "latest",
        ]),
        this.upstream<Hex>("eth_getTransactionCount", [
          d.sessionAddress,
          "pending",
        ]),
        this.upstream<Hex>("eth_getCode", [d.sessionAddress, "latest"]),
        this.upstream<Hex>("eth_getCode", [d.operator, "latest"]),
        this.upstream<{ baseFeePerGas: Hex }>("eth_getBlockByNumber", [
          "latest",
          false,
        ]),
      ]);
    if (
      BigInt(chain) !== 560048n ||
      BigInt(balance) !== 0n ||
      BigInt(nonce) !== 0n ||
      BigInt(pending) !== 0n ||
      code !== "0x" ||
      operatorCode !== "0x"
    )
      throw Error("Fresh session and plain EOA operator required");
    const fundingMaxFee = 2n * p.feePlan.baseFeePerGasWei + BigInt(c.plan!.tip);
    if (BigInt(block.baseFeePerGas) + BigInt(c.plan!.tip) > fundingMaxFee)
      throw Error("Fees changed beyond reviewed funding cap");
    return { fundingMaxFee: fundingMaxFee.toString(), fundingTip: c.plan!.tip };
  }
  async request(
    method: string,
    params: unknown[],
    c: HoodiBetaContext = {},
  ): Promise<unknown> {
    if (params.length > 2) throw Error("Too many parameters");
    // Public discovery is an ordinary read, not a session operation. Reuse the
    // existing five-block registry pager, restricted to the configured contract.
    if (method === "eth_getLogs") {
      const filter = params[0] as
        | { address?: unknown; fromBlock?: unknown; toBlock?: unknown }
        | undefined;
      if (
        params.length !== 1 ||
        !filter ||
        !this.registryAddress ||
        !isAddress(this.registryAddress) ||
        !same(filter.address, this.registryAddress) ||
        Object.keys(filter).some(
          (key) => !["address", "fromBlock", "toBlock"].includes(key),
        ) ||
        typeof filter.fromBlock !== "string" ||
        !/^0x[0-9a-f]+$/.test(filter.fromBlock) ||
        typeof filter.toBlock !== "string" ||
        !/^0x[0-9a-f]+$/.test(filter.toBlock) ||
        BigInt(filter.toBlock) < BigInt(filter.fromBlock) ||
        BigInt(filter.toBlock) - BigInt(filter.fromBlock) > 4n
      )
        throw Error("Invalid registry log range");
      return this.upstream(method, params);
    }
    if (
      ["eth_chainId", "eth_blockNumber", "eth_maxPriorityFeePerGas"].includes(
        method,
      ) &&
      !params.length
    )
      return this.upstream(method, params);
    if (
      method === "eth_getBlockByNumber" &&
      params.length === 2 &&
      tag(params[0]) &&
      params[1] === false
    )
      return this.upstream(method, params);
    if (
      ["eth_getBalance", "eth_getTransactionCount", "eth_getCode"].includes(
        method,
      ) &&
      params.length === 2 &&
      typeof params[0] === "string" &&
      isAddress(params[0]) &&
      tag(params[1])
    )
      return this.upstream(method, params);
    if (
      ["eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(
        method,
      ) &&
      params.length === 1 &&
      hash(params[0])
    )
      return this.upstream(method, params);
    if (method === "txpool_contentFrom") {
      const d = descriptor(c);
      if (params.length !== 1 || !same(params[0], d.sessionAddress))
        throw Error("Observer is session scoped");
      return this.upstream(method, params);
    }
    if (method !== "eth_sendRawTransaction")
      throw Error("Method not allowed by Hoodi beta");
    const d = descriptor(c),
      p = plan(c),
      f = p.feePlan;
    if (
      params.length !== 1 ||
      typeof params[0] !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(params[0]) ||
      params[0].length > 40000
    )
      throw Error("Invalid or oversized transaction");
    const raw = params[0] as TransactionSerialized,
      tx = parseTransaction(raw);
    if (
      tx.type !== "eip1559" ||
      tx.nonce === undefined ||
      tx.chainId !== 560048 ||
      tx.accessList?.length ||
      !same(
        await recoverTransactionAddress({ serializedTransaction: raw }),
        d.sessionAddress,
      )
    )
      throw Error("Wrong transaction chain, type or signer");
    if (BigInt(await this.upstream<Hex>("eth_chainId", [])) !== 560048n)
      throw Error("Wrong upstream chain");
    if (tx.data && tx.data !== "0x") {
      const packet = packetFromHex(tx.data),
        index = packet.sequence % p.replacementsPerWindow;
      const video = c.plan!.mediaMode === "video";
      if (
        !(video
          ? [PatioCodec.WEBM_VP8_OPUS, PatioCodec.WEBM_VP9_OPUS].includes(
              packet.codec,
            )
          : packet.codec === PatioCodec.OPUS_WEBM) ||
        ![
          PatioPacketType.START,
          video ? PatioPacketType.VIDEO : PatioPacketType.AUDIO,
        ].includes(packet.type) ||
        packet.streamId !== d.streamId ||
        packet.windowIndex >= f.windows ||
        packet.windowIndex !==
          Math.floor(packet.sequence / p.replacementsPerWindow) ||
        tx.nonce !== 1 + packet.windowIndex ||
        !same(tx.to, d.sessionAddress) ||
        (tx.value ?? 0n) !== 0n ||
        tx.gas !== MEDIA_TRANSACTION_GAS ||
        tx.maxFeePerGas !== f.mediaFeeLadderWei[index] ||
        tx.maxPriorityFeePerGas !== f.mediaPriorityFeeLadderWei[index]
      )
        throw Error("Media outside reviewed plan");
    } else {
      if (
        tx.gas !== 21000n ||
        tx.maxFeePerGas !== f.sealMaxFeePerGasWei ||
        tx.maxPriorityFeePerGas !== f.sealPriorityFeePerGasWei
      )
        throw Error("Cleanup outside reviewed fees");
      if (
        same(tx.to, d.sessionAddress) &&
        (tx.value ?? 0n) === 0n &&
        tx.nonce >= 0 &&
        tx.nonce <= f.windows
      ) {
        if (tx.nonce === 0) {
          if (
            c.sealHashes !== undefined &&
            (!Array.isArray(c.sealHashes) ||
              c.sealHashes.length !== f.windows ||
              !c.sealHashes.every(hash))
          )
            throw Error("Invalid seal hash inventory");
          // Cast verifies each seal before advancing/releasing. Requiring all
          // seals to be visible AGAIN in one later service view rejects a valid
          // close before dispatch on balanced RPCs. The stateless adapter still
          // bounds this signed release to the reviewed account/nonce/value/gas/
          // fees. Neither check is a guarantee that media cannot be included.
        }
      } else if (
        same(tx.to, d.operator) &&
        (tx.nonce === 0 || tx.nonce === f.windows + 1)
      ) {
        const [nonce, balance, code] = await Promise.all([
          this.upstream<Hex>("eth_getTransactionCount", [
            d.sessionAddress,
            "latest",
          ]),
          this.upstream<Hex>("eth_getBalance", [d.sessionAddress, "latest"]),
          this.upstream<Hex>("eth_getCode", [d.operator, "latest"]),
        ]);
        if (
          BigInt(nonce) !== BigInt(tx.nonce) ||
          code !== "0x" ||
          !tx.value ||
          tx.value <= 0n ||
          tx.value !== BigInt(balance) - 21000n * f.sealMaxFeePerGasWei
        )
          throw Error("Return differs from reconciled state");
      } else throw Error("Unpermitted destination, value or nonce");
    }
    // Only ClassicSession decides to sign/send. One upstream call, never retry.
    const expected = keccak256(raw);
    const result = await this.upstream<Hex>(method, [raw]);
    if (!same(result, expected))
      throw Error("Send result uncertain; reconcile only");
    return result;
  }
}

export async function boundedJson(input: Request | Response, limit: number) {
  const reader = input.body?.getReader();
  if (!reader) throw Error("Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.length;
      if (size > limit) throw Error("Body exceeds limit");
      chunks.push(p.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
export function quickNodeBetaAdapter() {
  const endpoint = process.env.PATIO_HOODI_QUICKNODE_RPC_URL;
  if (!endpoint) throw Error("QuickNode configuration missing");
  const u = new URL(endpoint);
  if (
    u.protocol !== "https:" ||
    !u.hostname.endsWith(".ethereum-hoodi.quiknode.pro") ||
    u.username ||
    u.password ||
    u.port
  )
    throw Error("Unexpected provider configuration");
  return new HoodiBetaAdapter(
    async <T>(method: string, params: unknown[]): Promise<T> => {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      } catch {
        throw new HoodiBetaRpcError(
          "connection-uncertain",
          method,
          null,
          "Hoodi did not confirm the request. Checking its status without resending.",
        );
      }
      if (!response.ok)
        throw new HoodiBetaRpcError(
          "http-error",
          method,
          response.status,
          response.status === 429
            ? "Hoodi is busy. Checking transaction status without resending."
            : "Unable to connect to Hoodi right now.",
        );
      const result = (await boundedJson(response, 1_000_000)) as {
        result?: T;
        error?: { code?: number; message?: unknown };
      };
      if (result.error || result.result === undefined)
        throw classifyBetaRpcError(
          method,
          typeof result.error?.code === "number" ? result.error.code : null,
          result.error?.message,
        );
      return result.result;
    },
    process.env.NEXT_PUBLIC_HOODI_PATIO_REGISTRY_ADDRESS ??
      process.env.NEXT_PUBLIC_PATIO_REGISTRY_ADDRESS,
  );
}
