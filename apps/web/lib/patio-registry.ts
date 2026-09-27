import { PATIO_REGISTRY_ABI } from "@patio/ethereum";
import {
  decodeEventLog,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";

import type {
  BrowserEthereumRpc,
  DirectSessionDescriptor,
  RpcLog,
} from "./direct-hoodi";

// Include preparation/listener setup time, not just the last five minutes.
// Five-block pages respect the existing provider limit; subsequent refreshes
// reread only the overlap plus new blocks, not this whole history.
const REGISTRY_LOOKBACK_BLOCKS = 120n;
const REGISTRY_LOG_BLOCK_RANGE = 5n;
const REGISTRY_PAGE_INTERVAL_MS = 500;
const directoryCache = new WeakMap<
  BrowserEthereumRpc,
  Map<string, { latest: bigint; logs: RpcLog[] }>
>();

export type RegistryMediaMode = "audio" | "video";

export interface PublicBroadcast {
  descriptor: DirectSessionDescriptor;
  expiresAt: number;
  mediaMode: RegistryMediaMode;
  announcedBlock: bigint;
}

export function parseRegistryAddress(value: string): Address | null {
  return isAddress(value) ? getAddress(value) : null;
}

export function decodeRegistryLogs(
  logs: readonly RpcLog[],
  nowSeconds: number,
  chainId = 560_048,
): PublicBroadcast[] {
  const active = new Map<string, PublicBroadcast>();
  const ordered = logs
    .filter((log) => !log.removed)
    .toSorted((left, right) => {
      const blockDifference =
        BigInt(left.blockNumber) - BigInt(right.blockNumber);
      if (blockDifference !== 0n) return blockDifference < 0n ? -1 : 1;
      return Number(BigInt(left.logIndex) - BigInt(right.logIndex));
    });

  for (const log of ordered) {
    try {
      const decoded = decodeEventLog({
        abi: PATIO_REGISTRY_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "BroadcastEnded") {
        active.delete(decoded.args.streamId.toLowerCase());
        continue;
      }
      const { streamId, operator, session, nonceStart, expiresAt, mediaMode } =
        decoded.args;
      active.set(streamId.toLowerCase(), {
        descriptor: {
          version: 1,
          chainId,
          operator: getAddress(operator),
          sessionAddress: getAddress(session),
          streamId,
          nonceStart: nonceStart.toString(),
        },
        expiresAt: Number(expiresAt),
        // The deployed v1 registry accepts only 0 (audio) and 1 (video).
        // The Patio packet codec distinguishes real WebM video from legacy beta.
        mediaMode: mediaMode === 1 ? "video" : "audio",
        announcedBlock: BigInt(log.blockNumber),
      });
    } catch {
      // Ignore unrelated or malformed logs from an incorrectly configured address.
    }
  }

  return [...active.values()]
    .filter((broadcast) => broadcast.expiresAt > nowSeconds)
    .toSorted((left, right) =>
      left.announcedBlock > right.announcedBlock ? -1 : 1,
    );
}

export async function fetchPublicBroadcasts(
  rpc: BrowserEthereumRpc,
  registryAddress: Address,
  chainId = 560_048,
  nowSeconds = Math.floor(Date.now() / 1_000),
  onProgress?: (broadcasts: PublicBroadcast[]) => void,
): Promise<PublicBroadcast[]> {
  const latestBlock = await rpc.blockNumber();
  const fromBlock =
    latestBlock > REGISTRY_LOOKBACK_BLOCKS
      ? latestBlock - REGISTRY_LOOKBACK_BLOCKS
      : 0n;
  const key = `${chainId}:${registryAddress.toLowerCase()}`;
  const cache =
    directoryCache.get(rpc) ??
    new Map<string, { latest: bigint; logs: RpcLog[] }>();
  directoryCache.set(rpc, cache);
  const previous = cache.get(key);
  const overlap =
    previous && previous.latest <= latestBlock
      ? previous.latest - 4n
      : fromBlock;
  const queryFrom = overlap > fromBlock ? overlap : fromBlock;
  const logs: RpcLog[] =
    previous && previous.latest <= latestBlock
      ? previous.logs.filter(
          (log) =>
            BigInt(log.blockNumber) >= fromBlock &&
            BigInt(log.blockNumber) < queryFrom,
        )
      : [];
  const ranges: [bigint, bigint][] = [];
  for (
    let rangeEnd = latestBlock;
    rangeEnd >= queryFrom;
    rangeEnd -= REGISTRY_LOG_BLOCK_RANGE
  ) {
    const candidateStart = rangeEnd - REGISTRY_LOG_BLOCK_RANGE + 1n;
    const rangeStart = candidateStart > queryFrom ? candidateStart : queryFrom;
    ranges.push([rangeStart, rangeEnd]);
  }
  const nonceReads = new Map<string, Promise<bigint>>();
  const currentBroadcasts = async () => {
    const broadcasts = decodeRegistryLogs(logs, nowSeconds, chainId);
    const live = await Promise.all(
      broadcasts.map(async (broadcast) => {
        const { sessionAddress, nonceStart } = broadcast.descriptor;
        let nonce = nonceReads.get(sessionAddress);
        if (!nonce) {
          nonce = rpc
            .latestTransactionCount(sessionAddress)
            .catch(() => BigInt(nonceStart));
          nonceReads.set(sessionAddress, nonce);
        }
        return { broadcast, finished: (await nonce) > BigInt(nonceStart) };
      }),
    );
    return live
      .filter(({ finished }) => !finished)
      .map(({ broadcast }) => broadcast);
  };
  // A bounded 24-minute history covers setup and a short beta broadcast.
  // Pace pages instead of bursting into the same service's media quota.
  for (let i = 0; i < ranges.length; i++) {
    if (i > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, REGISTRY_PAGE_INTERVAL_MS),
      );
    const [from, to] = ranges[i]!;
    logs.push(...(await rpc.logs(registryAddress, from, to)));
    if (onProgress) onProgress(await currentBroadcasts());
  }
  cache.set(key, { latest: latestBlock, logs });
  return currentBroadcasts();
}
