import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePatioPacket, encodePatioPacket } from "./codec.ts";

const packet = {
  version: 1,
  type: 2,
  codec: 1,
  flags: 0,
  streamId: "0x00112233445566778899aabbccddeeff",
  windowIndex: 3,
  sequence: 12,
  capturedAtMs: 1_785_000_000_012n,
  payload: new TextEncoder().encode("hello patio"),
};

test("encodes and decodes a packet without losing fields", () => {
  const decoded = decodePatioPacket(encodePatioPacket(packet));
  assert.equal(decoded.sequence, packet.sequence);
  assert.equal(decoded.windowIndex, packet.windowIndex);
  assert.deepEqual(decoded.payload, packet.payload);
  assert.match(decoded.checksum, /^0x[\da-f]{64}$/);
});

test("rejects a packet with a changed payload", () => {
  const encoded = encodePatioPacket(packet);
  encoded[44] = (encoded[44] ?? 0) ^ 0xff;
  assert.throws(() => decodePatioPacket(encoded), /checksum/);
});
