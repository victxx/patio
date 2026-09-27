import { describe, expect, it } from "vitest";

import {
  assessObservedSequenceGaps,
  compareMediaDiagnosticReports,
  continuousBufferAhead,
  MAX_DIAGNOSTIC_EVENTS,
  MediaDiagnosticsSession,
  type MediaDiagnosticClock,
} from "./media-diagnostics";

class TestClock implements MediaDiagnosticClock {
  public performanceMs = 0;
  public wallMs = 1_800_000_000_000;

  public now(): number {
    return this.performanceMs;
  }

  public wallNow(): number {
    return this.wallMs;
  }

  public advance(milliseconds: number): void {
    this.performanceMs += milliseconds;
    this.wallMs += milliseconds;
  }
}

function begin(
  role: "broadcaster" | "listener",
  clock: TestClock,
): { diagnostics: MediaDiagnosticsSession; token: number } {
  const diagnostics = new MediaDiagnosticsSession(role, 560_048, clock);
  const token = diagnostics.begin(
    {
      chainId: 560_048,
      sessionAddress: "0x1111111111111111111111111111111111111111",
      streamId: "0x11111111111111111111111111111111",
    },
    { mediaMode: "video", recorderTimesliceMs: 1_500 },
  );
  return { diagnostics, token };
}

