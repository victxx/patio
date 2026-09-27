import { PATIO_DEFAULTS } from "@patio/config";

import { PatioPacketError } from "./types";

const VIDEO_FRAGMENT_MAGIC = new Uint8Array([0x56, 0x46]);
const VIDEO_FRAGMENT_VERSION = 1;
export const PATIO_VIDEO_FRAGMENT_HEADER_BYTES = 16;
export const PATIO_MAX_VIDEO_SEGMENT_BYTES = 64 * 1024;
export const PATIO_MAX_PENDING_VIDEO_SEGMENTS = 8;
export const PATIO_VIDEO_FRAGMENT_DATA_BYTES =
  PATIO_DEFAULTS.maxPacketPayloadBytes - PATIO_VIDEO_FRAGMENT_HEADER_BYTES;
export const PATIO_MAX_VIDEO_FRAGMENTS = Math.ceil(
  PATIO_MAX_VIDEO_SEGMENT_BYTES / PATIO_VIDEO_FRAGMENT_DATA_BYTES,
);

const INITIALIZATION_FLAG = 1;

export interface VideoFragmentV1 {
  version: 1;
  segmentIndex: number;
  fragmentIndex: number;
  fragmentCount: number;
  segmentByteLength: number;
  initialization: boolean;
  data: Uint8Array;
}

export interface ReassembledVideoSegment {
  segmentIndex: number;
  initialization: boolean;
  bytes: Uint8Array;
}

export type VideoFragmentAssemblyResult =
  | { status: "pending"; receivedFragments: number; fragmentCount: number }
  | { status: "duplicate"; receivedFragments: number; fragmentCount: number }
  | { status: "complete"; segment: ReassembledVideoSegment };

function assertUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new PatioPacketError(`${name} must fit in uint32`);
  }
}

function expectedFragmentLength(
  segmentByteLength: number,
  fragmentIndex: number,
): number {
  const remaining =
    segmentByteLength - fragmentIndex * PATIO_VIDEO_FRAGMENT_DATA_BYTES;
  return Math.min(PATIO_VIDEO_FRAGMENT_DATA_BYTES, remaining);
}

export function fragmentVideoSegment(
  bytes: Uint8Array,
  segmentIndex: number,
  initialization = segmentIndex === 0,
): Uint8Array[] {
  assertUint32(segmentIndex, "Video segment index");
  if (bytes.length === 0) {
    throw new PatioPacketError("Video segment cannot be empty");
  }
  if (bytes.length > PATIO_MAX_VIDEO_SEGMENT_BYTES) {
    throw new PatioPacketError(
      `Video segment exceeds ${PATIO_MAX_VIDEO_SEGMENT_BYTES} bytes`,
    );
  }
  const fragmentCount = Math.ceil(
    bytes.length / PATIO_VIDEO_FRAGMENT_DATA_BYTES,
  );
  return Array.from({ length: fragmentCount }, (_, fragmentIndex) => {
    const start = fragmentIndex * PATIO_VIDEO_FRAGMENT_DATA_BYTES;
    return encodeVideoFragment({
      version: 1,
      segmentIndex,
      fragmentIndex,
      fragmentCount,
      segmentByteLength: bytes.length,
      initialization,
      data: bytes.slice(start, start + PATIO_VIDEO_FRAGMENT_DATA_BYTES),
    });
  });
}

export function encodeVideoFragment(fragment: VideoFragmentV1): Uint8Array {
  assertUint32(fragment.segmentIndex, "Video segment index");
  assertUint32(fragment.segmentByteLength, "Video segment byte length");
  if (fragment.version !== VIDEO_FRAGMENT_VERSION) {
    throw new PatioPacketError("Unsupported video fragment version");
  }
  if (
    !Number.isInteger(fragment.fragmentCount) ||
    fragment.fragmentCount < 1 ||
    fragment.fragmentCount > PATIO_MAX_VIDEO_FRAGMENTS
  ) {
    throw new PatioPacketError("Video fragment count is outside the limit");
  }
  if (
    !Number.isInteger(fragment.fragmentIndex) ||
    fragment.fragmentIndex < 0 ||
    fragment.fragmentIndex >= fragment.fragmentCount
  ) {
    throw new PatioPacketError("Video fragment index is invalid");
  }
  const expectedCount = Math.ceil(
    fragment.segmentByteLength / PATIO_VIDEO_FRAGMENT_DATA_BYTES,
  );
  const expectedLength = expectedFragmentLength(
    fragment.segmentByteLength,
    fragment.fragmentIndex,
  );
  if (
    fragment.segmentByteLength < 1 ||
    fragment.segmentByteLength > PATIO_MAX_VIDEO_SEGMENT_BYTES ||
    fragment.fragmentCount !== expectedCount ||
    fragment.data.length !== expectedLength
  ) {
    throw new PatioPacketError("Video fragment metadata is inconsistent");
  }

  const encoded = new Uint8Array(
    PATIO_VIDEO_FRAGMENT_HEADER_BYTES + fragment.data.length,
  );
  encoded.set(VIDEO_FRAGMENT_MAGIC, 0);
  encoded[2] = VIDEO_FRAGMENT_VERSION;
  encoded[3] = fragment.initialization ? INITIALIZATION_FLAG : 0;
  const view = new DataView(encoded.buffer);
  view.setUint32(4, fragment.segmentIndex, false);
  view.setUint16(8, fragment.fragmentIndex, false);
  view.setUint16(10, fragment.fragmentCount, false);
  view.setUint32(12, fragment.segmentByteLength, false);
  encoded.set(fragment.data, PATIO_VIDEO_FRAGMENT_HEADER_BYTES);
  return encoded;
}

