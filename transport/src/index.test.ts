import { describe, expect, it } from "vitest";

import { bumpFee, decodePacket, encodePacket, mediaGas, mediaNonce } from ".";

const packet = {
  type: 2,
  codec: 1,
  flags: 0,
  streamId: "0x00112233445566778899aabbccddeeff" as const,
  windowIndex: 3,
  sequence: 42,
  capturedAtMs: 1_700_000_000_000n,
  payload: new Uint8Array([1, 2, 3]),
};

describe("packets", () => {
  it("round-trips", () => {
    expect(decodePacket(encodePacket(packet))).toEqual(packet);
  });

  it("rejects a changed byte", () => {
    const changed = encodePacket(packet).replace(/..$/, "00") as `0x${string}`;
    expect(() => decodePacket(changed)).toThrow("Checksum");
  });
});

describe("plan", () => {
  it("moves to the next nonce after each window", () => {
    expect(mediaNonce(0, 10)).toBe(1);
    expect(mediaNonce(9, 10)).toBe(1);
    expect(mediaNonce(10, 10)).toBe(2);
  });

  it("raises fees by 12.5%, rounded up", () => {
    expect(bumpFee(1_000n)).toBe(1_125n);
    expect(bumpFee(1n)).toBe(2n);
  });

  it("prices audio packets", () => {
    expect(mediaGas(20 * 1024)).toBe(843_240n);
  });
});
