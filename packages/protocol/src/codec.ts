import { PATIO_DEFAULTS } from "@patio/config";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  isHex,
  keccak256,
  toBytes,
  type Hex,
} from "viem";

import {
  PATIO_HEADER_BYTES,
  PATIO_MAGIC,
  PATIO_PACKET_OVERHEAD_BYTES,
  PATIO_PROTOCOL_VERSION,
  PatioCodec,
  PatioPacketError,
  PatioPacketType,
  type DecodedPatioPacketV1,
  type PatioPacketV1,
  type SerializedPatioPacketV1,
} from "./types";

const STREAM_ID_BYTES = 16;

function writeUint32(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new PatioPacketError(`Value ${value} does not fit in uint32`);
  }
  view.setUint32(offset, value, false);
}

function streamIdBytes(streamId: Hex): Uint8Array {
  if (!isHex(streamId, { strict: true })) {
    throw new PatioPacketError("streamId must be strict hexadecimal");
  }
  const bytes = hexToBytes(streamId);
  if (bytes.length !== STREAM_ID_BYTES) {
    throw new PatioPacketError("streamId must be exactly 16 bytes");
  }
  return bytes;
}

function assertMagic(bytes: Uint8Array): void {
  for (let index = 0; index < PATIO_MAGIC.length; index += 1) {
    if (bytes[index] !== PATIO_MAGIC[index]) {
      throw new PatioPacketError("Packet does not have the Patio magic bytes");
    }
  }
}

function checksumBytes(bytes: Uint8Array): Uint8Array {
  return hexToBytes(keccak256(bytes));
}

export function encodePatioPacket(packet: PatioPacketV1): Uint8Array {
  if (packet.version !== PATIO_PROTOCOL_VERSION) {
    throw new PatioPacketError(
      `Unsupported protocol version ${String(packet.version)}`,
    );
  }
  if (!Object.values(PatioPacketType).includes(packet.type)) {
    throw new PatioPacketError(
      `Unsupported packet type ${String(packet.type)}`,
    );
  }
  if (
    packet.codec !== PatioCodec.OPUS_WEBM &&
    packet.codec !== PatioCodec.OPUS_WEBM_WEBP &&
    packet.codec !== PatioCodec.WEBM_VP8_OPUS &&
    packet.codec !== PatioCodec.WEBM_VP9_OPUS
  ) {
    throw new PatioPacketError(`Unsupported codec ${String(packet.codec)}`);
  }
  if (packet.flags < 0 || packet.flags > 0xff) {
    throw new PatioPacketError("flags must fit in one byte");
  }
  if (packet.payload.length > PATIO_DEFAULTS.maxPacketPayloadBytes) {
    throw new PatioPacketError(
      `Payload exceeds ${PATIO_DEFAULTS.maxPacketPayloadBytes} bytes`,
    );
  }

  const header = new Uint8Array(PATIO_HEADER_BYTES);
  header.set(PATIO_MAGIC, 0);
  header[4] = packet.version;
  header[5] = packet.type;
  header[6] = packet.codec;
  header[7] = packet.flags;
  header.set(streamIdBytes(packet.streamId), 8);

  const view = new DataView(header.buffer);
  writeUint32(view, 24, packet.windowIndex);
  writeUint32(view, 28, packet.sequence);
  view.setBigUint64(32, packet.capturedAtMs, false);
  writeUint32(view, 40, packet.payload.length);

  const body = concatBytes([header, packet.payload]);
  return concatBytes([body, checksumBytes(body)]);
}

export function decodePatioPacket(bytes: Uint8Array): DecodedPatioPacketV1 {
  if (bytes.length < PATIO_PACKET_OVERHEAD_BYTES) {
    throw new PatioPacketError("Packet is shorter than the minimum envelope");
  }
  assertMagic(bytes);

  const version = bytes[4];
  const type = bytes[5];
  const codec = bytes[6];
  const flags = bytes[7];
  if (version !== PATIO_PROTOCOL_VERSION) {
    throw new PatioPacketError(`Unsupported protocol version ${version}`);
  }
  if (
    type !== PatioPacketType.START &&
    type !== PatioPacketType.AUDIO &&
    type !== PatioPacketType.END &&
    type !== PatioPacketType.VIDEO
  ) {
    throw new PatioPacketError(`Unsupported packet type ${type}`);
  }
  if (
    codec !== PatioCodec.OPUS_WEBM &&
    codec !== PatioCodec.OPUS_WEBM_WEBP &&
    codec !== PatioCodec.WEBM_VP8_OPUS &&
    codec !== PatioCodec.WEBM_VP9_OPUS
  ) {
    throw new PatioPacketError(`Unsupported codec ${codec}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = view.getUint32(40, false);
  if (payloadLength > PATIO_DEFAULTS.maxPacketPayloadBytes) {
    throw new PatioPacketError("Declared payload exceeds the protocol maximum");
  }
  const expectedLength = PATIO_PACKET_OVERHEAD_BYTES + payloadLength;
  if (bytes.length !== expectedLength) {
    throw new PatioPacketError(
      `Packet length mismatch: expected ${expectedLength}, received ${bytes.length}`,
    );
  }

  const body = bytes.subarray(0, PATIO_HEADER_BYTES + payloadLength);
  const actualChecksum = bytes.subarray(PATIO_HEADER_BYTES + payloadLength);
  const expectedChecksum = checksumBytes(body);
  if (
    !actualChecksum.every((value, index) => value === expectedChecksum[index])
  ) {
    throw new PatioPacketError("Packet checksum does not match its contents");
  }

  return {
    version: 1,
    type,
    codec,
    flags: flags ?? 0,
    streamId: bytesToHex(bytes.subarray(8, 24)),
    windowIndex: view.getUint32(24, false),
    sequence: view.getUint32(28, false),
    capturedAtMs: view.getBigUint64(32, false),
    payload: bytes.slice(
      PATIO_HEADER_BYTES,
      PATIO_HEADER_BYTES + payloadLength,
    ),
    checksum: bytesToHex(actualChecksum),
  };
}

export function isPatioPacket(bytes: Uint8Array): boolean {
  try {
    decodePatioPacket(bytes);
    return true;
  } catch {
    return false;
  }
}

export function packetFromHex(data: Hex): DecodedPatioPacketV1 {
  return decodePatioPacket(hexToBytes(data));
}

export function packetToHex(packet: PatioPacketV1): Hex {
  return bytesToHex(encodePatioPacket(packet));
}

export function serializePatioPacket(
  packet: DecodedPatioPacketV1,
): SerializedPatioPacketV1 {
  const { payload, ...serializable } = packet;
  return {
    ...serializable,
    capturedAtMs: packet.capturedAtMs.toString(),
    payloadBase64: bytesToBase64(payload),
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createStreamId(seed?: string): Hex {
  const entropy = seed
    ? toBytes(seed)
    : globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${keccak256(entropy).slice(2, 34)}`;
}
