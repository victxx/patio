import { BrowserEthereumRpc, type DirectRpcConfig } from "./direct-hoodi";

export const FEE_REFRESH_MS = 30_000;
export type NetworkFees = {
  baseFeePerGasWei: bigint;
  priorityFeePerGasWei: bigint;
  updatedAtMs: number;
};
export type FeeState = {
  fees: NetworkFees | null;
  loading: boolean;
  error: string | null;
  checkedAt: number;
};
export const EMPTY_FEES: FeeState = {
  fees: null,
  loading: false,
  error: null,
  checkedAt: 0,
};

/** Shared read-only quote per configuration. Retains the full config and the
 * client's lease; a failed lease is never silently replaced. No wallet APIs. */
export class NetworkFeeReader {
  state = EMPTY_FEES;
  private pending: Promise<NetworkFees | null> | null = null;
  private client: BrowserEthereumRpc | null = null;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly config: DirectRpcConfig,
    readonly chainId: number,
    private fetcher?: typeof fetch,
  ) {}
  snapshot = () => this.state;
  private publish(state: FeeState) {
    this.state = state;
    this.listeners.forEach((fn) => fn());
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) {
      if (
        !this.state.checkedAt ||
        Date.now() - this.state.checkedAt >= FEE_REFRESH_MS
      )
        void this.refresh();
      this.timer = setInterval(() => void this.refresh(), FEE_REFRESH_MS);
    }
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) clearInterval(this.timer);
    };
  };
  refresh = (): Promise<NetworkFees | null> => {
    if (this.pending) return this.pending;
    this.publish({ ...this.state, loading: true });
    this.pending = Promise.resolve().then(async () => {
      try {
        if (!this.config.url) throw new Error("Read RPC is not configured.");
        this.client ??= new BrowserEthereumRpc(this.config, this.fetcher);
        const [chain, baseFeePerGasWei, priorityFeePerGasWei] =
          await Promise.all([
            this.client.chainId(),
            this.client.latestBaseFee(),
            this.client.priorityFee(),
          ]);
        if (chain !== this.chainId)
          throw new Error("Read RPC returned the wrong chain.");
        const fees = {
          baseFeePerGasWei,
          priorityFeePerGasWei,
          updatedAtMs: Date.now(),
        };
        this.publish({
          fees,
          loading: false,
          error: null,
          checkedAt: Date.now(),
        });
        return fees;
      } catch {
        this.publish({
          ...this.state,
          loading: false,
          error: "Fee request failed — Retry.",
          checkedAt: Date.now(),
        });
        return null;
      } finally {
        this.pending = null;
      }
    });
    return this.pending;
  };
}

const readers = new Map<string, NetworkFeeReader>();
export function networkFeeReader(config: DirectRpcConfig, chainId: number) {
  const key = JSON.stringify([
    chainId,
    config.url,
    config.providerSelection,
    config.authHeader,
    config.authToken,
  ]);
  let reader = readers.get(key);
  if (!reader) {
    reader = new NetworkFeeReader(config, chainId);
    readers.set(key, reader);
  }
  return reader;
}
