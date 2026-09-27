import { describe, expect, it } from "vitest";
import { retirementPresentation } from "./retirement-presentation";
import type { SingleNonceTransport } from "./single-nonce-transport";
type Snapshot = ReturnType<SingleNonceTransport["snapshot"]>;
const hash = `0x${"1".repeat(64)}` as const;
const sweepHash = `0x${"2".repeat(64)}` as const;
const snapshot = {
  mode: "single-nonce-retirement-v1",
  state: "sweep-pending",
  funded: true,
  fundingAttempted: true,
  g: 0,
  m: 1,
  s: 2,
  capacity: 4,
  signatures: [],
  frozenAtMonotonicMs: 1,
  descriptor: {
    version: 1,
    chainId: 1337,
    operator: `0x${"1".repeat(40)}`,
    sessionAddress: `0x${"2".repeat(40)}`,
    streamId: `0x${"1".repeat(32)}`,
    nonceStart: "0",
  },
  plan: {
    capacity: 4,
    mediaFees: [],
    mediaTips: [],
    requiredExposure: "1000000000000000",
    closeReserve: "100",
    sweepReserve: "100",
    estimatedDurationSeconds: 12,
  },
  closeHash: hash,
  sweepHash,
  receipts: [],
  events: [],
} as Snapshot;
const receipt = {
  transactionHash: hash,
  blockHash: hash,
  blockNumber: "0x1",
  status: "0x1",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x1",
} as const;
describe("D3 compact canonical close presentation", () => {
  it("a sweep hash or phase is not a confirmed return; unknown is not zero", () => {
    const result = retirementPresentation(snapshot);
    expect(result.message).toBe("Return pending verification");
    expect(result.returnVerified).toBe(false);
    expect(result.sweepGas).toBe("Unknown");
    expect(result.returned).toContain("Unknown");
    expect(result.residual).toContain("Unknown");
  });
  it("uses unique receipts for exact bigint gas, not maximum reserves or bundle estimates", () => {
    const result = retirementPresentation({
      ...snapshot,
      state: "complete",
      receipts: [receipt, receipt, { ...receipt, transactionHash: sweepHash }],
    });
    expect(result.complete).toBe(true);
    expect(result.closeGas).toBe("0.000000000000021 private ETH");
    expect(result.sweepGas).toBe(result.closeGas);
    expect(result.fundingGas).toContain("separately");
    expect(result.residual).not.toContain("100%");
  });
  it("media inclusion is permanent safety failure even after a later complete sweep", () => {
    const result = retirementPresentation({
      ...snapshot,
      state: "complete",
      receipts: [receipt, { ...receipt, transactionHash: sweepHash }],
      events: [
        {
          stage: "safety-failed",
          status: "canonical-media-inclusion",
          atMonotonicMs: 1,
        },
      ],
    });
    expect(result.message).toBe("Safety failure");
    expect(result.complete).toBe(false);
    expect(result.needsAttention).toBe(true);
  });
  it("invalidated canonical evidence cannot retain a success label or cost verification", () => {
    const result = retirementPresentation({
      ...snapshot,
      state: "held-close-uncertain",
      receipts: [receipt],
      events: [
        {
          stage: "held-close-uncertain",
          errorClass: "canonical-evidence-invalidated",
          atMonotonicMs: 2,
        },
      ],
    });
    expect(result.closeVerified).toBe(false);
    expect(result.closeGas).toBe("Unknown");
    expect(result.complete).toBe(false);
  });
  it("reverted sweep is not money returned; complete without receipts needs review", () => {
    expect(
      retirementPresentation({
        ...snapshot,
        state: "held-after-close",
        receipts: [
          receipt,
          { ...receipt, transactionHash: sweepHash, status: "0x0" },
        ],
      }).returnVerified,
    ).toBe(false);
    expect(
      retirementPresentation({ ...snapshot, state: "complete" }).message,
    ).toBe("Completion needs verification");
  });
});
