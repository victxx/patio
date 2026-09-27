import { patioNetworkByChainId } from "@patio/config";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import type { HoodiBetaContext } from "./hoodi-beta";

export interface DirectRpcConfig {
  url: string;
  /** Metadata only. The browser controller retains the signer and inventory. */
  betaContext?: HoodiBetaContext;
  /** Server-side credentialed read pool; selected once per RPC instance. */
  providerSelection?: boolean;
  authHeader?: string;
  authToken?: string;
}

export interface DirectSessionDescriptor {
  /** Only accepted via a trusted private-fixture injection, never a public profile. */
  transportMode?: "single-nonce-retirement-v1" | "classic-v2";
  /** New classic links can establish canonical end; old links lack this bound. */
  classicEnd?: { mediaNonceEnd: string; releaseHash: Hex };
  version: 1;
  chainId: number;
  operator: Address;
  sessionAddress: Address;
  streamId: Hex;
  nonceStart: string;
}

export interface TxpoolTransaction {
  hash: Hex;
  input: Hex;
  nonce: Hex;
  from: Address;
}

export interface RpcReceipt {
  transactionHash: Hex;
  blockNumber: Hex;
  blockHash?: Hex;
  status: Hex;
  gasUsed?: Hex;
  effectiveGasPrice?: Hex;
}

/** Metadata-only transaction lookup used by the read-only wallet operation history. */
export interface RpcTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  nonce: Hex;
  type?: Hex;
  value: Hex;
  gas?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  input?: Hex;
  data?: Hex;
  accessList?: readonly {
    address: Address;
    storageKeys: readonly Hex[];
  }[];
  /** EIP-7702 authorization fields only. Signature material is intentionally not modeled. */
  authorizationList?: readonly {
    chainId?: Hex;
    address?: Address;
    nonce?: Hex;
    /** Some RPCs may supply this recovered field; it is never inferred here. */
    authority?: Address;
  }[];
}

export interface RpcLog {
  address: Address;
  blockNumber: Hex;
  data: Hex;
  logIndex: Hex;
  removed?: boolean;
  topics: Hex[];
  transactionHash: Hex;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

type Fetcher = typeof fetch;

/** The attested private listener already owns its observer; no legacy URL is required. */
export function createLegacyObserverRpc(
  config: DirectRpcConfig,
  privateRetirement: boolean,
): BrowserEthereumRpc | null {
  return privateRetirement ? null : new BrowserEthereumRpc(config);
}

export const DIRECT_SESSION_STORAGE_KEY = "patio.direct.session.v2";
export const DIRECT_OBSERVER_POLL_INTERVAL_MS = 1_000;
export const DIRECT_BROADCAST_OBSERVER_POLL_INTERVAL_MS = 250;
export const DIRECT_VIDEO_PACKET_DWELL_MS =
  DIRECT_OBSERVER_POLL_INTERVAL_MS + 250;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRateLimited(status: number, message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    status === 429 ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("free plan")
  );
}

export class BrowserEthereumRpc {
  private requestId = 0;
  private providerLease?: Promise<{ provider: string; lease: string }>;
  public selectedProvider?: string;

  public constructor(
    private readonly config: DirectRpcConfig,
    private readonly fetcher: Fetcher = fetch,
    private readonly retryDelayMs = 500,
  ) {
    if (!config.url) throw new Error("Direct network RPC is not configured.");
    if (Boolean(config.authHeader) !== Boolean(config.authToken)) {
      throw new Error(
        "Direct RPC header and token must be configured together.",
      );
    }
  }

