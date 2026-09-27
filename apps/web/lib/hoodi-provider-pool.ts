/** Server-side external READ pool. Credentials never leave this module's closure.
 * Not an observer certification or a public transport enablement. */
export const HOODI_PROVIDERS = ["chainstack", "alchemy", "drpc"] as const;
export type HoodiProvider = (typeof HOODI_PROVIDERS)[number];
type Fetcher = typeof fetch;
const zero = `0x${"0".repeat(40)}`;
const hash = `0x${"0".repeat(64)}`;
export interface HoodiProviderEvidence {
  provider: HoodiProvider;
  checkedAt: string;
  chainId: number | null;
  reads: "verified" | "unavailable";
  send: "unverified" | "invalid-input-rejected" | "unavailable";
  observer: "unverified" | "method-available-unverified" | "unavailable";
  failedRead?: string;
  publicTransport: "blocked";
}
export function hoodiProviderUrls(
  env: Record<string, string | undefined>,
): Partial<Record<HoodiProvider, string>> {
  const urls: Partial<Record<HoodiProvider, string>> = {};
  for (const id of HOODI_PROVIDERS) {
    const url = env[`PATIO_HOODI_${id.toUpperCase()}_RPC_URL`];
    if (url) urls[id] = url;
  }
  return urls;
}
export class HoodiProviderPool {
  private counter = 0;
  constructor(
    private readonly urls: Partial<Record<HoodiProvider, string>>,
    private readonly fetcher: Fetcher = fetch,
  ) {}
  private async rpc(
    provider: HoodiProvider,
    method: string,
    params: unknown[],
  ): Promise<{
    id?: unknown;
    result?: unknown;
    error?: { code?: number; message?: string };
  }> {
    const url = this.urls[provider];
    if (!url) throw new Error(`${provider}: unavailable`);
    try {
      const parsed = new URL(url);
      const hosts: Record<HoodiProvider, string> = {
        chainstack: "ethereum-hoodi.core.chainstack.com",
        alchemy: "eth-hoodi.g.alchemy.com",
        drpc: "lb.drpc.live",
      };
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== hosts[provider] ||
        parsed.username ||
        parsed.password ||
        parsed.port
      )
        throw new Error("Invalid configured endpoint");
      const id = ++this.counter;
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok || !response.body) throw new Error("Unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 1_000_000) throw new Error("Response too large");
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
      const value = JSON.parse(new TextDecoder().decode(bytes)) as {
        id?: unknown;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (value.id !== id) throw new Error("Invalid RPC identity");
      return value;
    } catch {
      throw new Error(`${provider}: unavailable`);
    }
  }
  async preflight(
    provider: HoodiProvider,
    probeSend = false,
  ): Promise<HoodiProviderEvidence> {
    const evidence: HoodiProviderEvidence = {
      provider,
      checkedAt: new Date().toISOString(),
      chainId: null,
      reads: "unavailable",
      send: "unverified",
      observer: "unverified",
      publicTransport: "blocked",
    };
    try {
      const chain = await this.rpc(provider, "eth_chainId", []);
      if (
        typeof chain.result !== "string" ||
        !/^0x[0-9a-f]+$/i.test(chain.result)
      )
        return evidence;
      evidence.chainId = Number(BigInt(chain.result));
      if (evidence.chainId !== 560048) return evidence;
      const block = await this.rpc(provider, "eth_getBlockByNumber", [
        "latest",
        false,
      ]);
      const b = block.result as {
        number?: unknown;
        hash?: unknown;
        baseFeePerGas?: unknown;
      } | null;
      if (
        !b ||
        typeof b.number !== "string" ||
        !/^0x[0-9a-f]+$/i.test(b.number) ||
        typeof b.hash !== "string" ||
        !/^0x[0-9a-f]{64}$/i.test(b.hash) ||
        typeof b.baseFeePerGas !== "string" ||
        !/^0x[0-9a-f]+$/i.test(b.baseFeePerGas)
      )
        return evidence;
      const readMethods = [
        "eth_getBalance",
        "eth_getTransactionCount",
        "eth_getCode",
        "eth_maxPriorityFeePerGas",
        "eth_getTransactionReceipt",
        "eth_getTransactionByHash",
        "eth_getLogs",
      ];
      const reads = await Promise.all([
        this.rpc(provider, "eth_getBalance", [zero, "latest"]),
        this.rpc(provider, "eth_getTransactionCount", [zero, "latest"]),
        this.rpc(provider, "eth_getCode", [zero, "latest"]),
        this.rpc(provider, "eth_maxPriorityFeePerGas", []),
        this.rpc(provider, "eth_getTransactionReceipt", [hash]),
        this.rpc(provider, "eth_getTransactionByHash", [hash]),
        this.rpc(provider, "eth_getLogs", [
          { address: zero, fromBlock: b.number, toBlock: b.number },
        ]),
      ]);
      const failed = reads.findIndex((r) => r.error || r.result === undefined);
      const failedMethod = readMethods[failed];
      if (failedMethod) evidence.failedRead = failedMethod;
      if (
        reads.some((r) => r.error || r.result === undefined) ||
        !reads
          .slice(0, 4)
          .every(
            (r, i) =>
              typeof r.result === "string" &&
              (i === 2 ? /^0x(?:[0-9a-f]{2})*$/i : /^0x[0-9a-f]+$/i).test(
                r.result,
              ),
          ) ||
        reads[4].result !== null ||
        reads[5].result !== null ||
        !Array.isArray(reads[6].result)
      )
        return evidence;
      evidence.reads = "verified";
      const observer = await this.rpc(provider, "txpool_contentFrom", [
        zero,
      ]).catch(() => null);
      const pool = observer?.result as
        { pending?: unknown; queued?: unknown } | undefined;
      if (
        !observer?.error &&
        pool &&
        typeof pool.pending === "object" &&
        typeof pool.queued === "object"
      )
        evidence.observer = "method-available-unverified";
      else evidence.observer = "unavailable";
      if (probeSend) {
        // Explicit CLI diagnostic only. Empty bytes cannot encode a signed tx.
        // Rejection proves at most handler exposure, NEVER admission or safety.
        const send = await this.rpc(provider, "eth_sendRawTransaction", [
          "0x",
        ]).catch(() => null);
        evidence.send =
          send?.error &&
          send.error.code !== -32601 &&
          /empty|rlp|decode|invalid|short|unexpected end/i.test(
            send.error.message ?? "",
          )
            ? "invalid-input-rejected"
            : "unavailable";
      }
    } catch {
      /* metadata only: never persist provider exception text */
    }
    return evidence;
  }
  async selectReadProvider() {
    for (const provider of HOODI_PROVIDERS) {
      const evidence = await this.preflight(provider);
      if (evidence.reads === "verified") return this.pinReadProvider(evidence);
    }
    throw new Error("No verified Hoodi read provider; operation blocked");
  }
  pinReadProvider(evidence: HoodiProviderEvidence) {
    if (evidence.chainId !== 560048 || evidence.reads !== "verified")
      throw new Error("Unverified Hoodi read provider");
    const provider = evidence.provider;
    return Object.freeze({
      provider,
      evidence: Object.freeze({ ...evidence }),
      request: async (method: string, params: unknown[]) => {
        if (!HOODI_READ_METHODS.has(method))
          throw new Error(`${provider}: read-only; public submission blocked`);
        const result = await this.rpc(provider, method, params);
        if (result.error || result.result === undefined)
          throw new Error(
            `${provider}: read failed; no mid-operation fallback`,
          );
        return result.result;
      },
    });
  }
}
export const HOODI_READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getCode",
  "eth_maxPriorityFeePerGas",
  "eth_gasPrice",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getLogs",
  "eth_call",
  "eth_estimateGas",
]);