export function decodeVideoFragment(bytes: Uint8Array): VideoFragmentV1 {
  if (bytes.length < PATIO_VIDEO_FRAGMENT_HEADER_BYTES) {
    throw new PatioPacketError("Video fragment is shorter than its header");
  }
  if (
    bytes[0] !== VIDEO_FRAGMENT_MAGIC[0] ||
    bytes[1] !== VIDEO_FRAGMENT_MAGIC[1]
  ) {
    throw new PatioPacketError("Video fragment has invalid magic bytes");
  }
  if (bytes[2] !== VIDEO_FRAGMENT_VERSION) {
    throw new PatioPacketError("Unsupported video fragment version");
  }
  const flags = bytes[3] ?? 0;
  if ((flags & ~INITIALIZATION_FLAG) !== 0) {
    throw new PatioPacketError("Video fragment has unsupported flags");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fragment: VideoFragmentV1 = {
    version: 1,
    segmentIndex: view.getUint32(4, false),
    fragmentIndex: view.getUint16(8, false),
    fragmentCount: view.getUint16(10, false),
    segmentByteLength: view.getUint32(12, false),
    initialization: (flags & INITIALIZATION_FLAG) !== 0,
    data: bytes.slice(PATIO_VIDEO_FRAGMENT_HEADER_BYTES),
  };
  // The encoder performs all structural validation without changing bytes.
  encodeVideoFragment(fragment);
  return fragment;
}

interface PendingSegment {
  fragmentCount: number;
  segmentByteLength: number;
  initialization: boolean;
  fragments: Map<number, Uint8Array>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export class VideoSegmentReassembler {
  private readonly pending = new Map<number, PendingSegment>();

  public constructor(
    private readonly maxPendingSegments = PATIO_MAX_PENDING_VIDEO_SEGMENTS,
  ) {
    if (!Number.isInteger(maxPendingSegments) || maxPendingSegments < 1) {
      throw new PatioPacketError(
        "Pending video segment limit must be positive",
      );
    }
  }

  public add(fragment: VideoFragmentV1): VideoFragmentAssemblyResult {
    // Re-validate caller-created objects, not only decoded wire input.
    encodeVideoFragment(fragment);
    let segment = this.pending.get(fragment.segmentIndex);
    if (!segment) {
      if (this.pending.size >= this.maxPendingSegments) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
        throw new PatioPacketError("Too many incomplete video segments");
      }
      segment = {
        fragmentCount: fragment.fragmentCount,
        segmentByteLength: fragment.segmentByteLength,
        initialization: fragment.initialization,
        fragments: new Map(),
      };
      this.pending.set(fragment.segmentIndex, segment);
    } else if (
      segment.fragmentCount !== fragment.fragmentCount ||
      segment.segmentByteLength !== fragment.segmentByteLength ||
      segment.initialization !== fragment.initialization
    ) {
      throw new PatioPacketError("Video fragment set metadata is inconsistent");
    }

    const duplicate = segment.fragments.get(fragment.fragmentIndex);
    if (duplicate) {
      if (!equalBytes(duplicate, fragment.data)) {
        throw new PatioPacketError("Duplicate video fragment bytes conflict");
      }
      return {
        status: "duplicate",
        receivedFragments: segment.fragments.size,
        fragmentCount: segment.fragmentCount,
      };
    }
    segment.fragments.set(fragment.fragmentIndex, fragment.data);
    if (segment.fragments.size !== segment.fragmentCount) {
      return {
        status: "pending",
        receivedFragments: segment.fragments.size,
        fragmentCount: segment.fragmentCount,
      };
    }

    const reconstructed = new Uint8Array(segment.segmentByteLength);
    let offset = 0;
    for (let index = 0; index < segment.fragmentCount; index += 1) {
      const data = segment.fragments.get(index);
      if (!data) {
        throw new PatioPacketError("Complete video fragment set has a gap");
      }
      reconstructed.set(data, offset);
      offset += data.length;
    }
    this.pending.delete(fragment.segmentIndex);
    return {
      status: "complete",
      segment: {
        segmentIndex: fragment.segmentIndex,
        initialization: segment.initialization,
        bytes: reconstructed,
      },
    };
  }

  public discardBefore(segmentIndex: number): void {
    for (const index of this.pending.keys()) {
      if (index < segmentIndex) this.pending.delete(index);
    }
  }

  public reset(): void {
    this.pending.clear();
  }

  public get pendingCount(): number {
    return this.pending.size;
  }
}
