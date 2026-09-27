import { PATIO_PACKET_OVERHEAD_BYTES, packetFromHex } from "@patio/protocol";
import {
  getAddress,
  hexToBytes,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";

import type { BroadcastAuthorizationV1 } from "./authorization";
import { bumpByBps, MEDIA_TRANSACTION_GAS } from "./fee-plan";

export interface TransactionPolicyState {
  byNonce: Map<bigint, TransactionNonceState>;
}

export interface TransactionNonceState {
  replacements: number;
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  maximumCostWei: bigint;
  sealed: boolean;
}

export interface ValidatedPatioTransaction {
  hashlessRawTransaction: Hex;
  sender: Address;
  nonce: bigint;
  data: Hex;
  isRelease: boolean;
  isSeal: boolean;
  isSweep: boolean;
  packetSequence?: number;
  maximumCostWei: bigint;
}

export function createTransactionPolicyState(): TransactionPolicyState {
  return { byNonce: new Map() };
}

export async function validatePatioTransaction(
  rawTransaction: Hex,
  authorization: BroadcastAuthorizationV1,
  state: TransactionPolicyState,
  bumpBps = 1_250,
): Promise<ValidatedPatioTransaction> {
  const serializedTransaction = rawTransaction as TransactionSerialized;
  const transaction = parseTransaction(serializedTransaction);
  const sender = getAddress(
    await recoverTransactionAddress({ serializedTransaction }),
  );
  if (sender !== authorization.sessionAddress) {
    throw new Error("Transaction sender is not the authorized session wallet");
  }
  if (transaction.chainId !== authorization.chainId) {
    throw new Error("Transaction chain does not match the authorization");
  }
  if (transaction.type !== "eip1559") {
    throw new Error("Only EIP-1559 transactions are accepted");
  }
  if (transaction.nonce === undefined) {
    throw new Error("Signed transaction does not include a nonce");
  }
  const nonce = BigInt(transaction.nonce);
  const isSweep = nonce === authorization.nonceEnd + 1n;
  if (
    nonce < authorization.nonceStart ||
    (nonce > authorization.nonceEnd && !isSweep)
  ) {
    throw new Error("Transaction nonce is outside the authorized epoch");
  }

  const data = transaction.data ?? "0x";
  const isEmpty = data === "0x";
  const isRelease = nonce === authorization.nonceStart;
  const isSeal = isEmpty && !isRelease && !isSweep;
  const value = transaction.value ?? 0n;
  if (isSweep) {
    if (!isEmpty) throw new Error("Sweep transaction must be empty");
    if (
      !transaction.to ||
      getAddress(transaction.to) !== authorization.operator
    ) {
      throw new Error("Sweep transaction must return funds to the operator");
    }
  } else {
    if (
      !transaction.to ||
      getAddress(transaction.to) !== authorization.sessionAddress
    ) {
      throw new Error("Transaction recipient must be the session wallet");
    }
    if (value !== 0n) {
      throw new Error("Media and cleanup transactions cannot transfer ETH");
    }
  }
  let packetSequence: number | undefined;
  if (isRelease && !isEmpty) {
    throw new Error("The nonce-gap release transaction must be empty");
  }
  if (!isEmpty) {
    const byteLength = hexToBytes(data).length;
    const maxEnvelopeBytes =
      authorization.maxPayloadBytes + PATIO_PACKET_OVERHEAD_BYTES;
    if (byteLength > maxEnvelopeBytes) {
      throw new Error("Patio calldata exceeds the authorized packet size");
    }
    const packet = packetFromHex(data);
    if (packet.streamId !== authorization.streamId) {
      throw new Error("Patio packet belongs to a different stream");
    }
    const expectedWindow = Number(nonce - authorization.nonceStart - 1n);
    if (packet.windowIndex !== expectedWindow) {
      throw new Error("Patio packet window does not match its nonce");
    }
    packetSequence = packet.sequence;
  }

  const maxFeePerGasWei = transaction.maxFeePerGas ?? 0n;
  const maxPriorityFeePerGasWei = transaction.maxPriorityFeePerGas ?? 0n;
  if (
    maxFeePerGasWei <= 0n ||
    maxPriorityFeePerGasWei <= 0n ||
    maxPriorityFeePerGasWei > maxFeePerGasWei ||
    maxFeePerGasWei > authorization.maxFeePerGasWei
  ) {
    throw new Error("Transaction fees violate the signed session policy");
  }

  const gas = transaction.gas ?? 0n;
  if (gas <= 0n || gas > MEDIA_TRANSACTION_GAS) {
    throw new Error("Transaction gas limit is outside the relay policy");
  }
  if (isEmpty && gas !== 21_000n) {
    throw new Error("Empty cleanup transactions must use exactly 21000 gas");
  }
  const maximumCostWei = gas * maxFeePerGasWei + value;
  const previous = state.byNonce.get(nonce);
  if (previous) {
    if (previous.sealed) {
      throw new Error("A sealed nonce cannot accept more replacements");
    }
    if (previous.replacements >= authorization.maxReplacementsPerWindow) {
      throw new Error("Nonce replacement limit reached");
    }
    if (
      maxFeePerGasWei < bumpByBps(previous.maxFeePerGasWei, bumpBps) ||
      maxPriorityFeePerGasWei <
        bumpByBps(previous.maxPriorityFeePerGasWei, bumpBps)
    ) {
      throw new Error("Replacement fees do not satisfy the required bump");
    }
  }

  const projectedByNonce = new Map(state.byNonce);
  projectedByNonce.set(nonce, {
    replacements: (previous?.replacements ?? 0) + 1,
    maxFeePerGasWei,
    maxPriorityFeePerGasWei,
    maximumCostWei,
    sealed: isSeal,
  });
  const projectedExposure = [...projectedByNonce.values()].reduce(
    (total, entry) => total + entry.maximumCostWei,
    0n,
  );
  if (projectedExposure > authorization.maxTotalExposureWei) {
    throw new Error("Transaction would exceed the session exposure ceiling");
  }

  state.byNonce = projectedByNonce;
  return {
    hashlessRawTransaction: rawTransaction,
    sender,
    nonce,
    data,
    isRelease,
    isSeal,
    isSweep,
    ...(packetSequence === undefined ? {} : { packetSequence }),
    maximumCostWei,
  };
}
