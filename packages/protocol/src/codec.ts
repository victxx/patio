import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import { bytesToBase64 } from "./base64";
import {
  PATIO_HEADER_BYTES, PATIO_MAGIC, PATIO_PACKET_OVERHEAD_BYTES,
  PATIO_PROTOCOL_VERSION, PatioCodec, PatioPacketError, PatioPacketType,
  type DecodedPatioPacketV1, type PatioPacketV1, type SerializedPatioPacketV1,
} from "./types";

const MAX_PAYLOAD_BYTES = 8 * 1024;
function streamBytes(streamId: Hex): Uint8Array {
  const bytes = hexToBytes(streamId);
  if (bytes.length !== 16) throw new PatioPacketError("streamId must be exactly 16 bytes");
  return bytes;
}
function checksum(data: Uint8Array): Uint8Array { return hexToBytes(keccak256(data)); }

export function encodePatioPacket(packet: PatioPacketV1): Uint8Array {
  if (packet.version !== PATIO_PROTOCOL_VERSION) throw new PatioPacketError("Unsupported protocol version");
  if (!Object.values(PatioPacketType).includes(packet.type)) throw new PatioPacketError("Unsupported packet type");
  if (!Object.values(PatioCodec).includes(packet.codec)) throw new PatioPacketError("Unsupported codec");
  if (packet.payload.length > MAX_PAYLOAD_BYTES) throw new PatioPacketError("Payload exceeds protocol maximum");
  const header = new Uint8Array(PATIO_HEADER_BYTES); header.set(PATIO_MAGIC); header[4] = packet.version; header[5] = packet.type; header[6] = packet.codec; header[7] = packet.flags;
  header.set(streamBytes(packet.streamId), 8); const view = new DataView(header.buffer);
  view.setUint32(24, packet.windowIndex, false); view.setUint32(28, packet.sequence, false); view.setBigUint64(32, packet.capturedAtMs, false); view.setUint32(40, packet.payload.length, false);
  const body = new Uint8Array(header.length + packet.payload.length); body.set(header); body.set(packet.payload, header.length);
  const result = new Uint8Array(body.length + 32); result.set(body); result.set(checksum(body), body.length); return result;
}

export function decodePatioPacket(bytes: Uint8Array): DecodedPatioPacketV1 {
  if (bytes.length < PATIO_PACKET_OVERHEAD_BYTES) throw new PatioPacketError("Packet is shorter than the minimum envelope");
  for (let index = 0; index < PATIO_MAGIC.length; index += 1) if (bytes[index] !== PATIO_MAGIC[index]) throw new PatioPacketError("Invalid Patio magic bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const payloadLength = view.getUint32(40, false);
  if (payloadLength > MAX_PAYLOAD_BYTES || bytes.length !== PATIO_PACKET_OVERHEAD_BYTES + payloadLength) throw new PatioPacketError("Packet length mismatch");
  const body = bytes.subarray(0, PATIO_HEADER_BYTES + payloadLength); const actual = bytes.subarray(body.length);
  const expected = checksum(body); if (!actual.every((value, index) => value === expected[index])) throw new PatioPacketError("Packet checksum does not match");
  return { version: 1, type: bytes[5] as PatioPacketType, codec: bytes[6] as PatioCodec, flags: bytes[7] ?? 0, streamId: bytesToHex(bytes.subarray(8, 24)), windowIndex: view.getUint32(24, false), sequence: view.getUint32(28, false), capturedAtMs: view.getBigUint64(32, false), payload: bytes.slice(PATIO_HEADER_BYTES, body.length), checksum: bytesToHex(actual) };
}

export function serializePatioPacket(packet: DecodedPatioPacketV1): SerializedPatioPacketV1 {
  const { payload, ...serializable } = packet;
  return { ...serializable, capturedAtMs: packet.capturedAtMs.toString(), payloadBase64: bytesToBase64(payload) };
}
