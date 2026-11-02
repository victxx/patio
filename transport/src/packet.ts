import { bytesToHex, concatBytes, hexToBytes, keccak256, type Hex } from "viem";

const MAGIC = new Uint8Array([0x50, 0x54, 0x49, 0x4f]); // "PTIO"
const VERSION = 1;
const HEADER_BYTES = 44;
const CHECKSUM_BYTES = 32;
export const MAX_PAYLOAD_BYTES = 24 * 1024;

export const PacketType = { START: 1, AUDIO: 2, END: 3, VIDEO: 4 } as const;

export interface Packet {
  type: number;
  codec: number;
  flags: number;
  /** 16 bytes, as hex. */
  streamId: Hex;
  windowIndex: number;
  sequence: number;
  capturedAtMs: bigint;
  payload: Uint8Array;
}

export function encodePacket(packet: Packet): Hex {
  const streamId = hexToBytes(packet.streamId);
  if (streamId.length !== 16) throw new Error("streamId must be 16 bytes");
  if (packet.payload.length > MAX_PAYLOAD_BYTES)
    throw new Error("Payload is too large");

  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header[5] = packet.type;
  header[6] = packet.codec;
  header[7] = packet.flags;
  header.set(streamId, 8);
  view.setUint32(24, packet.windowIndex);
  view.setUint32(28, packet.sequence);
  view.setBigUint64(32, packet.capturedAtMs);
  view.setUint32(40, packet.payload.length);

  const body = concatBytes([header, packet.payload]);
  return bytesToHex(concatBytes([body, hexToBytes(keccak256(body))]));
}

/** Reads a transaction's `input`. Throws on anything that is not a valid packet. */
export function decodePacket(input: Hex): Packet {
  const bytes = hexToBytes(input);
  if (bytes.length < HEADER_BYTES + CHECKSUM_BYTES)
    throw new Error("Too short to be a packet");
  if (!MAGIC.every((value, index) => bytes[index] === value))
    throw new Error("Not a Patio packet");
  if (bytes[4] !== VERSION) throw new Error("Unsupported version");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(40);
  if (
    length > MAX_PAYLOAD_BYTES ||
    bytes.length !== HEADER_BYTES + length + CHECKSUM_BYTES
  )
    throw new Error("Wrong packet length");

  const end = HEADER_BYTES + length;
  if (keccak256(bytes.subarray(0, end)) !== bytesToHex(bytes.subarray(end)))
    throw new Error("Checksum does not match");

  return {
    type: bytes[5]!,
    codec: bytes[6]!,
    flags: bytes[7]!,
    streamId: bytesToHex(bytes.subarray(8, 24)),
    windowIndex: view.getUint32(24),
    sequence: view.getUint32(28),
    capturedAtMs: view.getBigUint64(32),
    payload: bytes.slice(HEADER_BYTES, end),
  };
}
