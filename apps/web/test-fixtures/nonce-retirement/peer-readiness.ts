/** PRIVATE harness readiness only. No transaction or signing API. */
import type { PrivateFixtureManifest } from "../../lib/private-retirement-environment";
import { CLIENTS } from "./private-client";

export const STABILITY_MS = 12_000;
const MAX_SAMPLE_GAP_MS = 2500;
type Rpc = { rpc<T>(method: string, params?: unknown[]): Promise<T> };
export interface PeerSample {
  node: string;
  peers: {
    id: string;
    inbound: boolean;
    local: string;
    remote: string;
    static: boolean | null;
    trusted: boolean | null;
  }[];
  head: string;
}
export async function samplePrivatePeers(
  manifest: PrivateFixtureManifest,
  nodes: readonly Rpc[],
): Promise<PeerSample[]> {
  if (
    manifest.chainId !== 1337 ||
    nodes.length !== 3 ||
    new Set(manifest.nodeIds).size !== 3
  )
    throw new Error("Owned private A/B/C manifest required");
  return Promise.all(
    nodes.map(async (node, i) => {
      const label = "ABC"[i]!;
      try {
        const [chain, genesis, info, peers, syncing, head] = await Promise.all([
          node.rpc<string>("eth_chainId"),
          node.rpc<{ hash: string }>("eth_getBlockByNumber", ["0x0", false]),
          node.rpc<{ id: string; name: string }>("admin_nodeInfo"),
          node.rpc<
            {
              id: string;
              network: {
                inbound: boolean;
                localAddress: string;
                remoteAddress: string;
                static?: boolean;
                trusted?: boolean;
              };
            }[]
          >("admin_peers"),
          node.rpc<unknown>("eth_syncing"),
          node.rpc<string>("eth_blockNumber"),
        ]);
        const client = i === 0 ? CLIENTS.nethermind : CLIENTS.geth;
        if (
          chain !== "0x539" ||
          genesis.hash !== manifest.genesisHash ||
          info.id !== manifest.nodeIds[i] ||
          !info.name.includes(client.version) ||
          !info.name.includes(client.commit) ||
          syncing !== false
        )
          throw new Error(
            `${label}: private chain/genesis/client/identity/sync mismatch`,
          );
        for (let j = 0; j < 3; j++) {
          if (j !== i && !peers.some((p) => p.id === manifest.nodeIds[j]))
            throw new Error(`${label}↔${"ABC"[j]} missing`);
        }
        if (peers.length !== 2 || new Set(peers.map((p) => p.id)).size !== 2)
          throw new Error(`${label}: unexpected peer inventory`);
        return {
          node: label,
          head,
          peers: peers
            .map((p) => {
              if (
                typeof p.network?.inbound !== "boolean" ||
                !p.network.localAddress ||
                !p.network.remoteAddress
              )
                throw new Error(`${label}: connection identity unavailable`);
              return {
                id: p.id,
                inbound: p.network.inbound,
                local: p.network.localAddress,
                remote: p.network.remoteAddress,
                static: p.network.static ?? null,
                trusted: p.network.trusted ?? null,
              };
            })
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      } catch (error) {
        // RPC/provider text is intentionally excluded; fixture failures are compact.
        if (error instanceof Error && /^(A|B|C)(:|↔)/.test(error.message))
          throw error;
        throw new Error(
          `${label}: private peer read unavailable; preparation blocked`,
        );
      }
    }),
  );
}

export class PeerStabilityWindow {
  private since: number | undefined;
  private last: number | undefined;
  private connection: string | undefined;
  private reason = "Private topology not yet sampled";
  observe(sample: PeerSample[], now: number) {
    const connection = JSON.stringify(
      sample.map((s) => [
        s.node,
        s.peers.map((p) => [p.id, p.local, p.remote, p.inbound]),
      ]),
    );
    if (
      this.last !== undefined &&
      (now - this.last > MAX_SAMPLE_GAP_MS || now < this.last)
    )
      this.invalidate("Private topology sampling interrupted");
    if (this.connection !== undefined && this.connection !== connection)
      this.invalidate("Private peer connection changed/reconnected");
    this.connection = connection;
    this.since ??= now;
    this.last = now;
    this.reason = "Private topology still inside 12-second stability window";
  }
  invalidate(reason: string) {
    this.since = undefined;
    this.last = undefined;
    this.connection = undefined;
    this.reason = reason;
  }
  requireReady(now: number) {
    if (this.last !== undefined && now - this.last > MAX_SAMPLE_GAP_MS)
      this.invalidate("Private topology sample stale");
    if (this.since === undefined || now - this.since < STABILITY_MS)
      throw new Error(`${this.reason}; preparation/funding blocked`);
  }
}

/** Serialized polling, bounded retained state, cancellation rejects late reads. */
export function monitorPrivatePeers(
  manifest: PrivateFixtureManifest,
  nodes: readonly Rpc[],
  onSample?: (sample: PeerSample[]) => void,
) {
  const window = new PeerStabilityWindow();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const poll = () => {
    if (stopped)
      return Promise.reject(new Error("Private peer monitor stopped"));
    if (pending) return pending;
    pending = (async () => {
      try {
        const sample = await samplePrivatePeers(manifest, nodes);
        if (stopped) throw new Error("Private peer monitor stopped");
        window.observe(sample, performance.now());
        onSample?.(sample);
      } catch (error) {
        window.invalidate(
          error instanceof Error
            ? error.message
            : "Private peer sampling failed",
        );
        throw error;
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  const tick = async () => {
    try {
      await poll();
    } catch {
      /* invalidation above blocks all preparation */
    }
    if (!stopped)
      timer = setTimeout(() => {
        void tick();
      }, 1000);
  };
  void tick();
  return {
    async requireReady() {
      await poll();
      window.requireReady(performance.now());
    },
    async waitReady() {
      const deadline = performance.now() + 20_000;
      let last: Error | undefined;
      while (!stopped && performance.now() < deadline) {
        try {
          await this.requireReady();
          return;
        } catch (error) {
          last =
            error instanceof Error
              ? error
              : new Error("Private readiness failed");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw last ?? new Error("Private stability window unavailable");
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      window.invalidate("Private peer monitor stopped");
    },
  };
}
