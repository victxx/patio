import ganache from "ganache";
import {
  bytesToHex,
  createPublicClient,
  custom,
  defineChain,
  keccak256,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  createStreamId,
  encodePatioPacket,
  PatioCodec,
  PatioPacketType,
} from "@patio/protocol";

interface GanacheAccount {
  secretKey: Hex;
}

describe.sequential("observer seal versus producer media validity", () => {
  it("proves an unseen seal does not invalidate media retained by a producer", async () => {
    const chain = defineChain({
      id: 31_338,
      name: "Patio transport safety fixture",
      nativeCurrency: { name: "Test Ether", symbol: "TETH", decimals: 18 },
      rpcUrls: { default: { http: ["http://127.0.0.1"] } },
    });
    const provider = ganache.provider({
      chain: { chainId: chain.id, hardfork: "shanghai" },
      logging: { quiet: true },
      miner: { instamine: "strict" },
      wallet: { deterministic: true, totalAccounts: 2 },
    });
    const accounts = Object.values(
      provider.getInitialAccounts() as Record<string, GanacheAccount>,
    );
    const session = privateKeyToAccount(accounts[0]!.secretKey);
    const transport = custom(provider as unknown as EIP1193Provider);
    const client = createPublicClient({ chain, transport });
    const mediaData = bytesToHex(
      encodePatioPacket({
        version: 1,
        type: PatioPacketType.AUDIO,
        codec: PatioCodec.OPUS_WEBM,
        flags: 0,
        streamId: createStreamId("h2.1-producer-view"),
        windowIndex: 0,
        sequence: 0,
        capturedAtMs: 1n,
        payload: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    const common = {
      chainId: chain.id,
      type: "eip1559" as const,
      to: session.address,
      value: 0n,
      maxPriorityFeePerGas: 1_000_000_000n,
    };
    const media = await session.signTransaction({
      ...common,
      nonce: 1,
      data: mediaData,
      gas: 100_000n,
      maxFeePerGas: 3_000_000_000n,
    });
    const seal = await session.signTransaction({
      ...common,
      nonce: 1,
      data: "0x",
      gas: 21_000n,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    const release = await session.signTransaction({
      ...common,
      nonce: 0,
      data: "0x",
      gas: 21_000n,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });

    // The observer's view has the higher-fee empty seal. The producer never
    // receives that seal and retains only the earlier valid media candidate.
    const observerView = new Set([keccak256(seal)]);
    const producerMediaHash = await client.request({
      method: "eth_sendRawTransaction",
      params: [media],
    });
    expect(observerView.has(keccak256(seal))).toBe(true);
    expect(observerView.has(producerMediaHash)).toBe(false);

    const releaseHash = await client.request({
      method: "eth_sendRawTransaction",
      params: [release],
    });
    const [releaseReceipt, mediaReceipt] = await Promise.all([
      client.waitForTransactionReceipt({ hash: releaseHash }),
      client.waitForTransactionReceipt({ hash: producerMediaHash }),
    ]);

    expect(releaseReceipt.status).toBe("success");
    expect(mediaReceipt.status).toBe("success");
    expect(mediaReceipt.blockNumber).toBeGreaterThanOrEqual(
      releaseReceipt.blockNumber,
    );
    const canonicalMedia = await client.getTransaction({
      hash: producerMediaHash,
    });
    expect(canonicalMedia.nonce).toBe(1);
    expect(canonicalMedia.input).toBe(mediaData);
    await expect(
      client.getTransactionReceipt({ hash: keccak256(seal) }),
    ).rejects.toThrow();
  }, 15_000);
});
