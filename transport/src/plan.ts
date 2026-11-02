/** Nonce 0 stays unsent, so media at higher nonces cannot execute. */
export function mediaNonce(
  sequence: number,
  replacementsPerWindow: number,
  gapNonce = 0,
): number {
  return gapNonce + 1 + Math.floor(sequence / replacementsPerWindow);
}

/** A replacement must pay more: +12.5%, rounded up. */
export function bumpFee(feeWei: bigint): bigint {
  return (feeWei * 11_250n + 9_999n) / 10_000n;
}

/** Fixed for a session, so every packet up to `maxPayloadBytes` fits. */
export function mediaGas(maxPayloadBytes: number): bigint {
  return 21_000n + 40n * BigInt(maxPayloadBytes + 76);
}
