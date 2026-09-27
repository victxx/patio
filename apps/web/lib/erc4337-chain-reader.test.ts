import { encodeAbiParameters, getAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { ERC4337_ENTRY_POINT_V07 } from "@patio/wallet-core";

import { browserErc4337ChainReader } from "./erc4337-chain-reader";

const sender = getAddress("0x1111111111111111111111111111111111111111");
const txHash: Hex = `0x${"aa".repeat(32)}`;
const blockHash: Hex = `0x${"bb".repeat(32)}`;

describe("canonical ERC-4337 chain reader", () => {
  it("uses only read methods and keyed EntryPoint nonce/deposit calls", async () => {
    const request = vi.fn((method: string) => {
      if (method === "eth_chainId") return Promise.resolve("0x88bb0");
      if (method === "eth_getCode") return Promise.resolve("0x6001");
      if (method === "eth_getBalance") return Promise.resolve("0x64");
      if (method === "eth_getBlockByNumber")
        return Promise.resolve({ timestamp: "0x6553f100" });
      if (method === "eth_call")
        return Promise.resolve(
          encodeAbiParameters([{ type: "uint256" }], [7n]),
        );
      if (method === "eth_getTransactionReceipt") return Promise.resolve(null);
      return Promise.reject(new Error(method));
    });
    const reader = browserErc4337ChainReader({
      request<T>(method: string): Promise<T> {
        return request(method) as Promise<T>;
      },
    });
    expect(await reader.chainId()).toBe(560_048);
    expect(await reader.code(sender)).toBe("0x6001");
    expect(await reader.balance(sender)).toBe(100n);
    expect(await reader.latestTimestamp()).toBe(1_700_000_000n);
    expect(
      await reader.entryPointNonce({
        entryPoint: ERC4337_ENTRY_POINT_V07,
        sender,
        key: 0n,
      }),
    ).toBe(7n);
    expect(
      await reader.entryPointDeposit({
        entryPoint: ERC4337_ENTRY_POINT_V07,
        sender,
      }),
    ).toBe(7n);
    expect(await reader.receipt(txHash)).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).not.toContain(
      "eth_sendRawTransaction",
    );
  });

  it("parses bounded canonical receipt metadata and logs", async () => {
    const request = vi.fn((method: string) => {
      if (method !== "eth_getTransactionReceipt")
        return Promise.reject(new Error(method));
      return Promise.resolve({
        transactionHash: txHash,
        blockHash,
        blockNumber: "0xa",
        status: "0x1",
        logs: [
          {
            address: ERC4337_ENTRY_POINT_V07,
            topics: [`0x${"cc".repeat(32)}`],
            data: "0x",
            transactionHash: txHash,
            blockHash,
            blockNumber: "0xa",
          },
        ],
      });
    });
    const reader = browserErc4337ChainReader({
      request<T>(method: string): Promise<T> {
        return request(method) as Promise<T>;
      },
    });
    expect(await reader.receipt(txHash)).toMatchObject({
      transactionHash: txHash,
      blockHash,
      blockNumber: 10n,
      status: "success",
      logs: [{ transactionHash: txHash }],
    });
  });
});
