import {
  PATIO_DEFAULTS,
  PATIO_NETWORK_PROFILES,
  type PatioNetworkProfile,
} from "@patio/config";
import {
  EMPTY_TRANSACTION_GAS,
  MEDIA_TRANSACTION_GAS,
  createFeePlan,
  type FeePlan,
} from "@patio/ethereum";

const MIN_DIRECT_REPLACEMENTS = 5;
const BASIS_POINTS = 10_000n;
const FUNDING_TRANSACTION_GAS = 21_000n;
const REGISTRY_ANNOUNCEMENT_GAS_ESTIMATE = 80_000n;

export const DEFAULT_DIRECT_BUDGET_WEI =
  PATIO_NETWORK_PROFILES.hoodi.safety.defaultSessionBudgetWei;
export const MIN_DIRECT_BUDGET_WEI = 100_000_000_000_000n;
export const DIRECT_FUNDING_SAFETY_MARGIN_BPS = 200n;
export const DIRECT_PLAIN_EOA_SWEEP_GAS = EMPTY_TRANSACTION_GAS;

export interface DirectFeePlan {
  feePlan: FeePlan;
  replacementsPerWindow: number;
  requiredFundingWei: bigint;
  safetyMarginWei: bigint;
}

export interface DirectNetworkCostEstimate {
  cleanupWei: bigint;
  fundingWei: bigint;
  registryWei: bigint;
  totalWei: bigint;
}

export type DirectPlanControlMode = "budget" | "duration";
export type DirectExposurePolicy = "historical" | "classic-per-nonce-v2";

/** Preserve the shared ladder and historical fixtures. Only new classic sessions
 * opt into cumulative canonical gas exposure; replacements compete per nonce. */
export function classicExposurePlan(
  feePlan: FeePlan,
): FeePlan & { exposurePolicy: "classic-per-nonce-v2" } {
  const media =
    MEDIA_TRANSACTION_GAS * (feePlan.mediaFeeLadderWei.at(-1) ?? 0n);
  const empty = EMPTY_TRANSACTION_GAS * feePlan.sealMaxFeePerGasWei;
  const maximumExposureWei =
    feePlan.windows === 0
      ? 0n
      : BigInt(feePlan.windows) * (media > empty ? media : empty) + 2n * empty;
  return {
    ...feePlan,
    maximumExposureWei,
    exposurePolicy: "classic-per-nonce-v2",
  };
}

function ceilingBps(value: bigint, bps: bigint): bigint {
  return (value * bps + BASIS_POINTS - 1n) / BASIS_POINTS;
}

export function directFundingRequirement(feePlan: FeePlan): {
  requiredFundingWei: bigint;
  safetyMarginWei: bigint;
} {
  const safetyMarginWei = ceilingBps(
    feePlan.maximumExposureWei,
    DIRECT_FUNDING_SAFETY_MARGIN_BPS,
  );
  return {
    safetyMarginWei,
    requiredFundingWei: feePlan.maximumExposureWei + safetyMarginWei,
  };
}

/**
 * Keeps the direct media plan untouched while allowing a reviewed setup path
 * to reserve more than 21k only for a code-bearing return recipient.
 */
export function directFundingRequirementForSweepGas(
  feePlan: FeePlan,
  sweepGasLimit: bigint = DIRECT_PLAIN_EOA_SWEEP_GAS,
): {
  cleanupReserveWei: bigint;
  maximumExposureWei: bigint;
  requiredFundingWei: bigint;
  safetyMarginWei: bigint;
} {
  if (sweepGasLimit < DIRECT_PLAIN_EOA_SWEEP_GAS) {
    throw new Error(
      "Sweep gas limit cannot be lower than the plain EOA limit.",
    );
  }
  const extraSweepReserveWei =
    (sweepGasLimit - DIRECT_PLAIN_EOA_SWEEP_GAS) * feePlan.sealMaxFeePerGasWei;
  const cleanupReserveWei = feePlan.cleanupCostWei + extraSweepReserveWei;
  const historicalExposureWei =
    cleanupReserveWei > feePlan.mediaPeakCostWei
      ? cleanupReserveWei
      : feePlan.mediaPeakCostWei;
  // The explicit classic plan can be larger than the historical peak/cleanup.
  const cumulativeExposureWei =
    feePlan.maximumExposureWei + extraSweepReserveWei;
  const maximumExposureWei =
    "exposurePolicy" in feePlan &&
    feePlan.exposurePolicy === "classic-per-nonce-v2" &&
    cumulativeExposureWei > historicalExposureWei
      ? cumulativeExposureWei
      : historicalExposureWei;
  const safetyMarginWei = ceilingBps(
    maximumExposureWei,
    DIRECT_FUNDING_SAFETY_MARGIN_BPS,
  );
  return {
    cleanupReserveWei,
    maximumExposureWei,
    safetyMarginWei,
    requiredFundingWei: maximumExposureWei + safetyMarginWei,
  };
}

function cappedBudget(
  budgetWei: bigint,
  networkProfile: PatioNetworkProfile,
): bigint {
  if (budgetWei <= 0n) return 0n;
  return budgetWei > networkProfile.safety.maximumSessionExposureWei
    ? networkProfile.safety.maximumSessionExposureWei
    : budgetWei;
}