describe("media diagnostics", () => {
  it("isolates session identities and ignores late events after reset", () => {
    const clock = new TestClock();
    const { diagnostics, token: firstToken } = begin("listener", clock);
    diagnostics.record("packet-received", { sequence: 1 }, firstToken);
    const secondToken = diagnostics.begin(
      {
        chainId: 560_048,
        sessionAddress: "0x2222222222222222222222222222222222222222",
        streamId: "0x22222222222222222222222222222222",
      },
      { mediaMode: "audio" },
    );
    diagnostics.record("packet-received", { sequence: 9 }, firstToken);
    diagnostics.record("packet-received", { sequence: 2 }, secondToken);

    const report = diagnostics.snapshot();
    expect(report.identity.sessionAddress).toContain("2222");
    expect(report.summary.packetsReceived).toBe(1);
    expect(report.events.some((event) => event.details.sequence === 9)).toBe(
      false,
    );
  });

  it("measures bounded queue depth and age", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("broadcaster", clock);
    diagnostics.record(
      "queue-enter",
      { chunkId: "chunk-1", depth: 1, bytes: 200 },
      token,
    );
    clock.advance(750);
    diagnostics.record(
      "queue-enter",
      { chunkId: "chunk-2", depth: 2, bytes: 300 },
      token,
    );
    clock.advance(250);

    expect(diagnostics.snapshot().summary).toMatchObject({
      queueDepth: 2,
      maximumQueueDepth: 2,
      oldestQueueAgeMs: 1_000,
    });
    diagnostics.record("queue-leave", { chunkId: "chunk-1", depth: 1 }, token);
    expect(diagnostics.snapshot().summary.oldestQueueAgeMs).toBe(250);
  });

  it("does not confuse submission or observation with playback", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    diagnostics.record("packet-observed", { durationMs: 250 }, token);
    diagnostics.record("playback-start", {}, token);
    expect(diagnostics.snapshot().summary.startupMs).toBeNull();
    clock.advance(900);
    diagnostics.record("playback-progress", { currentTimeSeconds: 0.2 }, token);
    expect(diagnostics.snapshot().summary.startupMs).toBe(900);
  });

  it("calculates buffer ahead only in the continuous containing range", () => {
    const ranges = {
      length: 2,
      start: (index: number) => [0, 10][index] ?? 0,
      end: (index: number) => [4, 20][index] ?? 0,
    };
    expect(continuousBufferAhead(ranges, 2)).toBe(2);
    expect(continuousBufferAhead(ranges, 6)).toBe(0);
    expect(continuousBufferAhead(ranges, 12)).toBe(8);
  });

  it("separates startup, rebuffering and a voluntary pause", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    diagnostics.record("playback-waiting", {}, token);
    clock.advance(400);
    diagnostics.record("playback-progress", {}, token);
    diagnostics.record("playback-waiting", {}, token);
    clock.advance(300);
    expect(diagnostics.snapshot().summary.interruptionDurationMs).toBe(300);
    diagnostics.record("playback-progress", {}, token);
    diagnostics.record("playback-pause-user", {}, token);
    clock.advance(1_000);
    diagnostics.record("playback-resume", {}, token);

    expect(diagnostics.snapshot().summary).toMatchObject({
      startupMs: 400,
      interruptions: 1,
      interruptionDurationMs: 300,
      playbackState: "resuming",
    });
  });

  it("classifies autoplay and automatic seeks without hiding skipped time", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    diagnostics.record("autoplay-blocked", {}, token);
    expect(diagnostics.snapshot().summary.playbackState).toBe(
      "autoplay-blocked",
    );
    diagnostics.record(
      "playback-seek",
      {
        skippedSeconds: 2.65,
        reason: "initial-audio-position",
        phase: "initial",
      },
      token,
    );
    diagnostics.record(
      "playback-seek",
      { skippedSeconds: 0, reason: "user-control", phase: "user" },
      token,
    );
    expect(diagnostics.snapshot().summary).toMatchObject({
      automaticSeekSeconds: 2.65,
      initialPositioningSeeks: 1,
      initialPositioningSeekSeconds: 2.65,
      midPlaybackSeeks: 0,
    });
  });

  it("does not derive cross-device latency from unrelated clocks", () => {
    const broadcasterClock = new TestClock();
    const listenerClock = new TestClock();
    listenerClock.performanceMs = 99_000;
    listenerClock.wallMs += 5_000;
    const broadcaster = begin("broadcaster", broadcasterClock).diagnostics;
    const listener = begin("listener", listenerClock).diagnostics;
    broadcaster.record("packet-send-attempt", {
      hash: `0x${"1".repeat(64)}`,
      sequence: 0,
    });
    listener.record("packet-received", {
      hash: `0x${"1".repeat(64)}`,
      sequence: 0,
    });

    expect(
      compareMediaDiagnosticReports(
        broadcaster.snapshot(),
        listener.snapshot(),
      ),
    ).toMatchObject({
      sameSession: true,
      matchedHashes: 1,
      crossDeviceLatencyMs: null,
    });
  });

  it("counts only observed gaps after a listener joins", () => {
    expect(assessObservedSequenceGaps([5, 7])).toEqual({
      firstObservedSequence: 5,
      lastObservedSequence: 7,
      observedIntervalSize: 3,
      uniqueReceived: 2,
      observedGaps: 1,
      terminalSequenceKnown: false,
    });
    expect(assessObservedSequenceGaps([5, 7], 9).observedGaps).toBe(3);
  });

  it("records duplicate and out-of-order delivery separately", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    diagnostics.record("packet-received", { sequence: 5 }, token);
    diagnostics.record("packet-received", { sequence: 7 }, token);
    diagnostics.record("packet-duplicate", { sequence: 7 }, token);
    diagnostics.record("packet-received", { sequence: 6 }, token);

    expect(diagnostics.snapshot().summary).toMatchObject({
      duplicates: 1,
      outOfOrderPackets: 1,
      observedSequenceGaps: 0,
    });
  });

  it("records delayed RPC responses and incomplete segment loss without inventing transport latency", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    diagnostics.record("poll-start", {}, token);
    clock.advance(1_150);
    diagnostics.record("poll-start", {}, token);
    diagnostics.record("poll-complete", { durationMs: 820 }, token);
    diagnostics.record(
      "segment-incomplete",
      { segmentIndex: 3, fragmentCount: 2 },
      token,
    );
    diagnostics.record(
      "media-drop",
      { segmentIndex: 3, bytes: 4_096, reason: "incomplete-video-segment" },
      token,
    );

    expect(diagnostics.snapshot().summary).toMatchObject({
      meanPollDurationMs: 820,
      meanPollIntervalMs: 1_150,
      incompleteSegments: 1,
      discardedSegments: 1,
      discardedBytes: 4_096,
      meanPollingObservationMs: null,
    });
  });

  it("keeps accepted and uncertain transport bytes separate", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("broadcaster", clock);
    diagnostics.record("packet-send-attempt", { bytes: 1_000 }, token);
    diagnostics.record(
      "packet-send-result",
      { bytes: 1_000, outcome: "accepted" },
      token,
    );
    diagnostics.record("packet-send-attempt", { bytes: 2_000 }, token);
    diagnostics.record(
      "packet-send-result",
      { bytes: 2_000, outcome: "uncertain" },
      token,
    );

    expect(diagnostics.snapshot().summary).toMatchObject({
      transportBytes: 3_000,
      acceptedTransportBytes: 1_000,
      uncertainTransportBytes: 2_000,
      rejectedTransportBytes: 0,
    });
  });

  it("keeps transport end distinct from playback of remaining buffered content", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    diagnostics.record("playback-progress", {}, token);
    diagnostics.record("transport-end", {}, token);
    expect(diagnostics.snapshot().summary).toMatchObject({
      transportEnded: true,
      playbackEnded: false,
      playbackState: "transport-ended-buffer-may-remain",
    });
    clock.advance(500);
    diagnostics.record("playback-progress", {}, token);
    expect(diagnostics.snapshot().summary).toMatchObject({
      transportEnded: true,
      playbackEnded: false,
      playbackState: "playing",
    });
    diagnostics.record("playback-end", {}, token);
    expect(diagnostics.snapshot().summary).toMatchObject({
      playbackEnded: true,
      postTransportDrainMs: 500,
    });
  });

  it("separates listener-open startup from Play-request startup", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    clock.advance(80_000);
    diagnostics.record("packet-received", { sequence: 0 }, token);
    clock.advance(44_000);
    diagnostics.record("play-request", {}, token);
    clock.advance(900);
    diagnostics.record("playback-progress", { currentTimeSeconds: 1 }, token);

    expect(diagnostics.snapshot().summary).toMatchObject({
      startupMs: 124_900,
      playRequestToPlaybackMs: 900,
    });
  });

  it("freezes broadcaster throughput against capture time after recorder stop", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("broadcaster", clock);
    diagnostics.record("recorder-data", { bytes: 60_000 }, token);
    diagnostics.record(
      "packet-send-result",
      { bytes: 1, outcome: "accepted" },
      token,
    );
    clock.advance(60_000);
    diagnostics.record("recorder-stop", {}, token);
    const completed = diagnostics.snapshot();
    clock.advance(120_000);
    const exportedLater = diagnostics.snapshot();

    expect(completed.summary.generatedBytesPerSecond).toBe(1_000);
    expect(exportedLater.summary.generatedBytesPerSecond).toBe(1_000);
    expect(exportedLater.summary.activeElapsedMs).toBe(60_000);
    expect(exportedLater.summary.elapsedMs).toBe(180_000);
  });

  it("accounts for a capacity-exhausted recorder tail without a generic error", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("broadcaster", clock);
    diagnostics.record(
      "recorder-tail-discarded",
      { bytes: 3_253, reason: "packet-capacity-exhausted" },
      token,
    );
    expect(diagnostics.snapshot().summary).toMatchObject({
      unsentTrailingChunks: 1,
      unsentTrailingBytes: 3_253,
      discardedSegments: 1,
      discardedBytes: 3_253,
      errors: 0,
    });
  });

  it("preserves terminal and error milestones while dropping routine samples", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("listener", clock);
    diagnostics.record("play-request", {}, token);
    for (let index = 0; index < MAX_DIAGNOSTIC_EVENTS + 30; index += 1) {
      diagnostics.record("poll-start", { pollAttempt: index }, token);
    }
    diagnostics.record("transport-end", {}, token);
    diagnostics.record("media-source-end", {}, token);
    diagnostics.record("playback-end", {}, token);
    const kinds = diagnostics.snapshot().events.map((event) => event.kind);
    expect(kinds).toContain("session-start");
    expect(kinds).toContain("play-request");
    expect(kinds).toContain("transport-end");
    expect(kinds).toContain("media-source-end");
    expect(kinds).toContain("playback-end");
  });

  it("exports allowlisted cleanup stages without raw error material", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("broadcaster", clock);
    diagnostics.record(
      "cleanup-stage",
      {
        stage: "failed",
        role: "sweep",
        nonce: "42",
        hash: `0x${"2".repeat(64)}`,
        receiptResult: "unknown",
        errorClass: "receipt-timeout",
        rawTransaction: "0xsecret",
        rpcUrl: "https://secret.invalid",
      },
      token,
    );
    const exported = diagnostics.exportJson();
    expect(exported).toContain("receipt-timeout");
    expect(exported).not.toContain("0xsecret");
    expect(exported).not.toContain("secret.invalid");
  });

  it("bounds memory and strips sensitive or unapproved export fields", () => {
    const clock = new TestClock();
    const { diagnostics, token } = begin("broadcaster", clock);
    for (let index = 0; index < MAX_DIAGNOSTIC_EVENTS + 40; index += 1) {
      diagnostics.record(
        "error",
        {
          reason: `failure-${index}`,
          rpcUrl: "https://secret.example/token",
          calldata: "0xdeadbeef",
          privateKey: "not-for-export",
        },
        token,
      );
    }
    const report = diagnostics.snapshot();
    const exported = diagnostics.exportJson();
    expect(report.events).toHaveLength(MAX_DIAGNOSTIC_EVENTS);
    expect(report.summary.boundedEventsDropped).toBe(41);
    expect(exported).not.toContain("secret.example");
    expect(exported).not.toContain("deadbeef");
    expect(exported).not.toContain("not-for-export");
  });

  it("does not change the fixture transport sequence when instrumentation is present or fails", () => {
    const runFixture = (diagnostics?: MediaDiagnosticsSession): string[] => {
      const operations: string[] = [];
      operations.push("capture", "enqueue", "sign", "send", "observe", "dwell");
      diagnostics?.record("recorder-data", { bytes: 64 });
      diagnostics?.record("packet-send-attempt", { sequence: 0 });
      diagnostics?.record("packet-observed", { sequence: 0, durationMs: 10 });
      return operations;
    };
    const clock = new TestClock();
    const { diagnostics } = begin("broadcaster", clock);
    expect(runFixture(diagnostics)).toEqual(runFixture());

    const poisonousDetails = Object.defineProperty({}, "bytes", {
      enumerable: true,
      get: () => {
        throw new Error("metrics unavailable");
      },
    });
    expect(() =>
      diagnostics.record("recorder-data", poisonousDetails),
    ).not.toThrow();
    expect(runFixture(diagnostics)).toEqual(runFixture());
  });
});
