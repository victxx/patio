import { PATIO_REGISTRY_ABI } from "@patio/ethereum";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Hex,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserEthereumRpc, RpcLog } from "./direct-hoodi";
import {
  decodeRegistryLogs,
  fetchPublicBroadcasts,
  parseRegistryAddress,
} from "./patio-registry";

const operator = "0xe8acf143AFbF8B1371A20ea934D334180190Eac1";
const session = "0x1111111111111111111111111111111111111111";
const streamId = "0x11111111111111111111111111111111";

function announcedLog(
  expiresAt: bigint,
  blockNumber = 1n,
  mediaMode = 1,
): RpcLog {
  return {
    address: "0x2222222222222222222222222222222222222222",
    blockNumber: `0x${blockNumber.toString(16)}`,
    data: encodeAbiParameters(parseAbiParameters("uint64,uint64,uint8"), [
      7n,
      expiresAt,
      mediaMode,
    ]),
    logIndex: "0x0",
    topics: encodeEventTopics({
      abi: PATIO_REGISTRY_ABI,
      eventName: "BroadcastAnnounced",
      args: { streamId, operator, session },
    }) as unknown as Hex[],
    transactionHash: `0x${"1".repeat(64)}`,
  };
}

function endedLog(blockNumber = 2n): RpcLog {
  return {
    address: "0x2222222222222222222222222222222222222222",
    blockNumber: `0x${blockNumber.toString(16)}`,
    data: "0x",
    logIndex: "0x0",
    topics: encodeEventTopics({
      abi: PATIO_REGISTRY_ABI,
      eventName: "BroadcastEnded",
      args: { streamId, operator },
    }) as unknown as Hex[],
    transactionHash: `0x${"2".repeat(64)}`,
  };
}

describe("Patio registry", () => {
  afterEach(() => vi.useRealTimers());
  it("decodes active public broadcasts", () => {
    const [broadcast] = decodeRegistryLogs([announcedLog(2_000n)], 1_000);
    expect(broadcast).toMatchObject({
      expiresAt: 2_000,
      mediaMode: "video",
      descriptor: {
        operator,
        sessionAddress: session,
        streamId,
        nonceStart: "7",
      },
    });
  });

  it("keeps each registry announcement on its configured chain", () => {
    const [chiado] = decodeRegistryLogs([announcedLog(2_000n)], 1_000, 10_200);
    expect(chiado?.descriptor.chainId).toBe(10_200);
  });

  it("removes ended and expired broadcasts", () => {
    expect(
      decodeRegistryLogs([announcedLog(2_000n), endedLog()], 1_000),
    ).toEqual([]);
    expect(decodeRegistryLogs([announcedLog(900n)], 1_000)).toEqual([]);
  });

  it("accepts only valid registry addresses", () => {
    expect(parseRegistryAddress(operator)).toBe(operator);
    expect(parseRegistryAddress("not-an-address")).toBeNull();
  });

  it("keeps every eth_getLogs request within five blocks", async () => {
    vi.useFakeTimers();
    const ranges: Array<[bigint, bigint]> = [];
    const times: number[] = [];
    const rpc = {
      blockNumber: () => Promise.resolve(100n),
      logs: (_address: string, fromBlock: bigint, toBlock: bigint) => {
        ranges.push([fromBlock, toBlock]);
        times.push(Date.now());
        return Promise.resolve([]);
      },
    } as unknown as BrowserEthereumRpc;

    const result = fetchPublicBroadcasts(rpc, operator, 560_048, 1_000);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual([]);
    expect(ranges[0]).toEqual([96n, 100n]);
    expect(ranges.at(-1)).toEqual([0n, 0n]);
    expect(ranges.every(([from, to]) => to - from <= 4n)).toBe(true);
    expect(times.slice(1).every((time, i) => time - times[i]! >= 500)).toBe(
      true,
    );
    ranges.length = 0;
    await fetchPublicBroadcasts(rpc, operator, 560_048, 1_000);
    expect(ranges).toEqual([[96n, 100n]]);
  });
  it("publishes a recent announcement before paging older history, with one nonce read", async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const nonce = vi.fn(() => Promise.resolve(7n));
    const rpc = {
      blockNumber: () => Promise.resolve(400n),
      logs: (_address: string, from: bigint) =>
        Promise.resolve(from === 396n ? [announcedLog(2_000n, 399n)] : []),
      latestTransactionCount: nonce,
    } as unknown as BrowserEthereumRpc;
    let complete = false;
    const result = fetchPublicBroadcasts(
      rpc,
      operator,
      560048,
      1000,
      progress,
    ).then((r) => {
      complete = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledWith([
      expect.objectContaining({ announcedBlock: 399n }),
    ]);
    expect(complete).toBe(false);
    await vi.runAllTimersAsync();
    expect(await result).toHaveLength(1);
    expect(nonce).toHaveBeenCalledTimes(1);
  });
  it("keeps an unexpired announcement older than five minutes and a failed nonce read does not erase it", async () => {
    vi.useFakeTimers();
    const rpc = {
      blockNumber: () => Promise.resolve(400n),
      logs: (_address: string, from: bigint, to: bigint) =>
        Promise.resolve(
          from <= 300n && to >= 300n ? [announcedLog(2_000n, 300n)] : [],
        ),
      latestTransactionCount: () =>
        Promise.reject(new Error("temporary read failure")),
    } as unknown as BrowserEthereumRpc;
    const result = fetchPublicBroadcasts(rpc, operator, 560_048, 1_000);
    await vi.runAllTimersAsync();
    expect(await result).toHaveLength(1);
  });
});