function candidatePlans(
  baseFeePerGasWei: bigint,
  priorityFeePerGasWei: bigint,
  budgetWei: bigint,
  chunkDurationMs: number,
  networkProfile: PatioNetworkProfile,
  policy: DirectExposurePolicy,
): DirectFeePlan[] {
  const maximumBudgetWei = cappedBudget(budgetWei, networkProfile);
  if (maximumBudgetWei === 0n) return [];
  const candidates: DirectFeePlan[] = [];
  for (
    let replacementsPerWindow = MIN_DIRECT_REPLACEMENTS;
    replacementsPerWindow <= networkProfile.transport.maxReplacementsPerWindow;
    replacementsPerWindow += 1
  ) {
    for (
      let requestedWindows = 1;
      requestedWindows <= networkProfile.transport.maxWindowsPerEpoch;
      requestedWindows += 1
    ) {
      const historicalPlan = createFeePlan({
        baseFeePerGasWei,
        priorityFeePerGasWei,
        budgetWei: maximumBudgetWei,
        chunkDurationMs,
        requestedWindows,
        replacementsPerWindow,
        networkProfile,
      });
      const feePlan =
        policy === "classic-per-nonce-v2"
          ? classicExposurePlan(historicalPlan)
          : historicalPlan;
      if (feePlan.windows !== requestedWindows) continue;
      const funding = directFundingRequirement(feePlan);
      if (funding.requiredFundingWei > maximumBudgetWei) continue;
      candidates.push({
        feePlan,
        replacementsPerWindow,
        ...funding,
      });
    }
  }
  return candidates;
}

export function createAffordableDirectPlan(
  baseFeePerGasWei: bigint,
  priorityFeePerGasWei: bigint,
  targetDurationSeconds: number,
  budgetWei: bigint | undefined = undefined,
  chunkDurationMs: number = PATIO_DEFAULTS.chunkDurationMs,
  networkProfile: PatioNetworkProfile = PATIO_NETWORK_PROFILES.hoodi,
  policy: DirectExposurePolicy = "historical",
): DirectFeePlan | null {
  const selectedBudgetWei =
    budgetWei ?? networkProfile.safety.maximumSessionExposureWei;
  let best: DirectFeePlan | null = null;
  for (const candidate of candidatePlans(
    baseFeePerGasWei,
    priorityFeePerGasWei,
    selectedBudgetWei,
    chunkDurationMs,
    networkProfile,
    policy,
  )) {
    const duration = candidate.feePlan.affordableDurationSeconds;
    if (duration > targetDurationSeconds) continue;
    const bestDuration = best?.feePlan.affordableDurationSeconds ?? 0;
    if (
      duration > bestDuration ||
      (duration === bestDuration &&
        candidate.requiredFundingWei <
          (best?.requiredFundingWei ??
            networkProfile.safety.maximumSessionExposureWei + 1n))
    ) {
      best = candidate;
    }
  }
  return best;
}

export function createRequiredDirectPlan(
  baseFeePerGasWei: bigint,
  priorityFeePerGasWei: bigint,
  requestedDurationSeconds: number,
  budgetCeilingWei: bigint | undefined = undefined,
  chunkDurationMs: number = PATIO_DEFAULTS.chunkDurationMs,
  networkProfile: PatioNetworkProfile = PATIO_NETWORK_PROFILES.hoodi,
  policy: DirectExposurePolicy = "historical",
): DirectFeePlan | null {
  const selectedBudgetCeilingWei =
    budgetCeilingWei ?? networkProfile.safety.maximumSessionExposureWei;
  let best: DirectFeePlan | null = null;
  for (const candidate of candidatePlans(
    baseFeePerGasWei,
    priorityFeePerGasWei,
    selectedBudgetCeilingWei,
    chunkDurationMs,
    networkProfile,
    policy,
  )) {
    const duration = candidate.feePlan.affordableDurationSeconds;
    if (duration < requestedDurationSeconds) continue;
    if (
      !best ||
      candidate.requiredFundingWei < best.requiredFundingWei ||
      (candidate.requiredFundingWei === best.requiredFundingWei &&
        duration < best.feePlan.affordableDurationSeconds)
    ) {
      best = candidate;
    }
  }
  return best;
}

export function estimateDirectNetworkCost(
  plan: DirectFeePlan,
  currentPriorityFeePerGasWei: bigint,
  includesRegistry: boolean,
): DirectNetworkCostEstimate {
  const cleanupGasPriceCandidate =
    plan.feePlan.baseFeePerGasWei + plan.feePlan.sealPriorityFeePerGasWei;
  const cleanupGasPrice =
    cleanupGasPriceCandidate < plan.feePlan.sealMaxFeePerGasWei
      ? cleanupGasPriceCandidate
      : plan.feePlan.sealMaxFeePerGasWei;
  const setupGasPrice =
    plan.feePlan.baseFeePerGasWei + currentPriorityFeePerGasWei;
  const cleanupWei =
    BigInt(plan.feePlan.windows + 2) * EMPTY_TRANSACTION_GAS * cleanupGasPrice;
  const fundingWei = FUNDING_TRANSACTION_GAS * setupGasPrice;
  const registryWei = includesRegistry
    ? REGISTRY_ANNOUNCEMENT_GAS_ESTIMATE * setupGasPrice
    : 0n;
  return {
    cleanupWei,
    fundingWei,
    registryWei,
    totalWei: cleanupWei + fundingWei + registryWei,
  };
}

export function directPlanRequiresReprepare(
  mode: DirectPlanControlMode,
  quotedPlan: DirectFeePlan | null,
  refreshedPlan: DirectFeePlan | null,
): boolean {
  if (!quotedPlan || !refreshedPlan) return true;
  if (mode === "budget") {
    return (
      refreshedPlan.feePlan.affordableDurationSeconds <
      quotedPlan.feePlan.affordableDurationSeconds
    );
  }
  return refreshedPlan.requiredFundingWei > quotedPlan.requiredFundingWei;
}
