import {
  PATIO_DEFAULTS,
  PATIO_NETWORK_PROFILES,
  type PatioNetworkProfile,
} from "@patio/config";
import { PATIO_PACKET_OVERHEAD_BYTES } from "@patio/protocol";

export const EMPTY_TRANSACTION_GAS = 21_000n;
const EIP_7623_TOTAL_COST_FLOOR_PER_TOKEN = 10n;
const NON_ZERO_CALLDATA_TOKENS_PER_BYTE = 4n;
const MAX_MEDIA_CALLDATA_BYTES = BigInt(
  PATIO_DEFAULTS.maxPacketPayloadBytes + PATIO_PACKET_OVERHEAD_BYTES,
);

// Hoodi includes Pectra/EIP-7623. Reserve the worst-case calldata floor so a
// packet remains valid even when every envelope byte is non-zero.
export const MEDIA_TRANSACTION_GAS =
  EMPTY_TRANSACTION_GAS +
  EIP_7623_TOTAL_COST_FLOOR_PER_TOKEN *
    NON_ZERO_CALLDATA_TOKENS_PER_BYTE *
    MAX_MEDIA_CALLDATA_BYTES;

export interface FeePlanInput {
  baseFeePerGasWei: bigint;
  priorityFeePerGasWei: bigint;
  networkProfile?: PatioNetworkProfile;
  budgetWei?: bigint;
  bumpBps?: number;
  chunkDurationMs?: number;
  minimumPropagationTipWei?: bigint;
  replacementsPerWindow?: number;
  requestedWindows?: number;
}

export interface FeePlan {
  baseFeePerGasWei: bigint;
  mediaFeeLadderWei: bigint[];
  mediaPriorityFeeLadderWei: bigint[];
  sealMaxFeePerGasWei: bigint;
  sealPriorityFeePerGasWei: bigint;
  windows: number;
  affordableDurationSeconds: number;
  cleanupCostWei: bigint;
  mediaPeakCostWei: bigint;
  maximumExposureWei: bigint;
  canStart: boolean;
}

export function bumpByBps(value: bigint, bumpBps: number): bigint {
  if (value < 0n || bumpBps < 0 || !Number.isInteger(bumpBps)) {
    throw new Error(
      "Fee values and bump basis points must be non-negative integers",
    );
  }
  const numerator = value * BigInt(10_000 + bumpBps);
  return (numerator + 9_999n) / 10_000n;
}

export function createReplacementFeeLadder(
  startFeeWei: bigint,
  count: number,
  bumpBps: number = PATIO_DEFAULTS.replacementBumpBps,
): bigint[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Replacement count must be a positive integer");
  }
  const fees = [startFeeWei];
  while (fees.length < count) {
    fees.push(bumpByBps(fees.at(-1) ?? startFeeWei, bumpBps));
  }
  return fees;
}

export function createFeePlan(input: FeePlanInput): FeePlan {
  const networkProfile = input.networkProfile ?? PATIO_NETWORK_PROFILES.hoodi;
  const requestedBudgetWei =
    input.budgetWei ?? networkProfile.safety.maximumSessionExposureWei;
  const budgetWei =
    requestedBudgetWei > networkProfile.safety.maximumSessionExposureWei
      ? networkProfile.safety.maximumSessionExposureWei
      : requestedBudgetWei;
  const bumpBps = input.bumpBps ?? networkProfile.transport.replacementBumpBps;
  const chunkDurationMs =
    input.chunkDurationMs ?? PATIO_DEFAULTS.chunkDurationMs;
  const replacementsPerWindow =
    input.replacementsPerWindow ??
    networkProfile.transport.maxReplacementsPerWindow;
  const requestedWindows = Math.min(
    input.requestedWindows ?? networkProfile.transport.maxWindowsPerEpoch,
    networkProfile.transport.maxWindowsPerEpoch,
  );

  if (input.baseFeePerGasWei <= 0n || input.priorityFeePerGasWei < 0n) {
    throw new Error(
      "Base fee must be positive and priority fee cannot be negative",
    );
  }

  const minimumPropagationTipWei =
    input.minimumPropagationTipWei ??
    networkProfile.transport.minimumPropagationTipWei;
  const mediaStartPriorityFee = minimumPropagationTipWei;
  const mediaStartFee = input.baseFeePerGasWei * 2n + mediaStartPriorityFee;
  const mediaFeeLadderWei = createReplacementFeeLadder(
    mediaStartFee,
    replacementsPerWindow,
    bumpBps,
  );
  const mediaPriorityFeeLadderWei = createReplacementFeeLadder(
    mediaStartPriorityFee,
    replacementsPerWindow,
    bumpBps,
  );
  const lastMediaFee = mediaFeeLadderWei.at(-1) ?? mediaStartFee;
  const lastMediaPriorityFee =
    mediaPriorityFeeLadderWei.at(-1) ?? mediaStartPriorityFee;
  const minimumSealReplacementFee = bumpByBps(lastMediaFee, bumpBps);
  const minimumSealPriorityFee = bumpByBps(lastMediaPriorityFee, bumpBps);
  const sealPriorityFeePerGasWei =
    input.priorityFeePerGasWei > minimumSealPriorityFee
      ? input.priorityFeePerGasWei
      : minimumSealPriorityFee;
  const inclusionFee = input.baseFeePerGasWei * 2n + sealPriorityFeePerGasWei;
  const sealMaxFeePerGasWei =
    inclusionFee > minimumSealReplacementFee
      ? inclusionFee
      : minimumSealReplacementFee;

  const oneCleanupCost = EMPTY_TRANSACTION_GAS * sealMaxFeePerGasWei;
  const lastMediaCost = MEDIA_TRANSACTION_GAS * lastMediaFee;
  let windows = 0;
  for (let candidate = 1; candidate <= requestedWindows; candidate += 1) {
    const cleanupCost = BigInt(candidate + 2) * oneCleanupCost;
    const mediaPeakCost =
      BigInt(candidate - 1) * oneCleanupCost + lastMediaCost;
    if (cleanupCost > budgetWei || mediaPeakCost > budgetWei) break;
    windows = candidate;
  }
  const cleanupCostWei =
    windows === 0 ? 0n : BigInt(windows + 2) * oneCleanupCost;
  const mediaPeakCostWei =
    windows === 0 ? 0n : BigInt(windows - 1) * oneCleanupCost + lastMediaCost;
  const maximumExposureWei =
    cleanupCostWei > mediaPeakCostWei ? cleanupCostWei : mediaPeakCostWei;
  const affordableDurationSeconds = Math.floor(
    (windows * replacementsPerWindow * chunkDurationMs) / 1_000,
  );

  return {
    baseFeePerGasWei: input.baseFeePerGasWei,
    mediaFeeLadderWei,
    mediaPriorityFeeLadderWei,
    sealMaxFeePerGasWei,
    sealPriorityFeePerGasWei,
    windows,
    affordableDurationSeconds,
    cleanupCostWei,
    mediaPeakCostWei,
    maximumExposureWei,
    canStart:
      affordableDurationSeconds >= PATIO_DEFAULTS.minSafeDurationSeconds &&
      maximumExposureWei <= budgetWei,
  };
}
