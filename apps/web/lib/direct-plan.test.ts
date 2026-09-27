import { PATIO_DEFAULTS, PATIO_NETWORK_PROFILES } from "@patio/config";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIRECT_BUDGET_WEI,
  createAffordableDirectPlan,
  createRequiredDirectPlan,
  directFundingRequirement,
  directFundingRequirementForSweepGas,
  directPlanRequiresReprepare,
} from "./direct-plan";

describe("direct multi-window planning", () => {
  it("quotes 90 seconds with cumulative classic reserves under the requested Hoodi 0.09 ceiling", () => {
    const plan = createRequiredDirectPlan(
      1_000_000_000n,
      1_000_000_000n,
      90,
      undefined,
      3000,
      undefined,
      "classic-per-nonce-v2",
    );
    expect(plan).not.toBeNull();
    expect(plan!.feePlan.affordableDurationSeconds).toBeGreaterThanOrEqual(90);
    expect(plan!.requiredFundingWei).toBeLessThan(90_000_000_000_000_000n);
    expect(PATIO_NETWORK_PROFILES.chiado.safety.maximumSessionExposureWei).toBe(
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
  });
  it("reaches ninety seconds with the lowest-exposure packet layout", () => {
    const result = createAffordableDirectPlan(1_040_000n, 75_000_000n, 90);
    expect(result?.feePlan.affordableDurationSeconds).toBe(90);
    expect(result?.feePlan.windows).toBe(6);
    expect(result?.replacementsPerWindow).toBe(5);
  });

  it("never exceeds the requested duration or wallet exposure", () => {
    const result = createAffordableDirectPlan(
      954_781_631n,
      92_928_263n,
      180,
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
    expect(result).not.toBeNull();
    expect(result?.feePlan.affordableDurationSeconds).toBeLessThanOrEqual(180);
    expect(result?.feePlan.maximumExposureWei).toBeLessThanOrEqual(
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
  });

  it("plans real-video replacements using propagation-safe encoder segments", () => {
    const result = createAffordableDirectPlan(
      1_040_000n,
      75_000_000n,
      90,
      PATIO_DEFAULTS.maxSessionExposureWei,
      PATIO_DEFAULTS.videoTimesliceMs,
    );
    expect(result?.feePlan.affordableDurationSeconds).toBe(90);
    expect(result?.feePlan.maximumExposureWei).toBeLessThanOrEqual(
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
  });

  it("returns null when even the minimum window is unaffordable", () => {
    expect(
      createAffordableDirectPlan(
        100_000_000_000n,
        2_000_000_000n,
        60,
        PATIO_DEFAULTS.maxSessionExposureWei,
      ),
    ).toBeNull();
  });

  it("uses 0.0005 ETH as the default UI budget without changing the hard cap", () => {
    expect(DEFAULT_DIRECT_BUDGET_WEI).toBe(500_000_000_000_000n);
    expect(PATIO_DEFAULTS.maxSessionExposureWei).toBe(5_000_000_000_000_000n);
  });

  it("respects custom budgets and lower budgets never buy more duration", () => {
    const low = createAffordableDirectPlan(
      1_040_000n,
      75_000_000n,
      180,
      1_000_000_000_000_000n,
    );
    const high = createAffordableDirectPlan(
      1_040_000n,
      75_000_000n,
      180,
      2_500_000_000_000_000n,
    );
    expect(low?.requiredFundingWei).toBeLessThanOrEqual(1_000_000_000_000_000n);
    expect(high?.requiredFundingWei).toBeLessThanOrEqual(
      2_500_000_000_000_000n,
    );
    expect(low?.feePlan.affordableDurationSeconds ?? 0).toBeLessThanOrEqual(
      high?.feePlan.affordableDurationSeconds ?? 0,
    );
  });

  it("clamps planner exposure to the hard protocol ceiling", () => {
    const result = createAffordableDirectPlan(
      1_040_000n,
      75_000_000n,
      480,
      50_000_000_000_000_000n,
    );
    expect(result?.requiredFundingWei).toBeLessThanOrEqual(
      PATIO_NETWORK_PROFILES.hoodi.safety.maximumSessionExposureWei,
    );
  });

  it("finds the least-funded valid duration plan and rejects impossible duration", () => {
    const requested = createRequiredDirectPlan(1_040_000n, 75_000_000n, 90);
    expect(requested?.feePlan.affordableDurationSeconds).toBeGreaterThanOrEqual(
      90,
    );
    expect(
      createRequiredDirectPlan(1_040_000n, 75_000_000n, 10_000),
    ).toBeNull();
  });

  it("funds the selected plan plus a bounded two-percent safety margin", () => {
    const plan = createRequiredDirectPlan(1_040_000n, 75_000_000n, 60);
    expect(plan).not.toBeNull();
    const funding = directFundingRequirement(plan!.feePlan);
    expect(funding.requiredFundingWei).toBe(plan!.requiredFundingWei);
    expect(funding.safetyMarginWei).toBeGreaterThan(0n);
    expect(funding.requiredFundingWei).toBeLessThanOrEqual(
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
  });

  it("keeps plain-EOA funding unchanged and reserves extra gas only for a reviewed return path", () => {
    const plan = createRequiredDirectPlan(1_040_000n, 75_000_000n, 60);
    expect(plan).not.toBeNull();
    const plain = directFundingRequirementForSweepGas(plan!.feePlan);
    expect(plain.requiredFundingWei).toBe(plan!.requiredFundingWei);
    expect(plain.cleanupReserveWei).toBe(plan!.feePlan.cleanupCostWei);
    const codeBearing = directFundingRequirementForSweepGas(
      plan!.feePlan,
      60_000n,
    );
    expect(codeBearing.cleanupReserveWei).toBeGreaterThan(
      plain.cleanupReserveWei,
    );
    expect(codeBearing.requiredFundingWei).toBeGreaterThanOrEqual(
      plain.requiredFundingWei,
    );
  });

  it("requires a fresh review when gas makes the quote worse", () => {
    const quotedBudget = createAffordableDirectPlan(
      1_040_000n,
      75_000_000n,
      180,
      DEFAULT_DIRECT_BUDGET_WEI,
    );
    const refreshedBudget = createAffordableDirectPlan(
      2_000_000_000n,
      1_000_000_000n,
      180,
      DEFAULT_DIRECT_BUDGET_WEI,
    );
    expect(
      directPlanRequiresReprepare("budget", quotedBudget, refreshedBudget),
    ).toBe(true);

    const quotedDuration = createRequiredDirectPlan(
      1_040_000n,
      75_000_000n,
      60,
    );
    const refreshedDuration = createRequiredDirectPlan(
      2_000_000_000n,
      1_000_000_000n,
      60,
    );
    expect(
      directPlanRequiresReprepare(
        "duration",
        quotedDuration,
        refreshedDuration,
      ),
    ).toBe(true);
  });

  it("uses the selected Gnosis-family profile without Ethereum constants", () => {
    const chiado = {
      ...PATIO_NETWORK_PROFILES.chiado,
      safety: {
        ...PATIO_NETWORK_PROFILES.chiado.safety,
        maximumSessionExposureWei: 1_000_000_000_000_000n,
      },
    };
    const plan = createAffordableDirectPlan(
      1_040_000n,
      75_000_000n,
      90,
      undefined,
      PATIO_DEFAULTS.chunkDurationMs,
      chiado,
    );
    expect(plan).not.toBeNull();
    expect(plan?.feePlan.mediaPriorityFeeLadderWei[0]).toBe(
      chiado.transport.minimumPropagationTipWei,
    );
    expect(plan?.requiredFundingWei).toBeLessThanOrEqual(
      chiado.safety.maximumSessionExposureWei,
    );
    expect(chiado.safety.defaultSessionBudgetWei).toBe(500_000_000_000_000n);
  });
});
