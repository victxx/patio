import { PATIO_DEFAULTS } from "@patio/config";
import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";

import {
  createStreamId,
  decodeVideoFragment,
  encodePatioPacket,
  encodeVideoFragment,
  fragmentVideoSegment,
  packetFromHex,
  PatioCodec,
  PatioPacketError,
  PatioPacketType,
  VideoSegmentReassembler,
} from "./index";

function binarySegment(length = 20_000): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 47 + 13) % 256);
}

describe("real WebM video fragmentation", () => {
  it("round-trips arbitrary binary bytes exactly through Patio transaction input", () => {
    const original = binarySegment();
    const streamId = createStreamId("video-transaction-input");
    const assembler = new VideoSegmentReassembler();
    let reconstructed: Uint8Array | undefined;

    fragmentVideoSegment(original, 7).forEach((payload, fragmentIndex) => {
      const input = bytesToHex(
        encodePatioPacket({
          version: 1,
          type: PatioPacketType.VIDEO,
          codec: PatioCodec.WEBM_VP8_OPUS,
          flags: 0,
          streamId,
          windowIndex: 0,
          sequence: fragmentIndex,
          capturedAtMs: 1n,
          payload,
        }),
      );
      const packet = packetFromHex(input);
      const result = assembler.add(decodeVideoFragment(packet.payload));
      if (result.status === "complete") reconstructed = result.segment.bytes;
    });

    expect(reconstructed).toEqual(original);
  });

  it("reconstructs out-of-order fragments and ignores exact duplicates", () => {
    const original = binarySegment();
    const fragments = fragmentVideoSegment(original, 3).map(
      decodeVideoFragment,
    );
    const assembler = new VideoSegmentReassembler();
    expect(assembler.add(fragments[1]!)).toMatchObject({ status: "pending" });
    expect(assembler.add(fragments[1]!)).toMatchObject({ status: "duplicate" });
    expect(assembler.add(fragments[0]!)).toMatchObject({ status: "pending" });
    const result = assembler.add(fragments[2]!);
    expect(result).toMatchObject({ status: "complete" });
    if (result.status === "complete")
      expect(result.segment.bytes).toEqual(original);
  });

  it("does not output a segment with a missing fragment", () => {
    const fragments = fragmentVideoSegment(binarySegment(), 4).map(
      decodeVideoFragment,
    );
    const assembler = new VideoSegmentReassembler();
    expect(assembler.add(fragments[0]!)).toMatchObject({ status: "pending" });
    expect(assembler.add(fragments[2]!)).toMatchObject({ status: "pending" });
    expect(assembler.pendingCount).toBe(1);
  });

  it("rejects inconsistent sets and conflicting duplicates", () => {
    const [first] = fragmentVideoSegment(binarySegment(9_000), 5).map(
      decodeVideoFragment,
    );
    const assembler = new VideoSegmentReassembler();
    assembler.add(first!);
    expect(() =>
      assembler.add({ ...first!, initialization: !first!.initialization }),
    ).toThrow(PatioPacketError);
    expect(() =>
      assembler.add({
        ...first!,
        data: Uint8Array.from(first!.data, (value, index) =>
          index === 0 ? value ^ 0xff : value,
        ),
      }),
    ).toThrow(PatioPacketError);
  });

  it("never exceeds the Patio payload maximum", () => {
    const fragments = fragmentVideoSegment(binarySegment(64 * 1024), 9);
    expect(fragments.length).toBeGreaterThan(1);
    expect(
      fragments.every(
        (fragment) => fragment.length <= PATIO_DEFAULTS.maxPacketPayloadBytes,
      ),
    ).toBe(true);
  });

  it("rejects malformed fragment lengths", () => {
    const [encoded] = fragmentVideoSegment(binarySegment(9_000), 2);
    expect(() => decodeVideoFragment(encoded!.slice(0, -1))).toThrow(
      /inconsistent/,
    );
    const decoded = decodeVideoFragment(encoded!);
    expect(() => encodeVideoFragment({ ...decoded, fragmentCount: 1 })).toThrow(
      /inconsistent/,
    );
  });
});
