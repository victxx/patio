import { parseAbiItem, type Address } from "viem";

export interface PatioNetwork {
  name: string;
  chainId: number;
  /** A public node for the registry, nonces and `txpool_contentFrom`. */
  rpc: string;
  /** Public nodes asked for hinted packets by hash. A gapped packet is not
   * passed between nodes, so it may sit on some public nodes and not others. */
  lookupNodes: readonly string[];
  /** The live PatioOpenRegistryV2. */
  registry: Address;
  /** How far back to look for announcements (about 20 minutes). */
  lookbackBlocks: bigint;
}

export const NETWORKS = {
  amoy: {
    name: "Polygon Amoy",
    chainId: 80002,
    rpc: "https://polygon-amoy-bor-rpc.publicnode.com",
    lookupNodes: [
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://polygon-amoy.drpc.org",
    ],
    registry: "0x9e69330b089c3a113977320d1adacca2d9bdddd2",
    lookbackBlocks: 600n,
  },
  chiado: {
    name: "Gnosis Chiado",
    chainId: 10200,
    rpc: "https://gnosis-chiado-rpc.publicnode.com",
    lookupNodes: [
      "https://gnosis-chiado-rpc.publicnode.com",
      "https://rpc.chiadochain.net",
    ],
    registry: "0xb09b6aa7b9521d45161f8c46c6cfe01b66699cad",
    lookbackBlocks: 240n,
  },
  hoodi: {
    name: "Hoodi",
    chainId: 560048,
    rpc: "https://rpc.sentio.xyz/hoodi",
    lookupNodes: [
      "https://rpc.sentio.xyz/hoodi",
      "https://ethereum-hoodi-rpc.publicnode.com",
    ],
    registry: "0xf3d1609b8b7174e0998474870e7daaa701a5bdee",
    lookbackBlocks: 120n,
  },
} as const satisfies Record<string, PatioNetwork>;

export type NetworkId = keyof typeof NETWORKS;

export const BROADCAST_ANNOUNCED = parseAbiItem(
  "event BroadcastAnnounced(bytes16 indexed streamId, address indexed operator, address indexed session, uint64 nonceStart, uint64 expiresAt, uint8 mediaMode)",
);

export const BROADCAST_ENDED = parseAbiItem(
  "event BroadcastEnded(bytes16 indexed streamId, address indexed operator)",
);
