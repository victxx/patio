import { concatBytes } from "viem";

import { PatioPacketError } from "./types";

const VIDEO_BETA_MAGIC = new Uint8Array([0x56, 0x42]);
const VIDEO_BETA_VERSION = 1;
const VIDEO_BETA_HEADER_BYTES = 12;
const UINT16_MAX = 0xffff;

export interface VideoBetaPayload {
  width: number;
  height: number;
  image: Uint8Array;
  audio: Uint8Array;
}

function assertUint16(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
    throw new PatioPacketError(`${name} must fit in uint16`);
  }
}

export function encodeVideoBetaPayload(payload: VideoBetaPayload): Uint8Array {
  assertUint16(payload.width, "Video width");
  assertUint16(payload.height, "Video height");
  assertUint16(payload.image.length, "Video image length");
  assertUint16(payload.audio.length, "Video audio length");
  if (payload.width === 0 || payload.height === 0) {
    throw new PatioPacketError("Video dimensions must be positive");
  }
  if (payload.audio.length === 0) {
    throw new PatioPacketError("Video beta payload requires Opus audio");
  }

  const header = new Uint8Array(VIDEO_BETA_HEADER_BYTES);
  header.set(VIDEO_BETA_MAGIC, 0);
  header[2] = VIDEO_BETA_VERSION;
  header[3] = 0;
  const view = new DataView(header.buffer);
  view.setUint16(4, payload.width, false);
  view.setUint16(6, payload.height, false);
  view.setUint16(8, payload.image.length, false);
  view.setUint16(10, payload.audio.length, false);
  return concatBytes([header, payload.image, payload.audio]);
}

export function decodeVideoBetaPayload(bytes: Uint8Array): VideoBetaPayload {
  if (bytes.length < VIDEO_BETA_HEADER_BYTES) {
    throw new PatioPacketError("Video beta payload is shorter than its header");
  }
  if (bytes[0] !== VIDEO_BETA_MAGIC[0] || bytes[1] !== VIDEO_BETA_MAGIC[1]) {
    throw new PatioPacketError("Video beta payload has invalid magic bytes");
  }
  if (bytes[2] !== VIDEO_BETA_VERSION) {
    throw new PatioPacketError("Unsupported video beta payload version");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(4, false);
  const height = view.getUint16(6, false);
  const imageLength = view.getUint16(8, false);
  const audioLength = view.getUint16(10, false);
  const expectedLength = VIDEO_BETA_HEADER_BYTES + imageLength + audioLength;
  if (width === 0 || height === 0 || bytes.length !== expectedLength) {
    throw new PatioPacketError("Video beta payload length is invalid");
  }
  const imageStart = VIDEO_BETA_HEADER_BYTES;
  const audioStart = imageStart + imageLength;
  return {
    width,
    height,
    image: bytes.slice(imageStart, audioStart),
    audio: bytes.slice(audioStart),
  };
}
