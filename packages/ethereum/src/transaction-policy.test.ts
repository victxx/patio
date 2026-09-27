import { PATIO_CHAIN_IDS, PATIO_DEFAULTS } from "@patio/config";
import {
  createStreamId,
  fragmentVideoSegment,
  packetToHex,
  PatioCodec,
  PatioPacketType,
} from "@patio/protocol";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { BroadcastAuthorizationV1 } from "./authorization";
import {
  createTransactionPolicyState,
  validatePatioTransaction,
} from "./transaction-policy";

const session = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const attacker = privateKeyToAccount(
  "0x2222222222222222222222222222222222222222222222222222222222222222",
);
const streamId = createStreamId("policy-test");

function authorization(): BroadcastAuthorizationV1 {
  return {
    version: 1,
    operator: attacker.address,
    sessionAddress: session.address,
    streamId,
    chainId: PATIO_CHAIN_IDS.hoodi,
    expiresAt: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
    nonceStart: 0n,
    nonceEnd: 1n,
    maxPayloadBytes: PATIO_DEFAULTS.maxPacketPayloadBytes,
    maxReplacementsPerWindow: PATIO_DEFAULTS.maxReplacementsPerWindow,
    maxFeePerGasWei: 100_000n,
    maxTotalExposureWei: PATIO_DEFAULTS.maxSessionExposureWei,
    relayOrigin: "https://relay.patio.test",
  };
}

const packet = packetToHex({
  version: 1,
  type: PatioPacketType.START,
  codec: PatioCodec.OPUS_WEBM,
  flags: 0,
  streamId,
  windowIndex: 0,
  sequence: 0,
  capturedAtMs: 1n,
  payload: new Uint8Array([1, 2, 3]),
});

interface MediaOverrides {
  chainId?: number;
  to?: Address;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

async function signMedia(overrides: MediaOverrides = {}) {
  return session.signTransaction({
    chainId: PATIO_CHAIN_IDS.hoodi,
    type: "eip1559",
    to: session.address,
    value: 0n,
    data: packet,
    gas: 50_000n,
    nonce: 1,
    maxFeePerGas: 10_000n,
    maxPriorityFeePerGas: 10_000n,
    ...overrides,
  });
}

describe("raw transaction policy", () => {
  it("accepts authorized media and enforces a 12.5 percent replacement bump", async () => {
    const state = createTransactionPolicyState();
    await expect(
      validatePatioTransaction(await signMedia(), authorization(), state),
    ).resolves.toMatchObject({
      nonce: 1n,
      isSeal: false,
      isRelease: false,
      packetSequence: 0,
    });
    await expect(
      validatePatioTransaction(
        await signMedia({
          maxFeePerGas: 11_249n,
          maxPriorityFeePerGas: 11_249n,
        }),
        authorization(),
        state,
      ),
    ).rejects.toThrow(/bump/);
    await expect(
      validatePatioTransaction(
        await signMedia({
          maxFeePerGas: 11_250n,
          maxPriorityFeePerGas: 11_250n,
        }),
        authorization(),
        state,
      ),
    ).resolves.toMatchObject({ nonce: 1n });
  });

  it("keeps a real encoded video fragment in signed transaction calldata", async () => {
    const [videoPayload] = fragmentVideoSegment(
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]),
      0,
      true,
    );
    const videoPacket = packetToHex({
      version: 1,
      type: PatioPacketType.START,
      codec: PatioCodec.WEBM_VP8_OPUS,
      flags: 0,
      streamId,
      windowIndex: 0,
      sequence: 0,
      capturedAtMs: 1n,
      payload: videoPayload!,
    });
    await expect(
      validatePatioTransaction(
        await signMedia({ data: videoPacket }),
        authorization(),
        createTransactionPolicyState(),
      ),
    ).resolves.toMatchObject({ data: videoPacket, packetSequence: 0 });
  });

  it.each([
    ["chain", { chainId: 1 }],
    ["recipient", { to: attacker.address }],
    ["value", { value: 1n }],
    ["nonce", { nonce: 2 }],
    ["fee", { maxFeePerGas: 100_001n, maxPriorityFeePerGas: 100_001n }],
  ])("rejects a transaction with the wrong %s", async (_name, overrides) => {
    await expect(
      validatePatioTransaction(
        await signMedia(overrides),
        authorization(),
        createTransactionPolicyState(),
      ),
    ).rejects.toThrow();
  });

  it("rejects a transaction signed by a different sender", async () => {
    const raw = await attacker.signTransaction({
      chainId: PATIO_CHAIN_IDS.hoodi,
      type: "eip1559",
      to: session.address,
      value: 0n,
      data: packet,
      gas: 50_000n,
      nonce: 1,
      maxFeePerGas: 10_000n,
      maxPriorityFeePerGas: 10_000n,
    });
    await expect(
      validatePatioTransaction(
        raw,
        authorization(),
        createTransactionPolicyState(),
      ),
    ).rejects.toThrow(/sender/);
  });

  it("accepts a capped post-cleanup sweep back to the operator", async () => {
    const raw = await session.signTransaction({
      chainId: PATIO_CHAIN_IDS.hoodi,
      type: "eip1559",
      to: attacker.address,
      value: 1_000_000n,
      data: "0x",
      gas: 21_000n,
      nonce: 2,
      maxFeePerGas: 10_000n,
      maxPriorityFeePerGas: 10_000n,
    });
    await expect(
      validatePatioTransaction(
        raw,
        authorization(),
        createTransactionPolicyState(),
      ),
    ).resolves.toMatchObject({ nonce: 2n, isSweep: true });
  });
});
