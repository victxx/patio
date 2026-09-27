const WEBM_EBML_ID = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
const WEBM_CLUSTER_ID = new Uint8Array([0x1f, 0x43, 0xb6, 0x75]);
const PATIO_AUDIO_FRAME_MAGIC = new Uint8Array([0x50, 0x41, 0x41, 0x31]);
const PATIO_AUDIO_FRAME_HEADER_BYTES = 6;

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (
    let index = 0;
    index <= bytes.length - needle.length;
    index += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

export interface SeekableWebmChunk {
  initializationSegment: Uint8Array | null;
  payload: Uint8Array;
  resyncable: boolean;
}

export interface BootstrappedWebmVideoChunk {
  bootstrapSegment: Uint8Array | null;
  payload: Uint8Array;
  prefixLength: number;
  resyncable: boolean;
}

export interface PreparedWebmMediaSourceChunk {
  initializationLength: number | null;
  payload: Uint8Array;
  resetParser?: boolean;
}

export function frameWebmAudioPayload(
  payload: Uint8Array,
  initializationLength: number,
): Uint8Array {
  if (
    initializationLength < 0 ||
    initializationLength > 0xffff ||
    (initializationLength > 0 && initializationLength >= payload.length)
  ) {
    throw new Error("Invalid Patio WebM initialization length.");
  }
  const framed = new Uint8Array(
    PATIO_AUDIO_FRAME_HEADER_BYTES + payload.length,
  );
  framed.set(PATIO_AUDIO_FRAME_MAGIC);
  new DataView(framed.buffer).setUint16(4, initializationLength, false);
  framed.set(payload, PATIO_AUDIO_FRAME_HEADER_BYTES);
  return framed;
}

/**
 * The framing is codec-agnostic: it carries the WebM initialization length
 * for both Opus-only and VP8/VP9 + Opus MediaRecorder output. The original
 * audio-named export remains available for packet compatibility.
 */
export const frameWebmTransportPayload = frameWebmAudioPayload;

function decodeWebmAudioFrame(payload: Uint8Array): {
  initializationLength: number;
  webm: Uint8Array;
} | null {
  if (payload.length <= PATIO_AUDIO_FRAME_HEADER_BYTES) return null;
  for (let index = 0; index < PATIO_AUDIO_FRAME_MAGIC.length; index += 1) {
    if (payload[index] !== PATIO_AUDIO_FRAME_MAGIC[index]) return null;
  }
  const initializationLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint16(4, false);
  const webm = payload.slice(PATIO_AUDIO_FRAME_HEADER_BYTES);
  if (
    initializationLength >= webm.length ||
    (initializationLength > 0 && indexOfBytes(webm, WEBM_EBML_ID) !== 0)
  ) {
    return null;
  }
  return { initializationLength, webm };
}

/**
 * Converts Patio's resyncable audio frame back into the exact byte sequence
 * expected by a continuous MediaSource. A late listener starts at the next
 * complete Cluster; listeners present from the start keep every continuation
 * byte between MediaRecorder timeslices.
 */
export function prepareWebmMediaSourceChunk(
  payload: Uint8Array,
  previousInitializationLength: number | null,
  afterGap = false,
): PreparedWebmMediaSourceChunk {
  const frame = decodeWebmAudioFrame(payload);
  const webm = frame?.webm ?? payload;
  if (afterGap) {
    // A MediaRecorder timeslice may begin halfway through an EBML block.
    // After loss, never feed that continuation into the previous parser state.
    // Video's repeated prefix also contains OLD media: keep only its Tracks,
    // not the old first frame. Wait for a fresh complete Cluster boundary.
    const prefix = frame?.initializationLength ?? 0;
    const headerEnd = indexOfBytes(webm, WEBM_CLUSTER_ID);
    const cluster =
      prefix > 0 ? indexOfBytes(webm.slice(prefix), WEBM_CLUSTER_ID) : -1;
    if (!prefix || headerEnd <= 0 || cluster < 0)
      return {
        initializationLength: previousInitializationLength,
        payload: new Uint8Array(),
      };
    const headerLength = Math.min(prefix, headerEnd);
    const tail = webm.slice(prefix + cluster);
    const recovered = new Uint8Array(headerLength + tail.length);
    recovered.set(webm.slice(0, headerLength));
    recovered.set(tail, headerLength);
    return {
      initializationLength: headerLength,
      payload: recovered,
      resetParser: true,
    };
  }
  if (frame?.initializationLength === 0) {
    return {
      initializationLength: previousInitializationLength,
      payload: webm,
    };
  }
  const initializationLength =
    frame?.initializationLength ??
    previousInitializationLength ??
    (() => {
      const clusterIndex = indexOfBytes(webm, WEBM_CLUSTER_ID);
      return indexOfBytes(webm, WEBM_EBML_ID) === 0 && clusterIndex > 0
        ? clusterIndex
        : null;
    })();

  if (
    previousInitializationLength !== null &&
    initializationLength !== null &&
    indexOfBytes(webm, WEBM_EBML_ID) === 0
  ) {
    return {
      initializationLength,
      payload: webm.slice(initializationLength),
    };
  }

  if (frame && initializationLength !== null) {
    const continuation = webm.slice(initializationLength);
    const clusterIndex = indexOfBytes(continuation, WEBM_CLUSTER_ID);
    if (clusterIndex > 0) {
      const resynced = new Uint8Array(
        initializationLength + continuation.length - clusterIndex,
      );
      resynced.set(webm.slice(0, initializationLength));
      resynced.set(continuation.slice(clusterIndex), initializationLength);
      return { initializationLength, payload: resynced };
    }
  }

  return { initializationLength, payload: webm };
}

/**
 * A resyncable Patio audio packet can contain a complete WebM initialization
 * segment so a late listener can start from that packet. MediaSource needs the
 * initialization data only for the first appended packet; repeating it for
 * every packet can make Chrome reject an otherwise valid following cluster.
 */
export function webmMediaSourcePayload(
  payload: Uint8Array,
  includeInitialization: boolean,
): Uint8Array {
  if (includeInitialization) return payload;
  const clusterIndex = indexOfBytes(payload, WEBM_CLUSTER_ID);
  const beginsWithEbml = indexOfBytes(payload, WEBM_EBML_ID) === 0;
  return beginsWithEbml && clusterIndex > 0
    ? payload.slice(clusterIndex)
    : payload;
}

/**
 * Chrome's MediaRecorder writes the WebM initialization segment only once.
 * Patio repeats it before later clusters so a listener can join mid-stream.
 */
export function makeWebmChunkSeekable(
  chunk: Uint8Array,
  previousInitializationSegment: Uint8Array | null,
): SeekableWebmChunk {
  const clusterIndex = indexOfBytes(chunk, WEBM_CLUSTER_ID);
  const beginsWithEbml = indexOfBytes(chunk, WEBM_EBML_ID) === 0;

  if (beginsWithEbml && clusterIndex > 0) {
    const initializationSegment = chunk.slice(0, clusterIndex);
    return {
      initializationSegment,
      payload: chunk,
      resyncable: true,
    };
  }

  if (previousInitializationSegment && clusterIndex >= 0) {
    const payload = new Uint8Array(
      previousInitializationSegment.length + chunk.length,
    );
    payload.set(previousInitializationSegment);
    payload.set(chunk, previousInitializationSegment.length);
    return {
      initializationSegment: previousInitializationSegment,
      payload,
      resyncable: true,
    };
  }

  return {
    initializationSegment: previousInitializationSegment,
    payload: chunk,
    resyncable: false,
  };
}

/**
 * Repeats initialization metadata, not the first recorded video chunk. The
 * recorder requests frequent keyframes in the CURRENT media. Repeating old
 * frames does not repair missing dependencies and needlessly fragments tiny
 * video across multiple short-lived replacements. Continuous listeners strip
 * the prefix; after loss, listeners wait for a fresh Cluster/keyframe.
 */
export function makeWebmVideoChunkBootstrapped(
  chunk: Uint8Array,
  previousBootstrapSegment: Uint8Array | null,
): BootstrappedWebmVideoChunk {
  if (!previousBootstrapSegment) {
    const first = makeWebmChunkSeekable(chunk, null);
    if (!first.initializationSegment || !first.resyncable) {
      return {
        bootstrapSegment: null,
        payload: chunk,
        prefixLength: 0,
        resyncable: false,
      };
    }
    return {
      bootstrapSegment: first.initializationSegment,
      payload: first.payload,
      prefixLength: first.initializationSegment.length,
      resyncable: true,
    };
  }

  const payload = new Uint8Array(
    previousBootstrapSegment.length + chunk.length,
  );
  payload.set(previousBootstrapSegment);
  payload.set(chunk, previousBootstrapSegment.length);
  return {
    bootstrapSegment: previousBootstrapSegment,
    payload,
    prefixLength: previousBootstrapSegment.length,
    resyncable: true,
  };
}
