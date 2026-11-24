import { describe, expect, it } from "vitest";

import { Codec, voiceFromPayload, WebmJoiner } from ".";

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const init = [...EBML, 9, 9];

/** `PAA1`, a 2-byte initialization length, then WebM. */
function framed(webm: number[], initLength: number): Uint8Array {
  return new Uint8Array([0x50, 0x41, 0x41, 0x31, 0, initLength, ...webm]);
}

describe("voice", () => {
  it("reads a voice-only payload", () => {
    const voice = voiceFromPayload(
      framed([...init, ...CLUSTER, 1], init.length),
      Codec.OPUS_WEBM,
    );
    expect(voice.initLength).toBe(6);
    expect([...voice.webm]).toEqual([...init, ...CLUSTER, 1]);
  });

  it("finds the voice inside a picture payload", () => {
    const voice = framed([...init, ...CLUSTER, 1], init.length);
    const payload = new Uint8Array([
      0x56,
      0x49,
      1,
      3,
      0,
      voice.length,
      0,
      8,
      0,
      8,
      1,
      ...voice,
      0,
      0,
      0,
      0,
      1,
      0,
      2,
      7,
      7,
    ]);
    const read = voiceFromPayload(payload, Codec.OPUS_WEBM_IMAGES);
    expect([...read.webm]).toEqual([...init, ...CLUSTER, 1]);
  });

  it("rejects anything else", () => {
    expect(() =>
      voiceFromPayload(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), Codec.OPUS_WEBM),
    ).toThrow();
  });
});

describe("joining packets", () => {
  it("keeps the initialization segment once", () => {
    const joiner = new WebmJoiner();
    const packet = (n: number) =>
      voiceFromPayload(framed([...init, ...CLUSTER, n], 6), Codec.OPUS_WEBM);
    const file = [
      ...joiner.push(packet(1), false),
      ...joiner.push(packet(2), false),
    ];
    expect(file).toEqual([...init, ...CLUSTER, 1, ...CLUSTER, 2]);
  });

  it("restarts at a whole cluster after a missing packet", () => {
    const joiner = new WebmJoiner();
    const first = voiceFromPayload(
      framed([...init, ...CLUSTER, 1], 6),
      Codec.OPUS_WEBM,
    );
    // Starts with the tail of a block that began in the lost packet.
    const late = voiceFromPayload(
      framed([...init, 5, 5, ...CLUSTER, 3], 6),
      Codec.OPUS_WEBM,
    );
    joiner.push(first, false);
    expect([...joiner.push(late, true)]).toEqual([...CLUSTER, 3]);
  });
});

describe("hints", () => {
  it("reads a hint and refuses anything else", async () => {
    const { parseHint } = await import(".");
    const hash = `0x${"ab".repeat(32)}`;
    expect(
      parseHint(JSON.stringify({ v: 1, c: 80002, q: 7, h: hash })),
    ).toEqual({ chainId: 80002, sequence: 7, hash });
    expect(parseHint(JSON.stringify({ v: 2, c: 80002, q: 7, h: hash }))).toBe(
      null,
    );
    expect(parseHint("not json")).toBe(null);
  });
});
