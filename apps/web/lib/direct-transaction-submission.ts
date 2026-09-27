import { keccak256, type Hex } from "viem";

import type { RpcReceipt, RpcTransaction } from "./direct-hoodi";

export type KnownTransactionSubmissionEvidence =
  "accepted" | "known-exact" | "included-exact";

export type KnownTransactionSubmissionFailure =
  "hash-mismatch" | "known-exact-unverified" | "nonce-consumed-unknown";

export class KnownTransactionSubmissionError extends Error {
  public constructor(
    public readonly classification: KnownTransactionSubmissionFailure,
    message: string,
    public readonly expectedHash: Hex,
  ) {
    super(message);
    this.name = "KnownTransactionSubmissionError";
  }
}

export interface KnownTransactionSubmissionReader {
  sendRawTransaction(rawTransaction: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<RpcReceipt | null>;
  transaction(hash: Hex): Promise<RpcTransaction | null>;
}

export interface KnownTransactionSubmissionResult {
  hash: Hex;
  evidence: KnownTransactionSubmissionEvidence;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.toLowerCase() : "";
}

async function readExactEvidence(
  rpc: Pick<KnownTransactionSubmissionReader, "receipt" | "transaction">,
  expectedHash: Hex,
): Promise<KnownTransactionSubmissionEvidence | null> {
  const [receiptResult, transactionResult] = await Promise.allSettled([
    rpc.receipt(expectedHash),
    rpc.transaction(expectedHash),
  ]);
  const receipt =
    receiptResult.status === "fulfilled" ? receiptResult.value : null;
  if (receipt?.transactionHash.toLowerCase() === expectedHash.toLowerCase()) {
    return "included-exact";
  }
  const transaction =
    transactionResult.status === "fulfilled" ? transactionResult.value : null;
  if (transaction?.hash.toLowerCase() === expectedHash.toLowerCase()) {
    return "known-exact";
  }
  return null;
}

/**
 * Submits once. Even a lost/timeout response can be resolved by reading the
 * exact hash; this never resends the bytes. A consumed nonce is
 * not evidence that this candidate was accepted or included.
 */
export async function submitKnownTransaction(
  rpc: KnownTransactionSubmissionReader,
  rawTransaction: Hex,
): Promise<KnownTransactionSubmissionResult> {
  const expectedHash = keccak256(rawTransaction);
  try {
    const submittedHash = await rpc.sendRawTransaction(rawTransaction);
    if (submittedHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new KnownTransactionSubmissionError(
        "hash-mismatch",
        "RPC returned a hash that does not match the submitted transaction.",
        expectedHash,
      );
    }
    return { hash: expectedHash, evidence: "accepted" };
  } catch (cause) {
    if (cause instanceof KnownTransactionSubmissionError) throw cause;
    const message = errorMessage(cause);
    const alreadyKnown =
      /(?:^|\W)(?:already known|known transaction)(?:$|\W)/u.test(message);
    const nonceTooLow = /(?:^|\W)nonce too low(?:$|\W)/u.test(message);
    const exactEvidence = await readExactEvidence(rpc, expectedHash);
    if (exactEvidence) {
      return { hash: expectedHash, evidence: exactEvidence };
    }
    if (!alreadyKnown && !nonceTooLow) throw cause;
    if (nonceTooLow) {
      throw new KnownTransactionSubmissionError(
        "nonce-consumed-unknown",
        "The nonce was already consumed, but the expected transaction is not canonically included or readable by exact hash.",
        expectedHash,
      );
    }
    throw new KnownTransactionSubmissionError(
      "known-exact-unverified",
      "The RPC reported a known transaction, but the expected hash could not be verified.",
      expectedHash,
    );
  }
}
