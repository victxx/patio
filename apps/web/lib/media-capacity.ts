export type MediaCapacityDecision =
  | { allowed: true; remainingPackets: number }
  | {
      allowed: false;
      remainingPackets: number;
      reason: "packet-capacity-exhausted";
    };

export function mediaCapacityDecision(
  nextSequence: number,
  totalPackets: number,
): MediaCapacityDecision {
  const remainingPackets = Math.max(0, totalPackets - nextSequence);
  return remainingPackets > 0
    ? { allowed: true, remainingPackets }
    : {
        allowed: false,
        remainingPackets,
        reason: "packet-capacity-exhausted",
      };
}
