/** Isolated local app only. Imported by a GENERATED route, never public app/api.
 * No private keys. A single immutable reviewed classic plan, no generic proxy. */
import {
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { randomUUID } from "node:crypto";
import { PATIO_NETWORK_PROFILES } from "@patio/config";
import { MEDIA_TRANSACTION_GAS } from "@patio/ethereum";
import { packetFromHex, PatioCodec, PatioPacketType } from "@patio/protocol";
import {
  createRequiredDirectPlan,
  type DirectFeePlan,
} from "../../lib/direct-plan";
import {
  flattenTxpoolTransactions,
  type DirectSessionDescriptor,
} from "../../lib/direct-hoodi";

const CHAIN = 560048;
const OPERATOR = "0xca490deA7D7D79Bac4537D5Fe68fF10cd9c7EbEd";
const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
type ReviewInput = {
  descriptor: DirectSessionDescriptor;
  duration: number;
  base: string;
  tip: string;
  funding: string;
};
type Block = { number: Hex; hash: Hex; baseFeePerGas: Hex };
type Tx = { from: string; to: string; value: Hex; input: Hex; hash: Hex };
class ReservationConflict extends Error {
  constructor() {
    super("One new account only");
  }
}
// Never reflect upstream messages, parameters, URLs or signed bytes to the UI.
export function controlledAudioFailure(cause: unknown) {
  if (cause instanceof ReservationConflict)
    return {
      code: "SESSION_ALREADY_RESERVED",
      operation: "reserve",
      upstreamDispatch: false,
      message:
        "Local session reservation already exists. This reserve request did not reach QuickNode or send a transaction. Preserve the existing tab; do not prepare another account.",
    };
  return {
    code: "CONTROLLED_OPERATION_UNCLASSIFIED",
    upstreamDispatch: "unknown",
    message:
      "Controlled QuickNode operation blocked or unavailable; no fallback/retry. Preserve this session.",
  };
}
export class QuickNodeAudioAdapter {
  private reserved?: string;
  private session?: {
    id: string;
    descriptor: DirectSessionDescriptor;
    plan: DirectFeePlan;
    approved: boolean;
    frozen: boolean;
    nextMedia: number;
    slots: Set<string>;
    hashes: Map<Hex, { role: string; nonce: number }>;
    observedSeals: Set<Hex>;
  };
  private busy = false;
  private inFlight = 0;
  private total = 0;
  constructor(
    private readonly upstream: <T>(
      method: string,
      params: unknown[],
    ) => Promise<T>,
  ) {}
  async action(action: string, body: Record<string, unknown>) {
    if (action === "reserve") {
      if (this.reserved) throw new ReservationConflict();
      if (
        typeof body.address !== "string" ||
        !isAddress(body.address) ||
        same(body.address, OPERATOR)
      )
        throw Error("One new account only");
      this.reserved = body.address;
      return { reserved: true };
    }
    if (action === "status")
      return {
        chainId: CHAIN,
        provider: "quicknode",
        sameService: true,
        session: this.session?.descriptor.sessionAddress ?? null,
        reservedAddress: this.reserved ?? null,
        approved: this.session?.approved ?? false,
        operationInProgress: this.busy,
        rpcInFlight: this.inFlight,
        // Server knows attempted sends, not unsubmitted browser signatures.
        sendInventory: [...(this.session?.hashes.entries() ?? [])].map(
          ([hash, value]) => ({ hash, role: value.role, nonce: value.nonce }),
        ),
      };
    if (action === "review") {
      if (this.session || this.busy)
        throw Error("A session is already retained; no second trial");
      this.busy = true;
      try {
        const x = body as unknown as ReviewInput;
        if (
          !x.descriptor ||
          !same(x.descriptor.sessionAddress, this.reserved ?? "") ||
          !same(x.descriptor.operator, OPERATOR) ||
          x.descriptor.chainId !== CHAIN ||
          x.descriptor.nonceStart !== "0" ||
          !/^0x[0-9a-fA-F]{32}$/.test(x.descriptor.streamId) ||
          x.duration < 1 ||
          x.duration > 15
        )
          throw Error("Review outside permitted scope");
        const plan = createRequiredDirectPlan(
          BigInt(x.base),
          BigInt(x.tip),
          x.duration,
          undefined,
          3000,
          PATIO_NETWORK_PROFILES.hoodi,
          "classic-per-nonce-v2",
        );
        if (
          !plan ||
          plan.feePlan.windows !== 1 ||
          plan.replacementsPerWindow > 5 ||
          plan.requiredFundingWei !== BigInt(x.funding)
        )
          throw Error("Plan differs from B2 or exceeds trial bounds");
        const [chain, nonce, pending, code, recipientCode, balance, block] =
          await Promise.all([
            this.upstream<Hex>("eth_chainId", []),
            this.upstream<Hex>("eth_getTransactionCount", [
              x.descriptor.sessionAddress,
              "latest",
            ]),
            this.upstream<Hex>("eth_getTransactionCount", [
              x.descriptor.sessionAddress,
              "pending",
            ]),
            this.upstream<Hex>("eth_getCode", [
              x.descriptor.sessionAddress,
              "latest",
            ]),
            this.upstream<Hex>("eth_getCode", [OPERATOR, "latest"]),
            this.upstream<Hex>("eth_getBalance", [
              x.descriptor.sessionAddress,
              "latest",
            ]),
            this.upstream<Block>("eth_getBlockByNumber", ["latest", false]),
          ]);
        if (
          Number(BigInt(chain)) !== CHAIN ||
          BigInt(nonce) ||
          BigInt(pending) ||
          code !== "0x" ||
          recipientCode !== "0x" ||
          BigInt(balance) ||
          BigInt(block.baseFeePerGas) > BigInt(x.base)
        )
          throw Error(
            "Fresh account, EOA operator or reviewed fee state changed",
          );
        this.session = {
          id: randomUUID(),
          descriptor: x.descriptor,
          plan,
          approved: false,
          frozen: false,
          nextMedia: 0,
          slots: new Set(),
          hashes: new Map(),
          observedSeals: new Set(),
        };
        return {
          id: this.session.id,
          fundingMaxFee: (2n * BigInt(x.base) + BigInt(x.tip)).toString(),
          fundingTip: x.tip,
        };
      } finally {
        this.busy = false;
      }
    }
    const s = this.session;
    if (!s || body.id !== s.id) throw Error("Exact retained review required");
    if (action === "approve") {
      if (s.approved) throw Error("Review already approved");
      s.approved = true;
      return { approved: true };
    }
    if (action === "freeze") {
      s.frozen = true;
      return { frozen: true };
    }
    throw Error("Operation not available");
  }
  async rpc(method: string, params: unknown[]) {
    if (++this.total > 12_000 || this.inFlight >= 8 || params.length > 2)
      throw Error("Bounded test read quota exceeded");
    this.inFlight++;
    try {
      const s = this.session;
      if (method === "eth_sendRawTransaction") return await this.send(params);
      if (
        ["eth_chainId", "eth_blockNumber", "eth_maxPriorityFeePerGas"].includes(
          method,
        ) &&
        !params.length
      )
        return await this.upstream(method, params);
      if (
        method === "eth_getBlockByNumber" &&
        params[1] === false &&
        typeof params[0] === "string" &&
        /^(latest|safe|finalized|0x[0-9a-f]+)$/.test(params[0])
      )
        return await this.upstream(method, params);
      if (
        ["eth_getBalance", "eth_getCode", "eth_getTransactionCount"].includes(
          method,
        ) &&
        (same(params[0], OPERATOR) || same(params[0], this.reserved ?? "")) &&
        typeof params[1] === "string" &&
        /^(latest|pending|0x[0-9a-f]+)$/.test(params[1])
      )
        return await this.upstream(method, params);
      if (
        method === "txpool_contentFrom" &&
        s &&
        params.length === 1 &&
        same(params[0], s.descriptor.sessionAddress)
      ) {
        const pool = await this.upstream(method, params);
        for (const tx of flattenTxpoolTransactions(pool))
          if (s.hashes.get(tx.hash)?.role === "seal")
            s.observedSeals.add(tx.hash);
        return pool;
      }
      if (
        ["eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(
          method,
        ) &&
        s &&
        params.length === 1 &&
        typeof params[0] === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(params[0])
      ) {
        const hash = params[0] as Hex;
        if (!s.hashes.has(hash)) {
          const tx = await this.upstream<Tx | null>(
            "eth_getTransactionByHash",
            [hash],
          );
          // The classic listener already knows its locally prepared release
          // hash before it is submitted. A real upstream null is not an error
          // or evidence of canonical closure; do not expose unrelated tx data.
          if (tx === null) return null;
          if (
            !same(tx.from, OPERATOR) ||
            !same(tx.to, s.descriptor.sessionAddress) ||
            tx.input !== "0x" ||
            BigInt(tx.value) <= 0n
          )
            throw Error("Only session or operator funding hashes may be read");
        }
        return await this.upstream(method, params);
      }
      throw Error("Method or account outside this test");
    } finally {
      this.inFlight--;
    }
  }
  private async send(params: unknown[]) {
    const s = this.session;
    if (
      !s?.approved ||
      this.busy ||
      params.length !== 1 ||
      typeof params[0] !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(params[0]) ||
      params[0].length > 40_000
    )
      throw Error("Unapproved or oversized send");
    this.busy = true;
    try {
      const raw = params[0] as TransactionSerialized;
      const tx = parseTransaction(raw),
        hash = keccak256(raw),
        p = s.plan.feePlan;
      if (
        tx.type !== "eip1559" ||
        tx.chainId !== CHAIN ||
        !same(
          await recoverTransactionAddress({ serializedTransaction: raw }),
          s.descriptor.sessionAddress,
        ) ||
        (tx.accessList?.length ?? 0) !== 0 ||
        s.hashes.has(hash)
      )
        throw Error("Wrong signer, chain, type or duplicate submission");
      let role: string, slot: string;
      if (tx.data && tx.data !== "0x") {
        role = "media";
        slot = `media:${s.nextMedia}`;
        const packet = packetFromHex(tx.data);
        if (
          packet.codec !== PatioCodec.OPUS_WEBM ||
          ![PatioPacketType.START, PatioPacketType.AUDIO].includes(
            packet.type,
          ) ||
          s.frozen ||
          s.nextMedia >= s.plan.replacementsPerWindow ||
          tx.nonce !== 1 ||
          !same(tx.to, s.descriptor.sessionAddress) ||
          (tx.value ?? 0n) !== 0n ||
          tx.gas !== MEDIA_TRANSACTION_GAS ||
          tx.maxFeePerGas !== p.mediaFeeLadderWei[s.nextMedia] ||
          tx.maxPriorityFeePerGas !==
            p.mediaPriorityFeeLadderWei[s.nextMedia] ||
          packet.streamId !== s.descriptor.streamId ||
          packet.sequence !== s.nextMedia ||
          packet.windowIndex !== 0
        )
          throw Error("Media outside approved plan");
      } else {
        if (
          tx.maxFeePerGas !== p.sealMaxFeePerGasWei ||
          tx.maxPriorityFeePerGas !== p.sealPriorityFeePerGasWei ||
          tx.gas !== 21_000n
        )
          throw Error("Cleanup fee/gas outside approved plan");
        if (
          same(tx.to, s.descriptor.sessionAddress) &&
          (tx.value ?? 0n) === 0n &&
          s.frozen &&
          (tx.nonce === 0 || tx.nonce === 1)
        ) {
          role = tx.nonce === 0 ? "release" : "seal";
          slot = role;
          if (role === "release" && !s.observedSeals.size)
            throw Error("Exact seal observation required before release");
        } else if (
          same(tx.to, OPERATOR) &&
          (tx.nonce === 0 || tx.nonce === 2)
        ) {
          role = tx.nonce === 0 ? "cancel" : "sweep";
          slot = "return";
          if (role === "cancel" ? s.hashes.size !== 0 : !s.frozen)
            throw Error("Return ownership/closure not established");
          const [nonce, balance, code] = await Promise.all([
            this.upstream<Hex>("eth_getTransactionCount", [
              s.descriptor.sessionAddress,
              "latest",
            ]),
            this.upstream<Hex>("eth_getBalance", [
              s.descriptor.sessionAddress,
              "latest",
            ]),
            this.upstream<Hex>("eth_getCode", [OPERATOR, "latest"]),
          ]);
          if (
            BigInt(nonce) !== BigInt(tx.nonce) ||
            code !== "0x" ||
            tx.value !== BigInt(balance) - 21_000n * p.sealMaxFeePerGasWei ||
            tx.value <= 0n
          )
            throw Error("Return differs from reconciled balance/nonce");
          if (role === "cancel") s.frozen = true;
        } else throw Error("Unpermitted transaction");
      }
      if (s.slots.has(slot))
        throw Error("Operation already attempted; no resend");
      s.slots.add(slot);
      s.hashes.set(hash, { role, nonce: tx.nonce });
      if (role === "media") s.nextMedia++;
      // Record the identity BEFORE the only send attempt. Never retry/fallback.
      const result = await this.upstream<Hex>("eth_sendRawTransaction", [raw]);
      if (!same(result, hash))
        throw Error("Submission identity uncertain; reconcile only");
      return hash;
    } finally {
      this.busy = false;
    }
  }
}

let adapter: QuickNodeAudioAdapter | undefined;
async function boundedText(input: Request | Response, limit: number) {
  const reader = input.body?.getReader();
  if (!reader) throw Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw Error("Body limit exceeded");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
function instance() {
  if (process.env.PATIO_LOCAL_QUICKNODE_AUDIO !== "1" || process.env.VERCEL)
    throw Error("Local-only host disabled");
  if (!adapter) {
    const endpoint = process.env.PATIO_HOODI_QUICKNODE_RPC_URL;
    if (!endpoint) throw Error("Protected QuickNode configuration missing");
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".ethereum-hoodi.quiknode.pro") ||
      url.username ||
      url.password
    )
      throw Error("Unexpected configured provider");
    adapter = new QuickNodeAudioAdapter(
      async <T>(method: string, params: unknown[]): Promise<T> => {
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!response.ok) throw Error("QuickNode request failed; no fallback");
        const text = await boundedText(response, 512_000);
        if (text.length > 512_000) throw Error("Bounded response exceeded");
        const result = JSON.parse(text) as { result?: T; error?: unknown };
        if (result.error || result.result === undefined)
          throw Error("QuickNode method failed; session retained");
        return result.result;
      },
    );
  }
  return adapter;
}
export async function POST(request: Request) {
  try {
    const expected = process.env.PATIO_LOCAL_AUDIO_ORIGIN;
    if (
      !expected ||
      new URL(expected).hostname !== "127.0.0.1" ||
      request.headers.get("host") !== new URL(expected).host ||
      request.headers.get("origin") !== expected ||
      request.headers.get("content-type") !== "application/json"
    )
      throw Error("Local same-origin request required");
    const bodyText = await boundedText(request, 50_000);
    if (bodyText.length > 50_000) throw Error("Request too large");
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const result =
      typeof body.action === "string"
        ? await instance().action(body.action, body)
        : await instance().rpc(
            String(body.method),
            Array.isArray(body.params) ? body.params : [],
          );
    return Response.json(
      { result, id: body.id, jsonrpc: "2.0" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return Response.json(
      {
        error: controlledAudioFailure(cause),
      },
      { status: 400 },
    );
  }
}
