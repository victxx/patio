import { describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";

import {
  submitKnownTransaction,
  type KnownTransactionSubmissionReader,
} from "./direct-transaction-submission";

const raw = "0x02c0" as Hex;
const expectedHash = keccak256(raw);

function rpc(
  overrides: Partial<KnownTransactionSubmissionReader> = {},
): KnownTransactionSubmissionReader {
  return {
    sendRawTransaction: vi.fn().mockResolvedValue(expectedHash),
    receipt: vi.fn().mockResolvedValue(null),
    transaction: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("known direct transaction submission", () => {
  it("resolves a lost send response by exact hash without submitting twice", async () => {
    const send = vi.fn().mockRejectedValue(new Error("request timed out"));
    const reader = rpc({
      sendRawTransaction: send,
      transaction: vi.fn().mockResolvedValue({ hash: expectedHash }),
    });
    await expect(submitKnownTransaction(reader, raw)).resolves.toEqual({
      hash: expectedHash,
      evidence: "known-exact",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("retains an uncertain response when exact read-back also fails; no resend", async () => {
    const cause = new Error("request timed out");
    const send = vi.fn().mockRejectedValue(cause);
    const reader = rpc({
      sendRawTransaction: send,
      transaction: vi.fn().mockRejectedValue(new Error("read timeout")),
    });
    await expect(submitKnownTransaction(reader, raw)).rejects.toBe(cause);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("records an exact returned hash as accepted, not included", async () => {
    await expect(submitKnownTransaction(rpc(), raw)).resolves.toEqual({
      hash: expectedHash,
      evidence: "accepted",
    });
  });

  it("accepts an already-known error only when the exact hash is readable", async () => {
    const reader = rpc({
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("already known")),
      transaction: vi.fn().mockResolvedValue({ hash: expectedHash }),
    });
    await expect(submitKnownTransaction(reader, raw)).resolves.toEqual({
      hash: expectedHash,
      evidence: "known-exact",
    });
  });

  it("distinguishes exact canonical inclusion after nonce-too-low", async () => {
    const reader = rpc({
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("nonce too low")),
      receipt: vi.fn().mockResolvedValue({
        transactionHash: expectedHash,
        blockNumber: "0x1",
        status: "0x1",
      }),
    });
    await expect(submitKnownTransaction(reader, raw)).resolves.toEqual({
      hash: expectedHash,
      evidence: "included-exact",
    });
  });

  it("never treats nonce-too-low alone as proof of this transaction", async () => {
    const reader = rpc({
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("nonce too low")),
    });
    await expect(submitKnownTransaction(reader, raw)).rejects.toMatchObject({
      classification: "nonce-consumed-unknown",
      expectedHash,
    });
  });

  it("rejects unverified known-transaction strings and hash mismatches", async () => {
    await expect(
      submitKnownTransaction(
        rpc({
          sendRawTransaction: vi
            .fn()
            .mockRejectedValue(new Error("known transaction")),
        }),
        raw,
      ),
    ).rejects.toMatchObject({ classification: "known-exact-unverified" });

    await expect(
      submitKnownTransaction(
        rpc({
          sendRawTransaction: vi.fn().mockResolvedValue(`0x${"f".repeat(64)}`),
        }),
        raw,
      ),
    ).rejects.toMatchObject({ classification: "hash-mismatch" });
  });

  it("does not confuse unknown-transaction errors with exact-known evidence", async () => {
    const cause = new Error("unknown transaction");
    await expect(
      submitKnownTransaction(
        rpc({ sendRawTransaction: vi.fn().mockRejectedValue(cause) }),
        raw,
      ),
    ).rejects.toBe(cause);
  });
});
