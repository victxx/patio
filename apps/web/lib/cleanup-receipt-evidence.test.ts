import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import {
  waitForCleanupReceiptEvidence,
  type CleanupReceiptReader,
} from "./cleanup-receipt-evidence";

const session = "0x1111111111111111111111111111111111111111" as Address;
const seal: Hex = `0x${"1".repeat(64)}`;
const media: Hex = `0x${"2".repeat(64)}`;

function receipt(hash: Hex, status: Hex = "0x1") {
  return {
    transactionHash: hash,
    blockNumber: "0x37ecfa" as Hex,
    status,
  };
}

describe("cleanup receipt evidence", () => {
  it("reproduces the H1 safety stop when known media consumed the seal nonce", async () => {
    const rpc: CleanupReceiptReader = {
      receipt: (hash) =>
        Promise.resolve(hash === media ? receipt(media) : null),
      latestTransactionCount: () => Promise.resolve(5n),
    };
    await expect(
      waitForCleanupReceiptEvidence(rpc, {
        sessionAddress: session,
        expectedHash: seal,
        nonce: 1n,
        competingMediaHashes: [media],
        attempts: 1,
        wait: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      classification: "media-canonical-inclusion",
      evidenceHash: media,
    });
  });

  it("treats a reverted included media candidate as a safety failure too", async () => {
    const rpc: CleanupReceiptReader = {
      receipt: (hash) =>
        Promise.resolve(hash === media ? receipt(media, "0x0") : null),
      latestTransactionCount: () => Promise.resolve(2n),
    };
    await expect(
      waitForCleanupReceiptEvidence(rpc, {
        sessionAddress: session,
        expectedHash: seal,
        nonce: 1n,
        competingMediaHashes: [media],
        attempts: 1,
        wait: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      classification: "media-canonical-inclusion",
      evidenceHash: media,
    });
  });

  it("accepts only a successful canonical cleanup receipt", async () => {
    const rpc: CleanupReceiptReader = {
      receipt: () => Promise.resolve(receipt(seal)),
      latestTransactionCount: () => Promise.resolve(1n),
    };
    await expect(
      waitForCleanupReceiptEvidence(rpc, {
        sessionAddress: session,
        expectedHash: seal,
        nonce: 1n,
        attempts: 1,
      }),
    ).resolves.toMatchObject({ transactionHash: seal, status: "0x1" });
  });

  it("keeps an unidentified canonical winner unresolved", async () => {
    const rpc: CleanupReceiptReader = {
      receipt: () => Promise.resolve(null),
      latestTransactionCount: () => Promise.resolve(3n),
    };
    await expect(
      waitForCleanupReceiptEvidence(rpc, {
        sessionAddress: session,
        expectedHash: seal,
        nonce: 2n,
        attempts: 1,
        wait: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ classification: "canonical-winner-unknown" });
  });

  it("does not infer empty-seal success from the final account nonce", async () => {
    const rpc: CleanupReceiptReader = {
      receipt: () => Promise.resolve(null),
      latestTransactionCount: () => Promise.resolve(6n),
    };
    await expect(
      waitForCleanupReceiptEvidence(rpc, {
        sessionAddress: session,
        expectedHash: seal,
        nonce: 1n,
        competingMediaHashes: [],
        attempts: 1,
        wait: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ classification: "canonical-winner-unknown" });
  });

  it("leaves a genuinely pending cleanup as a timeout, not success", async () => {
    const rpc: CleanupReceiptReader = {
      receipt: () => Promise.resolve(null),
      latestTransactionCount: () => Promise.resolve(1n),
    };
    await expect(
      waitForCleanupReceiptEvidence(rpc, {
        sessionAddress: session,
        expectedHash: seal,
        nonce: 1n,
        attempts: 2,
        wait: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ classification: "receipt-timeout" });
  });
});
