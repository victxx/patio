import { describe, expect, it } from "vitest";

import { PatioPacketError } from "./types";
import { decodeVideoBetaPayload, encodeVideoBetaPayload } from "./video-beta";

describe("Video beta payload", () => {
  it("round-trips a WebP frame with Opus audio", () => {
    const encoded = encodeVideoBetaPayload({
      width: 160,
      height: 90,
      image: new Uint8Array([1, 2, 3]),
      audio: new Uint8Array([4, 5, 6, 7]),
    });
    expect(decodeVideoBetaPayload(encoded)).toEqual({
      width: 160,
      height: 90,
      image: new Uint8Array([1, 2, 3]),
      audio: new Uint8Array([4, 5, 6, 7]),
    });
  });

  it("rejects malformed lengths", () => {
    const encoded = encodeVideoBetaPayload({
      width: 160,
      height: 90,
      image: new Uint8Array([1]),
      audio: new Uint8Array([2]),
    });
    expect(() => decodeVideoBetaPayload(encoded.slice(0, -1))).toThrow(
      PatioPacketError,
    );
  });

  it("allows a missing frame so audio can continue", () => {
    const encoded = encodeVideoBetaPayload({
      width: 160,
      height: 90,
      image: new Uint8Array(),
      audio: new Uint8Array([1]),
    });
    expect(decodeVideoBetaPayload(encoded).image).toHaveLength(0);
  });
});
