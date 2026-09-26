export * from "./types";
export * from "./base64";
export * from "./reconstruction";
import { bytesToBase64 } from "./base64";

import { keccak256, toBytes, type Hex } from "viem";

export function createStreamId(seed?: string): Hex {
  const entropy = seed
    ? toBytes(seed)
    : globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${keccak256(entropy).slice(2, 34)}`;
}

export function serializePatioPacket(packet: import("./types").DecodedPatioPacketV1): import("./types").SerializedPatioPacketV1 {
  const { payload, ...serializable } = packet;
  return { ...serializable, capturedAtMs: packet.capturedAtMs.toString(), payloadBase64: bytesToBase64(payload) };
}