  public async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.authHeader && this.config.authToken) {
      headers[this.config.authHeader] = this.config.authToken;
    }
    if (this.config.providerSelection) {
      const selectFetch = this.fetcher;
      this.providerLease ??= selectFetch(this.config.url, {
        signal: AbortSignal.timeout(30_000),
      }).then(async (response) => {
        if (!response.ok)
          throw new Error("Hoodi provider preflight unavailable");
        const result = (await response.json()) as {
          provider?: string;
          lease?: string;
        };
        if (
          !result.provider ||
          !["chainstack", "alchemy", "drpc"].includes(result.provider) ||
          !result.lease ||
          !/^[a-f0-9-]{36}$/.test(result.lease)
        )
          throw new Error("Invalid Hoodi provider selection");
        this.selectedProvider = result.provider;
        return { provider: result.provider, lease: result.lease };
      });
      headers["X-Patio-Provider-Lease"] = (await this.providerLease).lease;
    }
    const requestId = ++this.requestId;
    const fetcher = this.fetcher;
    const attempts = method === "eth_sendRawTransaction" ? 1 : 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await fetcher(this.config.url, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params,
          ...(this.config.betaContext
            ? { session: this.config.betaContext }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as RpcEnvelope<T>;
      const message =
        body.error?.message ??
        `Direct RPC ${method} returned HTTP ${response.status}`;
      if (isRateLimited(response.status, message)) {
        if (attempt + 1 < attempts) {
          await wait(this.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new Error(
          "The network RPC free quota is busy. Wait a minute and retry.",
        );
      }
      if (!response.ok || body.error || body.result === undefined) {
        throw new Error(message);
      }
      return body.result;
    }
    throw new Error(`Direct RPC ${method} failed after retries.`);
  }

  public async chainId(): Promise<number> {
    return Number(BigInt(await this.request<Hex>("eth_chainId")));
  }

  public async latestBaseFee(): Promise<bigint> {
    const block = await this.request<{ baseFeePerGas?: Hex }>(
      "eth_getBlockByNumber",
      ["latest", false],
    );
    if (!block.baseFeePerGas) throw new Error("Network block has no base fee.");
    return BigInt(block.baseFeePerGas);
  }

  public async priorityFee(): Promise<bigint> {
    return BigInt(await this.request<Hex>("eth_maxPriorityFeePerGas"));
  }

  public async transactionCount(address: Address): Promise<bigint> {
    return BigInt(
      await this.request<Hex>("eth_getTransactionCount", [address, "pending"]),
    );
  }

  public async latestTransactionCount(address: Address): Promise<bigint> {
    return BigInt(
      await this.request<Hex>("eth_getTransactionCount", [address, "latest"]),
    );
  }

  public async blockNumber(): Promise<bigint> {
    return BigInt(await this.request<Hex>("eth_blockNumber"));
  }

  public async logs(
    address: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RpcLog[]> {
    return this.request<RpcLog[]>("eth_getLogs", [
      {
        address,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      },
    ]);
  }

  public async balance(address: Address): Promise<bigint> {
    return BigInt(
      await this.request<Hex>("eth_getBalance", [address, "latest"]),
    );
  }

  /** Canonical account code. Callers must classify it; non-empty code is not
   * automatically an EIP-7702 delegation. */
  public async code(address: Address): Promise<Hex> {
    return this.request<Hex>("eth_getCode", [address, "latest"]);
  }

  /**
   * Read-only transfer simulation. The optional state override is used only
   * to model a freshly funded Patio session before it exists on-chain.
   */
  public async estimateGas(input: {
    from: Address;
    to: Address;
    value: bigint;
    data?: Hex;
    stateOverride?: Record<string, { balance?: Hex }>;
  }): Promise<bigint> {
    const transaction = {
      from: input.from,
      to: input.to,
      value: `0x${input.value.toString(16)}`,
      data: input.data ?? "0x",
    };
    const params: unknown[] = [transaction, "latest"];
    if (input.stateOverride) params.push(input.stateOverride);
    return BigInt(await this.request<Hex>("eth_estimateGas", params));
  }

  public async sendRawTransaction(rawTransaction: Hex): Promise<Hex> {
    return this.request<Hex>("eth_sendRawTransaction", [rawTransaction]);
  }

  public async receipt(hash: Hex): Promise<RpcReceipt | null> {
    return this.request<RpcReceipt | null>("eth_getTransactionReceipt", [hash]);
  }

  public async transaction(hash: Hex): Promise<RpcTransaction | null> {
    return this.request<RpcTransaction | null>("eth_getTransactionByHash", [
      hash,
    ]);
  }

  public async txpoolContentFrom(address: Address): Promise<unknown> {
    return this.request("txpool_contentFrom", [address]);
  }
}

export async function assertRpcChain(
  rpc: Pick<BrowserEthereumRpc, "chainId">,
  expectedChainId: number,
  label = "RPC",
): Promise<void> {
  const actualChainId = await rpc.chainId();
  if (actualChainId !== expectedChainId) {
    throw new Error(
      `${label} network mismatch: expected chain ${expectedChainId}, received ${actualChainId}.`,
    );
  }
}

function isTxpoolTransaction(value: unknown): value is TxpoolTransaction {
  if (!value || typeof value !== "object") return false;
  const transaction = value as Partial<TxpoolTransaction>;
  return (
    isHex(transaction.hash ?? "", { strict: true }) &&
    isHex(transaction.input ?? "", { strict: true }) &&
    isHex(transaction.nonce ?? "", { strict: true }) &&
    isAddress(transaction.from ?? "")
  );
}

export function flattenTxpoolTransactions(value: unknown): TxpoolTransaction[] {
  if (isTxpoolTransaction(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(flattenTxpoolTransactions);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(flattenTxpoolTransactions);
  }
  return [];
}

export function directSessionUrl(
  origin: string,
  descriptor: DirectSessionDescriptor,
): string {
  const url = new URL("/live", origin);
  url.searchParams.set("station", descriptor.sessionAddress);
  url.searchParams.set("stream", descriptor.streamId);
  url.searchParams.set("operator", descriptor.operator);
  url.searchParams.set("nonce", descriptor.nonceStart);
  url.searchParams.set("chain", String(descriptor.chainId));
  if (descriptor.transportMode === "classic-v2" && descriptor.classicEnd) {
    url.searchParams.set("transport", "classic-v2");
    url.searchParams.set("mediaEnd", descriptor.classicEnd.mediaNonceEnd);
    url.searchParams.set("release", descriptor.classicEnd.releaseHash);
  }
  return url.toString();
}

export function parseDirectSession(
  input: string | URLSearchParams,
): DirectSessionDescriptor | null {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const station = params.get("station");
  const streamId = params.get("stream");
  const operator = params.get("operator");
  const nonceStart = params.get("nonce");
  const chain = params.get("chain");
  if (!station || !streamId || !operator || !nonceStart || !chain) return null;
  if (!isAddress(station) || !isAddress(operator)) return null;
  if (
    !isHex(streamId, { strict: true }) ||
    streamId.length !== 34 ||
    !/^\d+$/.test(nonceStart) ||
    !/^\d+$/.test(chain)
  ) {
    return null;
  }
  const chainId = Number(chain);
  if (!Number.isSafeInteger(chainId) || !patioNetworkByChainId(chainId)) {
    return null;
  }
  const terminalMode = params.get("transport");
  let classicEnd: DirectSessionDescriptor["classicEnd"];
  if (terminalMode === "classic-v2") {
    const end = params.get("mediaEnd"),
      releaseHash = params.get("release");
    if (
      !end ||
      !/^\d+$/.test(end) ||
      !releaseHash ||
      !isHex(releaseHash) ||
      releaseHash.length !== 66 ||
      BigInt(end) <= BigInt(nonceStart) ||
      BigInt(end) - BigInt(nonceStart) > 8n
    )
      return null;
    classicEnd = { mediaNonceEnd: end, releaseHash };
  } else if (terminalMode) return null; // public links never opt into retirement
  return {
    version: 1,
    chainId,
    operator: getAddress(operator),
    sessionAddress: getAddress(station),
    streamId,
    nonceStart,
    ...(classicEnd ? { transportMode: "classic-v2" as const, classicEnd } : {}),
  };
}
