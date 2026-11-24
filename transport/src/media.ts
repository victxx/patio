/** Codecs a packet header can name. */
export const Codec = {
  /** Opus in WebM, voice only. */
  OPUS_WEBM: 1,
  /** Opus in WebM, then still frames in the bytes the voice leaves free. */
  OPUS_WEBM_IMAGES: 5,
} as const;

const VOICE_FRAME = new Uint8Array([0x50, 0x41, 0x41, 0x31]); // "PAA1"
const IMAGE_TRACK = new Uint8Array([0x56, 0x49]); // "VI"
const EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
const CLUSTER = new Uint8Array([0x1f, 0x43, 0xb6, 0x75]);

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean {
  return prefix.every((value, index) => bytes[at + index] === value);
}

function indexOf(bytes: Uint8Array, needle: Uint8Array, from = 0): number {
  for (let i = from; i <= bytes.length - needle.length; i++)
    if (startsWith(bytes, needle, i)) return i;
  return -1;
}

export interface Voice {
  /** WebM bytes: the initialization segment, then clusters. */
  webm: Uint8Array;
  /** Length of the initialization segment at the start of `webm`, or 0. */
  initLength: number;
}

/**
 * The voice inside a packet payload.
 *
 * Voice is framed as `PAA1`, a 2-byte initialization length, then WebM.
 * With pictures (codec 5) the framed voice sits inside an image-track
 * header: `VI`, version, image codec, 2-byte voice length, width, height,
 * frame count, then the voice, then the frames. Pictures are ignored here.
 */
export function voiceFromPayload(payload: Uint8Array, codec: number): Voice {
  let voice = payload;
  if (codec === Codec.OPUS_WEBM_IMAGES) {
    if (!startsWith(payload, IMAGE_TRACK)) throw new Error("No image track");
    const length = new DataView(payload.buffer, payload.byteOffset).getUint16(
      4,
    );
    voice = payload.subarray(11, 11 + length);
  }
  if (!startsWith(voice, VOICE_FRAME)) throw new Error("No voice frame");
  const initLength = new DataView(voice.buffer, voice.byteOffset).getUint16(4);
  const webm = voice.subarray(6);
  if (initLength >= webm.length || (initLength > 0 && !startsWith(webm, EBML)))
    throw new Error("Bad voice frame");
  return { webm, initLength };
}

/**
 * Joins packets into one playable WebM file. Every packet repeats the
 * initialization segment so a late listener can start anywhere; a file
 * needs it once. After a missing packet, the next one is cut to its first
 * whole cluster, because a recorder slice can start halfway through a block.
 */
export class WebmJoiner {
  private started = false;

  push(voice: Voice, afterGap: boolean): Uint8Array {
    const { webm, initLength } = voice;
    if (!this.started) {
      if (initLength === 0) return new Uint8Array();
      this.started = true;
      const cluster = indexOf(webm, CLUSTER, initLength);
      if (cluster < 0) return webm.subarray(0, initLength);
      return concat(webm.subarray(0, initLength), webm.subarray(cluster));
    }
    if (afterGap) {
      const cluster = indexOf(webm, CLUSTER, initLength);
      return cluster < 0 ? new Uint8Array() : webm.subarray(cluster);
    }
    return webm.subarray(initLength);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
