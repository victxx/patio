import {
  createReplacementFeeLadder,
  MEDIA_TRANSACTION_GAS,
} from "@patio/ethereum";

export const RETIREMENT_MODE = "single-nonce-retirement-v1" as const;
export const RETIREMENT_DEFAULT_BUDGET = 500_000_000_000_000n;
export const RETIREMENT_HARD_CEILING = 5_000_000_000_000_000n;
export const RETIREMENT_CLOSE_GAS = 46_000n;
export const RETIREMENT_SWEEP_GAS = 21_000n;

/** One continuous 12.5% ladder. No window resets, no refund-based budget. */
export function quoteSingleNonce(input: {
  baseFee: bigint;
  priorityFee: bigint;
  candidates: number;
  budget?: bigint;
  packetDurationMs?: number;
}) {
  const budget = input.budget ?? RETIREMENT_DEFAULT_BUDGET;
  if (
    input.baseFee <= 0n ||
    input.priorityFee < 0n ||
    budget <= 0n ||
    !Number.isInteger(input.candidates) ||
    input.candidates < 1 ||
    input.candidates > 20 ||
    (input.packetDurationMs !== undefined &&
      ![1500, 3000].includes(input.packetDurationMs))
  )
    throw new Error("Invalid single-nonce quote");
  const tip =
    input.priorityFee > 1_000_000_000n ? input.priorityFee : 1_000_000_000n;
  const closeFee = input.baseFee * 2n + tip;
  const mediaFees = Object.freeze(
    createReplacementFeeLadder(closeFee, input.candidates, 1250),
  );
  const mediaTips = Object.freeze(
    createReplacementFeeLadder(tip, input.candidates, 1250),
  );
  const mediaPeakCost = MEDIA_TRANSACTION_GAS * mediaFees.at(-1)!;
  const closeReserve = RETIREMENT_CLOSE_GAS * closeFee;
  const sweepReserve = RETIREMENT_SWEEP_GAS * closeFee;
  // Concurrent pool affordability: reserve the largest queued candidate PLUS close/sweep.
  const subtotal = mediaPeakCost + closeReserve + sweepReserve;
  const requiredExposure = (subtotal * 10_200n + 9_999n) / 10_000n;
  if (requiredExposure >= 1n << 256n)
    throw new Error("Quote exceeds numeric bounds");
  return Object.freeze({
    mode: RETIREMENT_MODE,
    candidates: input.candidates,
    mediaFees,
    mediaTips,
    mediaGas: MEDIA_TRANSACTION_GAS,
    closeFee,
    closeTip: tip,
    closeGas: RETIREMENT_CLOSE_GAS,
    sweepGas: RETIREMENT_SWEEP_GAS,
    mediaPeakCost,
    closeReserve,
    sweepReserve,
    requiredExposure,
    budget,
    safetyMargin: requiredExposure - subtotal,
    estimatedDurationSeconds:
      (input.candidates * (input.packetDurationMs ?? 3000)) / 1000,
    allowed:
      requiredExposure <= budget && requiredExposure <= RETIREMENT_HARD_CEILING,
  });
}
export type SingleNoncePlan = ReturnType<typeof quoteSingleNonce>;

export function affordableSingleNonce(
  input: Parameters<typeof quoteSingleNonce>[0],
) {
  for (let candidates = input.candidates; candidates >= 1; candidates--) {
    const plan = quoteSingleNonce({ ...input, candidates });
    if (plan.allowed) return plan;
  }
  throw new Error(
    "No single-nonce candidate fits the selected exposure; budget unchanged",
  );
}
