import { getAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Erc4337UserOperationV07 } from "@patio/wallet-core";

import {
  BundlerRpcError,
  PatioBundlerClient,
  type BundlerRpcTransport,
} from "./erc4337-bundler";

const sender = getAddress("0x1111111111111111111111111111111111111111");
const entryPoint = getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
const userOpHash: Hex = `0x${"aa".repeat(32)}`;
const txHash: Hex = `0x${"bb".repeat(32)}`;
const blockHash: Hex = `0x${"cc".repeat(32)}`;
const paymaster = getAddress("0x3333333333333333333333333333333333333333");

function operation(): Erc4337UserOperationV07 {
  return {
    sender,
    nonce: 1n,
    callData: "0x1234",
    callGasLimit: 50_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 25_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    signature: `0x${"11".repeat(65)}`,
  };
}

describe("ERC-7769 bundler boundary", () => {
  it("implements the supported read methods with schema validation", async () => {
    const transport: BundlerRpcTransport = {
      request: vi.fn(({ method }: { method: string }) => {
        if (method === "eth_chainId") return Promise.resolve("0x88bb0");
        if (method === "eth_supportedEntryPoints")
          return Promise.resolve([entryPoint]);
        if (method === "eth_estimateUserOperationGas") {
          return Promise.resolve({
            callGasLimit: "0xc350",
            verificationGasLimit: "0x186a0",
            preVerificationGas: "0x61a8",
          });
        }
        if (method === "eth_getUserOperationByHash") {
          return Promise.resolve({
            userOperation: {
              sender,
              nonce: "0x1",
              callData: "0x1234",
              callGasLimit: "0xc350",
              verificationGasLimit: "0x186a0",
              preVerificationGas: "0x61a8",
              maxFeePerGas: "0x77359400",
              maxPriorityFeePerGas: "0x3b9aca00",
              signature: `0x${"11".repeat(65)}`,
            },
            entryPoint,
            transactionHash: txHash,
            blockHash,
            blockNumber: "0xa",
          });
        }
        if (method === "eth_getUserOperationReceipt") {
          return Promise.resolve({
            userOpHash,
            entryPoint,
            sender,
            nonce: "0x1",
            success: false,
            actualGasCost: "0x64",
            actualGasUsed: "0x32",
            logs: [],
            receipt: {
              transactionHash: txHash,
              blockHash,
              blockNumber: "0xa",
              status: "0x1",
            },
          });
        }
        return Promise.reject(new Error(method));
      }),
    };
    const client = new PatioBundlerClient(transport, { readRetries: 0 });
    expect(await client.chainId()).toBe(560_048);
    expect(await client.supportedEntryPoints()).toEqual([entryPoint]);
    expect(
      await client.estimateUserOperationGas({
        operation: operation(),
        entryPoint,
      }),
    ).toEqual({
      callGasLimit: 50_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 25_000n,
    });
    expect(await client.getUserOperationByHash(userOpHash)).toMatchObject({
      entryPoint,
      transactionHash: txHash,
      userOperation: { nonce: 1n },
    });
    expect(await client.getUserOperationReceipt(userOpHash)).toMatchObject({
      success: false,
      outerStatus: "success",
      actualGasCostWei: 100n,
    });
  });

  it("sends exactly once and never applies read retry policy to submission", async () => {
    const request = vi.fn(() =>
      Promise.reject(new Error("timeout token=secret")),
    );
    const client = new PatioBundlerClient({ request }, { readRetries: 4 });
    await expect(
      client.sendUserOperation({ operation: operation(), entryPoint }),
    ).rejects.toMatchObject({
      name: "BundlerRpcError",
      uncertainSubmission: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      client.sendUserOperation({ operation: operation(), entryPoint }),
    ).rejects.not.toThrow("secret");
  });

  it("preserves the EntryPoint v0.7 paymaster fields", async () => {
    const sponsored = {
      ...operation(),
      paymaster,
      paymasterVerificationGasLimit: 120_000n,
      paymasterPostOpGasLimit: 60_000n,
      paymasterData: "0x1234" as Hex,
    };
    const request = vi.fn(
      ({ method, params }: { method: string; params?: readonly unknown[] }) => {
        if (method === "eth_sendUserOperation") {
          expect(params?.[0]).toMatchObject({
            paymaster,
            paymasterVerificationGasLimit: "0x1d4c0",
            paymasterPostOpGasLimit: "0xea60",
            paymasterData: "0x1234",
          });
          return Promise.resolve(userOpHash);
        }
        return Promise.reject(new Error(method));
      },
    );
    const client = new PatioBundlerClient({ request });
    expect(
      await client.sendUserOperation({ operation: sponsored, entryPoint }),
    ).toBe(userOpHash);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a definite JSON-RPC rejection from transport uncertainty", async () => {
    const rejection = Object.assign(new Error("AA21 prefund too low"), {
      code: -32_500,
    });
    const client = new PatioBundlerClient({
      request: vi.fn(() => Promise.reject(rejection)),
    });
    await expect(
      client.sendUserOperation({ operation: operation(), entryPoint }),
    ).rejects.toMatchObject({
      uncertainSubmission: false,
      method: "eth_sendUserOperation",
    });
  });

  it("uses bounded retries only for reads", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("0x88bb0");
    const client = new PatioBundlerClient({ request }, { readRetries: 1 });
    expect(await client.chainId()).toBe(560_048);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not normalize null lookup or receipt as dropped", async () => {
    const client = new PatioBundlerClient(
      { request: vi.fn(() => Promise.resolve(null)) },
      { readRetries: 0 },
    );
    expect(await client.getUserOperationByHash(userOpHash)).toBeNull();
    expect(await client.getUserOperationReceipt(userOpHash)).toBeNull();
  });

  it("rejects malformed receipt evidence", async () => {
    const client = new PatioBundlerClient(
      { request: vi.fn(() => Promise.resolve({ success: true })) },
      { readRetries: 0 },
    );
    await expect(
      client.getUserOperationReceipt(userOpHash),
    ).rejects.toBeInstanceOf(BundlerRpcError);
  });
});
