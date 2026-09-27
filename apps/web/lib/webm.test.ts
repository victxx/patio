import { describe, expect, it } from "vitest";

import {
  frameWebmAudioPayload,
  frameWebmTransportPayload,
  makeWebmChunkSeekable,
  makeWebmVideoChunkBootstrapped,
  prepareWebmMediaSourceChunk,
  webmMediaSourcePayload,
} from "./webm";

const ebml = [0x1a, 0x45, 0xdf, 0xa3];
const cluster = [0x1f, 0x43, 0xb6, 0x75];

describe("makeWebmChunkSeekable", () => {
  it("resets a broken parser at a fresh cluster after packet loss, excluding the old video bootstrap", () => {
    const header = [...ebml, 0x01, 0x02];
    const bootstrap = [...header, ...cluster, 0x11, 0x12];
    const transport = new Uint8Array([
      ...bootstrap,
      0xa3,
      0x81,
      0x04,
      ...cluster,
      0x55,
    ]);
    const prepared = prepareWebmMediaSourceChunk(
      frameWebmTransportPayload(transport, bootstrap.length),
      bootstrap.length,
      true,
    );
    expect(prepared).toEqual({
      initializationLength: header.length,
      resetParser: true,
      payload: new Uint8Array([...header, ...cluster, 0x55]),
    });
  });

  it("waits for a fresh cluster after a gap instead of appending an orphan continuation", () => {
    const header = [...ebml, 0x01, 0x02];
    const transport = new Uint8Array([...header, 0xa3, 0x81, 0x04]);
    const prepared = prepareWebmMediaSourceChunk(
      frameWebmAudioPayload(transport, header.length),
      header.length,
      true,
    );
    expect(prepared.payload).toHaveLength(0);
    expect(prepared.resetParser).toBeUndefined();
  });
  it("captures the initialization segment from the first MediaRecorder chunk", () => {
    const first = new Uint8Array([...ebml, 0x01, 0x02, ...cluster, 0x03]);
    const result = makeWebmChunkSeekable(first, null);

    expect([...result.initializationSegment!]).toEqual([...ebml, 0x01, 0x02]);
    expect(result.payload).toEqual(first);
    expect(result.resyncable).toBe(true);
  });

  it("prepends the initialization segment to later WebM clusters", () => {
    const initialization = new Uint8Array([...ebml, 0x01]);
    const later = new Uint8Array([...cluster, 0x02, 0x03]);
    const result = makeWebmChunkSeekable(later, initialization);

    expect([...result.payload]).toEqual([...initialization, ...later]);
    expect(result.initializationSegment).toBe(initialization);
    expect(result.resyncable).toBe(true);
  });

  it("leaves an incomplete fragment untouched", () => {
    const fragment = new Uint8Array([0x01, 0x02, 0x03]);
    const result = makeWebmChunkSeekable(fragment, null);

    expect(result.payload).toEqual(fragment);
    expect(result.resyncable).toBe(false);
  });

  it("keeps initialization once and strips it from later MediaSource appends", () => {
    const first = new Uint8Array([...ebml, 0x01, 0x02, ...cluster, 0x03]);
    const later = new Uint8Array([...ebml, 0x01, 0x02, ...cluster, 0x04]);

    expect(webmMediaSourcePayload(first, true)).toEqual(first);
    expect(webmMediaSourcePayload(later, false)).toEqual(
      new Uint8Array([...cluster, 0x04]),
    );
  });

  it("leaves an already cluster-only MediaSource append untouched", () => {
    const later = new Uint8Array([...cluster, 0x04, 0x05]);
    expect(webmMediaSourcePayload(later, false)).toEqual(later);
  });

  it("restores exact continuous MediaRecorder bytes after repeated initialization", () => {
    const initialization = new Uint8Array([...ebml, 0x01, 0x02]);
    const firstRaw = new Uint8Array([...cluster, 0x03]);
    const continuation = new Uint8Array([0xa3, 0x81, 0x04, ...cluster, 0x05]);
    const firstTransport = new Uint8Array([...initialization, ...firstRaw]);
    const laterTransport = new Uint8Array([...initialization, ...continuation]);

    const first = prepareWebmMediaSourceChunk(
      frameWebmAudioPayload(firstTransport, initialization.length),
      null,
    );
    const later = prepareWebmMediaSourceChunk(
      frameWebmAudioPayload(laterTransport, initialization.length),
      first.initializationLength,
    );

    expect(first.payload).toEqual(firstTransport);
    expect(later.payload).toEqual(continuation);
  });

  it("resynchronizes a late listener at a complete WebM cluster", () => {
    const initialization = new Uint8Array([...ebml, 0x01, 0x02]);
    const continuation = new Uint8Array([0xa3, 0x81, 0x04, ...cluster, 0x05]);
    const transport = new Uint8Array([...initialization, ...continuation]);

    const prepared = prepareWebmMediaSourceChunk(
      frameWebmAudioPayload(transport, initialization.length),
      null,
    );

    expect(prepared.initializationLength).toBe(initialization.length);
    expect(prepared.payload).toEqual(
      new Uint8Array([...initialization, ...cluster, 0x05]),
    );
  });

  it("uses the same binary resync frame for real WebM video", () => {
    const initialization = new Uint8Array([...ebml, 0x42, 0x82]);
    const lateVideoChunk = new Uint8Array([0xa3, 0x81, 0x04, ...cluster, 0x55]);
    const seekable = makeWebmChunkSeekable(lateVideoChunk, initialization);
    const prepared = prepareWebmMediaSourceChunk(
      frameWebmTransportPayload(
        seekable.payload,
        seekable.initializationSegment!.length,
      ),
      null,
    );

    expect(prepared.initializationLength).toBe(initialization.length);
    expect(prepared.payload).toEqual(
      new Uint8Array([...initialization, ...cluster, 0x55]),
    );
  });

  it("preserves a raw MediaRecorder continuation that has no new cluster", () => {
    const continuation = new Uint8Array([0xa3, 0x81, 0x04, 0x05]);
    const prepared = prepareWebmMediaSourceChunk(
      frameWebmAudioPayload(continuation, 0),
      6,
    );

    expect(prepared.initializationLength).toBe(6);
    expect(prepared.payload).toEqual(continuation);
  });

  it("repeats only video metadata without duplicating stale frames or growing every packet", () => {
    const firstChunk = new Uint8Array([
      ...ebml,
      0x01,
      0x02,
      ...cluster,
      0x03,
      0x04,
    ]);
    const laterChunk = new Uint8Array([0xa3, 0x81, 0x05]);
    const first = makeWebmVideoChunkBootstrapped(firstChunk, null);
    const later = makeWebmVideoChunkBootstrapped(
      laterChunk,
      first.bootstrapSegment,
    );

    const header = firstChunk.slice(0, 6);
    expect(first.bootstrapSegment).toEqual(header);
    expect(later.prefixLength).toBe(header.length);
    expect(later.payload).toEqual(new Uint8Array([...header, ...laterChunk]));

    const continuous = prepareWebmMediaSourceChunk(
      frameWebmTransportPayload(later.payload, later.prefixLength),
      first.prefixLength,
    );
    expect(continuous.payload).toEqual(laterChunk);

    const late = prepareWebmMediaSourceChunk(
      frameWebmTransportPayload(later.payload, later.prefixLength),
      null,
    );
    expect(late.payload).toEqual(later.payload);
  });
});
