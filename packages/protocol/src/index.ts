export * from "./types";
export * from "./base64";
export * from "./reconstruction";
export * from "./codec";
import { keccak256, toBytes, type Hex } from "viem";

export function createStreamId(seed?: string): Hex {
  const entropy = seed
    ? toBytes(seed)
    : globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${keccak256(entropy).slice(2, 34)}`;
}
