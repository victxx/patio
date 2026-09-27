import { expect, it } from "vitest";
import { compactFixtureSnapshot } from "./full-app-metadata";
import type { SingleNonceTransport } from "../../lib/single-nonce-transport";

function sample() {
  const input = {
    mode: "single-nonce-retirement-v1",
    state: "prepared",
    g: 0,
    m: 1,
    s: 2,
    frozenAtMonotonicMs: null,
    capacity: 4,
    funded: true,
    fundingAttempted: true,
    descriptor: {
      version: 1,
      chainId: 1337,
      operator: `0x${"1".repeat(40)}`,
      sessionAddress: `0x${"2".repeat(40)}`,
      streamId: `0x${"3".repeat(32)}`,
      nonceStart: "0",
      transportMode: "single-nonce-retirement-v1",
      privateKey: "SECRET",
    },
    signatures: [],
    receipts: [],
    events: [],
    plan: {
      capacity: 4,
      mediaFees: ["1"],
      mediaTips: ["1"],
      requiredExposure: "1",
      closeReserve: "1",
      sweepReserve: "1",
      estimatedDurationSeconds: 12,
      calldata: "SECRET",
    },
    rawTransaction: "SECRET",
    media: "SECRET",
    serviceUrl: "SECRET",
  };
  return input as unknown as ReturnType<SingleNonceTransport["snapshot"]>;
}
it("H2.6 bridge exports only compact metadata, not unknown or sensitive fields", () => {
  const safe = compactFixtureSnapshot(sample());
  expect(JSON.stringify(safe)).not.toContain("SECRET");
  expect(safe.plan.capacity).toBe(4);
  expect(safe.signatures).toEqual([]);
});
it("H2.6 bridge refuses unbounded metadata", () => {
  const input = sample();
  input.events = Array.from({ length: 129 }, () => ({
    stage: "poll",
    atMonotonicMs: 0,
  }));
  expect(() => compactFixtureSnapshot(input)).toThrow("bounds");
});
