import { PATIO_DEFAULTS, PATIO_NETWORK_PROFILES } from "@patio/config";
import { describe, expect, it } from "vitest";

import {
  bumpByBps,
  createFeePlan,
  createReplacementFeeLadder,
  MEDIA_TRANSACTION_GAS,
} from "./index";

describe("fee planning", () => {
  it("reserves the post-Pectra calldata floor for a maximum packet", () => {
    expect(MEDIA_TRANSACTION_GAS).toBe(351_720n);
  });

  it("rounds every replacement bump upward", () => {
    expect(bumpByBps(1n, 1_250)).toBe(2n);
    expect(bumpByBps(100n, 1_250)).toBe(113n);
    expect(createReplacementFeeLadder(100n, 3)).toEqual([100n, 113n, 128n]);
  });

  it("never authorizes more exposure than the hard budget", () => {
    const plan = createFeePlan({
      baseFeePerGasWei: 200_000_000n,
      priorityFeePerGasWei: 1_000_000_000n,
      budgetWei: PATIO_DEFAULTS.maxSessionExposureWei,
    });
    expect(plan.maximumExposureWei).toBeLessThanOrEqual(
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
    expect(plan.windows).toBeGreaterThanOrEqual(2);
    expect(plan.canStart).toBe(true);
    expect(plan.mediaPriorityFeeLadderWei[0]).toBe(
      PATIO_DEFAULTS.minPropagationTipWei,
    );
    expect(plan.cleanupCostWei).toBeLessThanOrEqual(
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
    expect(plan.mediaPeakCostWei).toBeLessThanOrEqual(
      PATIO_DEFAULTS.maxSessionExposureWei,
    );
  });

  it("fits the sixty-second minimum when Hoodi fees are low", () => {
    const plan = createFeePlan({
      baseFeePerGasWei: 1_040_000n,
      priorityFeePerGasWei: 75_000_000n,
      requestedWindows: 1,
    });
    const targetPayloadBytes = Math.ceil(
      (PATIO_DEFAULTS.audioBitsPerSecond * PATIO_DEFAULTS.chunkDurationMs) /
        8_000,
    );
    expect(plan.windows).toBe(1);
    expect(plan.affordableDurationSeconds).toBe(60);
    expect(plan.canStart).toBe(true);
    expect(targetPayloadBytes).toBeLessThan(
      PATIO_DEFAULTS.maxPacketPayloadBytes,
    );
  });

  it("refuses a session when fees cannot buy sixty seconds", () => {
    const plan = createFeePlan({
      baseFeePerGasWei: 100_000_000_000n,
      priorityFeePerGasWei: 2_000_000_000n,
    });
    expect(plan.canStart).toBe(false);
    expect(plan.affordableDurationSeconds).toBeLessThan(60);
  });

  it("does not apply a volatile inclusion tip to the media ladder", () => {
    const plan = createFeePlan({
      baseFeePerGasWei: 200_000_000n,
      priorityFeePerGasWei: 5_000_000_000n,
      requestedWindows: 2,
    });
    expect(plan.mediaPriorityFeeLadderWei[0]).toBe(
      PATIO_DEFAULTS.minPropagationTipWei,
    );
    expect(plan.sealPriorityFeePerGasWei).toBeGreaterThanOrEqual(
      5_000_000_000n,
    );
  });

  it("caps a Chiado plan with the selected network profile", () => {
    const networkProfile = PATIO_NETWORK_PROFILES.chiado;
    const plan = createFeePlan({
      baseFeePerGasWei: 1_040_000n,
      priorityFeePerGasWei: 75_000_000n,
      budgetWei: networkProfile.safety.maximumSessionExposureWei * 10n,
      networkProfile,
    });
    expect(plan.maximumExposureWei).toBeLessThanOrEqual(
      networkProfile.safety.maximumSessionExposureWei,
    );
    expect(plan.mediaPriorityFeeLadderWei[0]).toBe(
      networkProfile.transport.minimumPropagationTipWei,
    );
  });
});
