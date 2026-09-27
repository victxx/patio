import type { Address, Hex } from "viem";
import type { ClassicRpc } from "../../lib/classic-session";
import type { RpcReceipt, RpcTransaction } from "../../lib/direct-hoodi";
import { PROVIDERS, type Provider } from "./core";

const VARIABLES = {
  chainstack: "PATIO_HOODI_CHAINSTACK_RPC_URL",
  alchemy: "PATIO_HOODI_ALCHEMY_RPC_URL",
  drpc: "PATIO_HOODI_DRPC_RPC_URL",
} as const;
const HOSTS = {
  chainstack: "ethereum-hoodi.core.chainstack.com",
  alchemy: "eth-hoodi.g.alchemy.com",
  drpc: "lb.drpc.live",
} as const;
const READS = new Set([
  "eth_chainId",
  "eth_syncing",
  "eth_getBlockByNumber",
  "eth_maxPriorityFeePerGas",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_estimateGas",
]);
export class RpcFailure extends Error {
  constructor(
    readonly provider: Provider,
    readonly category: string,
    readonly code?: number,
  ) {
    super(`${provider}: ${category}${code === undefined ? "" : ` (${code})`}`);
  }
}
/** No fallback, retries, transaction cache, arbitrary URL or diagnostic raw responses. */
export class LabRpc implements ClassicRpc {
  #url: string;
  calls = 0;
  responseBytes = 0;
  halted = false;
  readonly audit: {
    method: string;
    http?: number;
    rpcCode?: number;
    outcome: string;
  }[] = [];
  constructor(
    readonly provider: Provider,
    readonly limit: number,
    private readonly fetcher: typeof fetch = fetch,
    env: Record<string, string | undefined> = process.env,
    readonly hashOnly = false,
  ) {
    if (!PROVIDERS.includes(provider)) throw new Error("Unknown provider");
    const value = env[VARIABLES[provider]];
    if (!value)
      throw new Error(`Missing protected variable ${VARIABLES[provider]}`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid protected endpoint: ${provider}`);
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== HOSTS[provider] ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      throw new Error(`Unexpected configured endpoint identity: ${provider}`);
    this.#url = value;
  }
  async #wire<T>(
    method: string,
    params: unknown[],
    timeout: number,
  ): Promise<T> {
    if (this.halted || this.calls >= this.limit)
      throw new RpcFailure(this.provider, "request-budget-or-rate-limit");
    this.calls++;
    const audit: {
      method: string;
      http?: number;
      rpcCode?: number;
      outcome: string;
    } = { method, outcome: "attempted" };
    this.audit.push(audit);
    try {
      const res = await this.fetcher(this.#url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.calls,
          method,
          params,
        }),
      });
      if (res.status === 429) this.halted = true;
      audit.http = res.status;
      const text = await res.text();
      this.responseBytes += text.length;
      if (text.length > 256_000)
        throw new RpcFailure(this.provider, "oversize-response");
      const body = JSON.parse(text) as {
        result?: T;
        error?: { code?: number };
      };
      if (body.error?.code !== undefined) audit.rpcCode = body.error.code;
      if (!res.ok)
        throw new RpcFailure(this.provider, `${method}:http`, res.status);
      if (body.error) {
        // Conservative stop on server overload/rate-limit codes, never identity rotation.
        if (body.error.code === -32005 || body.error.code === 429)
          this.halted = true;
        throw new RpcFailure(this.provider, "rpc", body.error.code);
      }
      if (!("result" in body))
        throw new RpcFailure(this.provider, "missing-result");
      audit.outcome = "response";
      return body.result;
    } catch (e) {
      audit.outcome = "error";
      if (audit.http && audit.http >= 400)
        throw new RpcFailure(this.provider, `${method}:http`, audit.http);
      if (e instanceof RpcFailure) throw e;
      throw new RpcFailure(this.provider, "network-timeout-or-invalid-json");
    }
  }
  request<T>(method: string, params: unknown[] = []): Promise<T> {
    if (
      !READS.has(method) ||
      (this.hashOnly && method !== "eth_getTransactionByHash")
    )
      throw new Error("Lab read interface forbids this method");
    if (method === "eth_getBlockByNumber" && params[1] !== false)
      throw new Error("No full blocks");
    return this.#wire<T>(method, params, this.hashOnly ? 600 : 5000);
  }
  /** Only callable through the in-memory permit + inventory callback. */
  async sendRegistered(
    raw: Hex,
    guard: (raw: Hex) => Promise<void>,
  ): Promise<Hex> {
    if (this.hashOnly || this.provider !== "chainstack")
      throw new Error("Reader cannot send");
    await guard(raw);
    return this.#wire<Hex>("eth_sendRawTransaction", [raw], 5000);
  }
  sendRawTransaction(_raw: Hex): Promise<Hex> {
    return Promise.reject(new Error("No unguarded send"));
  }
  async chainId() {
    return Number(BigInt(await this.request<Hex>("eth_chainId")));
  }
  receipt(hash: Hex) {
    return this.request<RpcReceipt | null>("eth_getTransactionReceipt", [hash]);
  }
  transaction(hash: Hex) {
    return this.request<RpcTransaction | null>("eth_getTransactionByHash", [
      hash,
    ]);
  }
  async latestTransactionCount(a: Address) {
    return BigInt(
      await this.request<Hex>("eth_getTransactionCount", [a, "latest"]),
    );
  }
  async balance(a: Address) {
    return BigInt(await this.request<Hex>("eth_getBalance", [a, "latest"]));
  }
  code(a: Address) {
    return this.request<Hex>("eth_getCode", [a, "latest"]);
  }
  async estimateGas(t: {
    from: Address;
    to: Address;
    value: bigint;
    data: Hex;
  }) {
    return BigInt(
      await this.request<Hex>("eth_estimateGas", [
        { ...t, value: `0x${t.value.toString(16)}` },
      ]),
    );
  }
}
