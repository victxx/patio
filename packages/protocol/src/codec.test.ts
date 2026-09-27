import { describe, expect, it } from "vitest";

import {
  createStreamId,
  decodePatioPacket,
  encodePatioPacket,
  PatioCodec,
  PatioPacketError,
  PatioPacketType,
  reconstructPackets,
  type PatioPacketV1,
} from "./index";

function packet(sequence = 0): PatioPacketV1 {
  return {
    version: 1,
    type: sequence === 0 ? PatioPacketType.START : PatioPacketType.AUDIO,
    codec: PatioCodec.OPUS_WEBM,
    flags: 0,
    streamId: createStreamId("patio-test-stream"),
    windowIndex: Math.floor(sequence / 20),
    sequence,
    capturedAtMs: 1_785_000_000_000n + BigInt(sequence),
    payload: new TextEncoder().encode(`audio-${sequence}`),
  };
}

describe("PatioPacketV1", () => {
  it("round-trips every field through the binary envelope", () => {
    const original = packet(12);
    const decoded = decodePatioPacket(encodePatioPacket(original));
    expect(decoded).toMatchObject({
      ...original,
      payload: original.payload,
    });
    expect(decoded.checksum).toMatch(/^0x[\da-f]{64}$/);
  });

  it("rejects corrupt payloads", () => {
    const encoded = encodePatioPacket(packet());
    encoded[45] = (encoded[45] ?? 0) ^ 0xff;
    expect(() => decodePatioPacket(encoded)).toThrow(PatioPacketError);
  });

  it("rejects oversized and malformed envelopes", () => {
    expect(() =>
      encodePatioPacket({
        ...packet(),
        payload: new Uint8Array(8 * 1024 + 1),
      }),
    ).toThrow(/exceeds/);
    expect(() => decodePatioPacket(new Uint8Array(12))).toThrow(/shorter/);
  });

  it("orders, deduplicates, and reports dropped packets", () => {
    const decoded = [0, 1, 3, 3, 4].map((sequence) =>
      decodePatioPacket(encodePatioPacket(packet(sequence))),
    );
    const result = reconstructPackets([decoded[3]!, decoded[0]!, ...decoded]);
    expect(result.ordered.map(({ sequence }) => sequence)).toEqual([
      0, 1, 3, 4,
    ]);
    expect(result.missingSequences).toEqual([2]);
    expect(result.duplicateCount).toBe(3);
  });

  it("orders across uint32 sequence wrap without expanding a hostile gap", () => {
    const wrapped = [0xffff_fffe, 0xffff_ffff, 0, 2].map((sequence) =>
      decodePatioPacket(
        encodePatioPacket({
          ...packet(sequence),
          type: PatioPacketType.AUDIO,
        }),
      ),
    );
    const result = reconstructPackets([
      wrapped[2]!,
      wrapped[0]!,
      wrapped[3]!,
      wrapped[1]!,
    ]);
    expect(result.ordered.map(({ sequence }) => sequence)).toEqual([
      0xffff_fffe, 0xffff_ffff, 0, 2,
    ]);
    expect(result.missingSequences).toEqual([1]);
  });

  it("reconstructs randomized inputs with at least five percent loss", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      let state = seed;
      const random = () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state;
      };
      const source = Array.from({ length: 200 }, (_, sequence) => sequence);
      const missing = new Set(
        source.filter((sequence) => sequence % 20 === seed % 20),
      );
      const received = source
        .filter((sequence) => !missing.has(sequence))
        .map((sequence) =>
          decodePatioPacket(encodePatioPacket(packet(sequence))),
        )
        .toSorted(() => (random() % 3) - 1);
      const result = reconstructPackets(received);
      expect(result.ordered.map(({ sequence }) => sequence)).toEqual(
        source.filter((sequence) => !missing.has(sequence)),
      );
      expect(result.missingSequences).toEqual(
        source.slice(1, -1).filter((sequence) => missing.has(sequence)),
      );
    }
  });
});
