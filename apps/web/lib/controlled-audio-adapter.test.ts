import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { packetToHex, packetFromHex } from "@patio/protocol";
import { MEDIA_TRANSACTION_GAS } from "@patio/ethereum";
import {
  QuickNodeAudioAdapter,
  controlledAudioFailure,
} from "../test-fixtures/hoodi-hash-canary/audio-adapter";
import { createRequiredDirectPlan } from "./direct-plan";
// Offline fixture signer + RPC doubles. No real provider sends.
describe("controlled real-app QuickNode boundary", () => {
  it("identifies a retained reservation before dispatch without replacing it or leaking errors", async () => {
    const upstream = vi.fn();
    const adapter = new QuickNodeAudioAdapter(upstream);
    const address = "0x1111111111111111111111111111111111111111";
    await adapter.action("reserve", { address });
    for (const attempted of [
      address,
      "0x2222222222222222222222222222222222222222",
    ]) {
      let failure: unknown;
      try {
        await adapter.action("reserve", { address: attempted });
      } catch (cause) {
        failure = cause;
      }
      expect(controlledAudioFailure(failure)).toMatchObject({
        code: "SESSION_ALREADY_RESERVED",
        operation: "reserve",
        upstreamDispatch: false,
      });
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(await adapter.action("status", {})).toMatchObject({
      reservedAddress: address,
      approved: false,
      operationInProgress: false,
      rpcInFlight: 0,
      sendInventory: [],
    });
    expect(
      JSON.stringify(
        controlledAudioFailure(new Error("secret-fixture-marker")),
      ),
    ).not.toContain("secret-fixture-marker");
    expect(controlledAudioFailure(new Error("timeout"))).toMatchObject({
      upstreamDispatch: "unknown",
    });
  });
  it("requires one reviewed account and explicit approval, validates packets and prevents duplicate sends", async () => {
    const account = privateKeyToAccount(`0x${"44".repeat(32)}`);
    const operator = "0xca490deA7D7D79Bac4537D5Fe68fF10cd9c7EbEd";
    const stream: Hex = `0x${"11".repeat(16)}`;
    const plan = createRequiredDirectPlan(
      1_040_000n,
      75_000_000n,
      15,
      undefined,
      3000,
      undefined,
      "classic-per-nonce-v2",
    )!;
    const upstream = vi.fn(
      async (method: string, params: unknown[]): Promise<unknown> => {
        await Promise.resolve();
        if (method === "eth_chainId") return "0x88bb0";
        if (method === "eth_getCode") return "0x";
        if (method === "eth_getBalance" || method === "eth_getTransactionCount")
          return "0x0";
        if (method === "eth_getBlockByNumber")
          return {
            number: "0x10",
            hash: `0x${"aa".repeat(32)}`,
            baseFeePerGas: "0xfde80",
          };
        if (method === "eth_sendRawTransaction")
          return keccak256(params[0] as Hex);
        if (method === "eth_getTransactionByHash") return null;
        throw Error("Unexpected method");
      },
    );
    const adapter = new QuickNodeAudioAdapter(
      upstream as <T>(m: string, p: unknown[]) => Promise<T>,
    );
    await expect(
      adapter.rpc("eth_sendRawTransaction", ["0x00"]),
    ).rejects.toThrow();
    await adapter.action("reserve", { address: account.address });
    const review = (await adapter.action("review", {
      descriptor: {
        version: 1,
        chainId: 560048,
        operator,
        sessionAddress: account.address,
        streamId: stream,
        nonceStart: "0",
      },
      duration: 15,
      base: "1040000",
      tip: "75000000",
      funding: plan.requiredFundingWei.toString(),
    })) as { id: string };
    const packet = (streamId: Hex) =>
      packetToHex({
        version: 1,
        type: 2,
        codec: 1,
        flags: 0,
        streamId,
        windowIndex: 0,
        sequence: 0,
        capturedAtMs: 0n,
        payload: new Uint8Array(6000).fill(9),
      });
    const raw = await account.signTransaction({
      type: "eip1559",
      chainId: 560048,
      to: account.address,
      value: 0n,
      nonce: 1,
      gas: MEDIA_TRANSACTION_GAS,
      maxFeePerGas: plan.feePlan.mediaFeeLadderWei[0]!,
      maxPriorityFeePerGas: plan.feePlan.mediaPriorityFeeLadderWei[0]!,
      data: packet(stream),
    });
    await expect(adapter.rpc("eth_sendRawTransaction", [raw])).rejects.toThrow(
      "Unapproved",
    );
    await adapter.action("approve", { id: review.id });
    // A locally prepared release need not be known to the provider yet.
    expect(
      await adapter.rpc("eth_getTransactionReceipt", [`0x${"cc".repeat(32)}`]),
    ).toBeNull();
    const wrong = await account.signTransaction({
      type: "eip1559",
      chainId: 560048,
      to: account.address,
      value: 0n,
      nonce: 1,
      gas: MEDIA_TRANSACTION_GAS,
      maxFeePerGas: plan.feePlan.mediaFeeLadderWei[0]!,
      maxPriorityFeePerGas: plan.feePlan.mediaPriorityFeeLadderWei[0]!,
      data: packet(`0x${"22".repeat(16)}`),
    });
    await expect(
      adapter.rpc("eth_sendRawTransaction", [wrong]),
    ).rejects.toThrow("outside approved");
    expect(packetFromHex(packet(stream)).payload.length).toBe(6000);
    expect(await adapter.rpc("eth_sendRawTransaction", [raw])).toBe(
      keccak256(raw),
    );
    await expect(
      adapter.rpc("eth_sendRawTransaction", [raw]),
    ).rejects.toThrow();
    expect(
      upstream.mock.calls.filter(([m]) => m === "eth_sendRawTransaction"),
    ).toHaveLength(1);
    await expect(adapter.rpc("txpool_content", [])).rejects.toThrow();
    await expect(
      adapter.rpc("txpool_contentFrom", [operator]),
    ).rejects.toThrow();
    await expect(
      adapter.action("reserve", { address: operator }),
    ).rejects.toThrow();
  });
});
