import {
  PatioPacketError,
  PatioPacketType,
  type DecodedPatioPacketV1,
} from "./types";

export interface ReconstructionResult {
  ordered: DecodedPatioPacketV1[];
  missingSequences: number[];
  duplicateCount: number;
}

const UINT32_RANGE = 0x1_0000_0000;
const MAX_REPORTED_GAP = 100_000;

function circularDistance(from: number, to: number): number {
  return (to - from + UINT32_RANGE) % UINT32_RANGE;
}

function inferAnchor(packets: readonly DecodedPatioPacketV1[]): number {
  const start = packets.find((packet) => packet.type === PatioPacketType.START);
  if (start) return start.sequence;

  const ascending = packets.toSorted(
    (left, right) => left.sequence - right.sequence,
  );
  let largestGap = -1;
  let anchor = ascending[0]?.sequence ?? 0;
  for (let index = 0; index < ascending.length; index += 1) {
    const current = ascending[index];
    const next = ascending[(index + 1) % ascending.length];
    if (!current || !next) continue;
    const gap = circularDistance(current.sequence, next.sequence);
    if (gap > largestGap) {
      largestGap = gap;
      anchor = next.sequence;
    }
  }
  return anchor;
}

export function reconstructPackets(
  packets: readonly DecodedPatioPacketV1[],
): ReconstructionResult {
  const bySequence = new Map<number, DecodedPatioPacketV1>();
  let duplicateCount = 0;

  for (const packet of packets) {
    if (bySequence.has(packet.sequence)) {
      duplicateCount += 1;
      continue;
    }
    bySequence.set(packet.sequence, packet);
  }

  const anchor = inferAnchor([...bySequence.values()]);
  const ordered = [...bySequence.values()].toSorted(
    (left, right) =>
      circularDistance(anchor, left.sequence) -
      circularDistance(anchor, right.sequence),
  );
  const missingSequences: number[] = [];
  if (ordered.length > 1) {
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (!previous || !current) continue;
      const gap = circularDistance(previous.sequence, current.sequence) - 1;
      if (gap > MAX_REPORTED_GAP) {
        throw new PatioPacketError(
          `Sequence gap ${gap} exceeds the reconstruction safety limit`,
        );
      }
      for (let offset = 1; offset <= gap; offset += 1) {
        missingSequences.push((previous.sequence + offset) % UINT32_RANGE);
      }
    }
  }

  return { ordered, missingSequences, duplicateCount };
}
