import type { Address, Hex } from "viem";

import type { RpcReceipt } from "./direct-hoodi";

export type CleanupReceiptFailureClass =
  | "receipt-timeout"
  | "receipt-reverted"
  | "media-canonical-inclusion"
  | "canonical-winner-unknown";

export class CleanupReceiptEvidenceError extends Error {
  public constructor(
    public readonly classification: CleanupReceiptFailureClass,
    message: string,
    public readonly evidenceHash?: Hex,
  ) {
    super(message);
    this.name = "CleanupReceiptEvidenceError";
  }
}

export interface CleanupReceiptReader {
  receipt(hash: Hex): Promise<RpcReceipt | null>;
  latestTransactionCount(address: Address): Promise<bigint>;
}

export async function waitForCleanupReceiptEvidence(
  rpc: CleanupReceiptReader,
  input: {
    sessionAddress: Address;
    expectedHash: Hex;
    nonce: bigint;
    competingMediaHashes?: readonly Hex[];
    attempts?: number;
    pollIntervalMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
  },
): Promise<RpcReceipt> {
  const attempts = input.attempts ?? 60;
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const wait =
    input.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await rpc.receipt(input.expectedHash);
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) {
        throw new CleanupReceiptEvidenceError(
          "receipt-reverted",
          "The expected cleanup transaction reverted canonically.",
          input.expectedHash,
        );
      }
      return receipt;
    }

    const confirmedNonce = await rpc.latestTransactionCount(
      input.sessionAddress,
    );
    if (confirmedNonce > input.nonce) {
      for (const mediaHash of input.competingMediaHashes ?? []) {
        const mediaReceipt = await rpc.receipt(mediaHash);
        if (mediaReceipt) {
          throw new CleanupReceiptEvidenceError(
            "media-canonical-inclusion",
            "A known Patio media candidate consumed the cleanup nonce canonically.",
            mediaHash,
          );
        }
      }
      throw new CleanupReceiptEvidenceError(
        "canonical-winner-unknown",
        "The cleanup nonce was consumed, but the configured RPC cannot identify the canonical winner.",
      );
    }
    await wait(pollIntervalMs);
  }
  throw new CleanupReceiptEvidenceError(
    "receipt-timeout",
    "The cleanup transaction is still waiting for a canonical receipt.",
    input.expectedHash,
  );
}
