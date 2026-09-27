import { isHex, type Address, type Hex } from "viem";

/** Narrow transport, not a wallet provider. Implementations MUST make one attempt,
 * with a finite timeout; in particular writes must never retry. */
export interface PrivateRetirementRpc {
  request<T>(method: string, params?: readonly unknown[]): Promise<T>;
}
export interface PrivateFixtureManifest {
  kind: "patio-owned-prague-fixture";
  chainId: 1337;
  genesisHash: Hex;
  nodeIds: readonly [string, string, string];
}
const certified = new WeakSet<PrivateRetirementEnvironment>();
const clients = [
  ["Nethermind/v1.39.3", "28cbe2a0"],
  ["Geth/v1.17.5", "9621c6ad"],
  ["Geth/v1.17.5", "9621c6ad"],
] as const;

function boundedEndpoint(rpc: PrivateRetirementRpc): PrivateRetirementRpc {
  return Object.freeze({
    async request<T>(
      method: string,
      params: readonly unknown[] = [],
    ): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          rpc.request<T>(method, params),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("RPC timeout")), 5000);
          }),
        ]);
      } catch {
        // Do not expose URLs/credentials/provider response objects. Timeout stops
        // local waiting only; the caller must preserve submission uncertainty.
        throw new Error(
          `${method === "eth_sendRawTransaction" ? "Submission outcome uncertain" : "Private RPC read unavailable"}; no automatic retry`,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}

/** Explicit dependency injection by the OWNED private-process launcher only.
 * Not derived from a URL, wallet, query string, network profile or storage.
 * The manifest is a trust root, not a discovery API or public certification. */
export class PrivateRetirementEnvironment {
  private constructor(
    readonly manifest: Readonly<PrivateFixtureManifest>,
    readonly media: PrivateRetirementRpc,
    readonly close: PrivateRetirementRpc,
    readonly observer: PrivateRetirementRpc,
  ) {}
  static async attest(
    manifest: PrivateFixtureManifest,
    endpoints: readonly [
      PrivateRetirementRpc,
      PrivateRetirementRpc,
      PrivateRetirementRpc,
    ],
  ) {
    if (
      manifest.kind !== "patio-owned-prague-fixture" ||
      manifest.chainId !== 1337 ||
      !isHex(manifest.genesisHash) ||
      manifest.genesisHash.length !== 66 ||
      new Set(manifest.nodeIds).size !== 3 ||
      manifest.nodeIds.some((id) => !/^[a-f0-9]{64,128}$/i.test(id))
    )
      throw new Error(
        "Owned private fixture manifest required; public networks remain closed",
      );
    const env = new PrivateRetirementEnvironment(
      Object.freeze({
        ...manifest,
        nodeIds: Object.freeze([
          ...manifest.nodeIds,
        ]) as unknown as PrivateFixtureManifest["nodeIds"],
      }),
      boundedEndpoint(endpoints[0]),
      boundedEndpoint(endpoints[1]),
      boundedEndpoint(endpoints[2]),
    );
    await env.check();
    certified.add(env);
    Object.freeze(env);
    return env;
  }
  private async check() {
    for (const [i, rpc] of [this.media, this.close, this.observer].entries()) {
      const [chain, genesis, version, info, peers, syncing] = await Promise.all(
        [
          rpc.request<Hex>("eth_chainId"),
          rpc.request<{ hash: Hex }>("eth_getBlockByNumber", ["0x0", false]),
          rpc.request<string>("web3_clientVersion"),
          rpc.request<{ id: string }>("admin_nodeInfo"),
          rpc.request<{ id: string }[]>("admin_peers"),
          rpc.request<unknown>("eth_syncing"),
        ],
      );
      const expected = this.manifest.nodeIds.filter((_, j) => j !== i).sort();
      if (
        BigInt(chain) !== 1337n ||
        genesis.hash !== this.manifest.genesisHash ||
        !clients[i]!.every((part) => version.includes(part)) ||
        info.id !== this.manifest.nodeIds[i] ||
        JSON.stringify(peers.map((p) => p.id).sort()) !==
          JSON.stringify(expected) ||
        syncing !== false
      )
        throw new Error(
          "Private topology identity/capability mismatch; action blocked",
        );
    }
  }
  async revalidate() {
    if (!certified.has(this))
      throw new Error("Uncertified private environment");
    await this.check();
  }
}

export function assertPrivateEnvironment(
  env: PrivateRetirementEnvironment,
): void {
  if (!certified.has(env)) throw new Error("Uncertified private environment");
}

/** Pending type-4 visibility is deliberately irrelevant. Snapshot at one canonical block. */
export async function readCanonicalRetirement(
  env: PrivateRetirementEnvironment,
  address: Address,
  sweepNonce: number,
) {
  assertPrivateEnvironment(env);
  const block = await env.observer.request<{ number: Hex; hash: Hex }>(
    "eth_getBlockByNumber",
    ["latest", false],
  );
  const [nonce, code] = await Promise.all([
    env.observer.request<Hex>("eth_getTransactionCount", [
      address,
      block.number,
    ]),
    env.observer.request<Hex>("eth_getCode", [address, block.number]),
  ]);
  const again = await env.observer.request<{ hash: Hex }>(
    "eth_getBlockByNumber",
    [block.number, false],
  );
  if (again.hash !== block.hash)
    throw new Error("Canonical observation changed");
  return {
    retired: BigInt(nonce) >= BigInt(sweepNonce) && code === "0x",
    nonce: BigInt(nonce),
    code,
    blockNumber: block.number,
    blockHash: block.hash,
  };
}
