import { describe, expect, it } from "vitest";

import { mediaCapacityDecision } from "./media-capacity";

describe("media packet capacity", () => {
  it("accepts the twentieth packet but rejects a recorder tail as unsent", () => {
    expect(mediaCapacityDecision(19, 20)).toEqual({
      allowed: true,
      remainingPackets: 1,
    });
    expect(mediaCapacityDecision(20, 20)).toEqual({
      allowed: false,
      remainingPackets: 0,
      reason: "packet-capacity-exhausted",
    });
  });
});
