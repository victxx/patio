import type { Hex } from "viem";

export const PATIO_MAGIC = new Uint8Array([0x50, 0x54, 0x49, 0x4f]);
export const PATIO_PROTOCOL_VERSION = 1;
export const PATIO_HEADER_BYTES = 44;
export const PATIO_CHECKSUM_BYTES = 32;
export const PATIO_PACKET_OVERHEAD_BYTES =
  PATIO_HEADER_BYTES + PATIO_CHECKSUM_BYTES;

export enum PatioPacketType {
  START = 1,
  AUDIO = 2,
  END = 3,
  VIDEO = 4,
}

export enum PatioCodec {
  OPUS_WEBM = 1,
  OPUS_WEBM_WEBP = 2,
  WEBM_VP8_OPUS = 3,
  WEBM_VP9_OPUS = 4,
}

export interface PatioPacketV1 {
  version: 1;
  type: PatioPacketType;
  codec: PatioCodec;
  flags: number;
  streamId: Hex;
  windowIndex: number;
  sequence: number;
  capturedAtMs: bigint;
  payload: Uint8Array;
}

export interface DecodedPatioPacketV1 extends PatioPacketV1 {
  checksum: Hex;
}

export interface SerializedPatioPacketV1 {
  version: 1;
  type: PatioPacketType;
  codec: PatioCodec;
  flags: number;
  streamId: Hex;
  windowIndex: number;
  sequence: number;
  capturedAtMs: string;
  payloadBase64: string;
  checksum: Hex;
}

export class PatioPacketError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PatioPacketError";
  }
}
