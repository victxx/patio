export const MEDIA_DIAGNOSTICS_VERSION = 2 as const;
export const MAX_DIAGNOSTIC_EVENTS = 512;

export type MediaDiagnosticRole = "broadcaster" | "listener";

export interface MediaDiagnosticIdentity {
  runId: string;
  role: MediaDiagnosticRole;
  chainId: number;
  sessionAddress: string;
  streamId: string;
}

export type MediaDiagnosticEventKind =
  | "session-start"
  | "session-end"
  | "recorder-start"
  | "recorder-stop"
  | "recorder-data"
  | "recorder-pause"
  | "recorder-resume"
  | "queue-enter"
  | "queue-leave"
  | "segment-framed"
  | "packet-send-attempt"
  | "packet-send-result"
  | "packet-observed"
  | "replacement-dwell"
  | "budget-exhausted"
  | "recorder-tail-discarded"
  | "media-drop"
  | "cleanup-stage"
  | "poll-start"
  | "poll-complete"
  | "poll-error"
  | "packet-received"
  | "packet-duplicate"
  | "packet-invalid"
  | "packet-out-of-order"
  | "segment-complete"
  | "segment-incomplete"
  | "sync-wait"
  | "append-requested"
  | "append-complete"
  | "append-failed"
  | "append-aborted"
  | "buffer-sample"
  | "play-request"
  | "autoplay-blocked"
  | "playback-start"
  | "playback-progress"
  | "playback-waiting"
  | "playback-resume"
  | "playback-pause-user"
  | "playback-pause-other"
  | "playback-seek"
  | "transport-end"
  | "media-source-end"
  | "playback-end"
  | "video-frame"
  | "audio-state"
  | "error";

type SafeDiagnosticValue = string | number | boolean | null;

export interface MediaDiagnosticEvent {
  id: number;
  kind: MediaDiagnosticEventKind;
  atPerfMs: number;
  details: Readonly<Record<string, SafeDiagnosticValue>>;
}

export interface MediaDiagnosticParameters {
  mediaMode: "audio" | "video" | "video-beta";
  recorderTimesliceMs?: number;
  listenerPollIntervalMs?: number;
  broadcasterObserverPollIntervalMs?: number;
  videoPacketDwellMs?: number;
  codec?: string;
}

export interface MediaDiagnosticSummary {
  elapsedMs: number;
  activeElapsedMs: number;
  encoderBytes: number;
  enqueuedBytes: number;
  transportBytes: number;
  discardedBytes: number;
  unsentTrailingChunks: number;
  unsentTrailingBytes: number;
  generatedBytesPerSecond: number;
  sentPacketsPerSecond: number;
  segments: number;
  fragments: number;
  queueDepth: number;
  maximumQueueDepth: number;
  oldestQueueAgeMs: number;
  recorderPauses: number;
  recorderResumes: number;
  packetsAttempted: number;
  acceptedTransportBytes: number;
  uncertainTransportBytes: number;
  rejectedTransportBytes: number;
  packetsAccepted: number;
  packetsUncertain: number;
  packetsRejected: number;
  packetsObserved: number;
  meanPollingObservationMs: number | null;
  polls: number;
  pollErrors: number;
  meanPollIntervalMs: number | null;
  meanPollDurationMs: number | null;
  packetsReceived: number;
  duplicates: number;
  invalidPackets: number;
  outOfOrderPackets: number;
  observedSequenceGaps: number;
  completedSegments: number;
  incompleteSegments: number;
  discardedSegments: number;
  appendsRequested: number;
  appendsCompleted: number;
  appendsFailed: number;
  startupMs: number | null;
  playRequestToPlaybackMs: number | null;
  interruptions: number;
  interruptionDurationMs: number;
  bufferAheadSeconds: number;
  localContentDistanceSeconds: number | null;
  automaticSeekSeconds: number;
  initialPositioningSeeks: number;
  initialPositioningSeekSeconds: number;
  midPlaybackSeeks: number;
  midPlaybackSeekSeconds: number;
  postTransportDrainMs: number | null;
  presentedFrames: number | null;
  droppedPlaybackFrames: number | null;
  playbackState: string;
  transportEnded: boolean;
  playbackEnded: boolean;
  errors: number;
  boundedEventsDropped: number;
}

export interface MediaDiagnosticReport {
  version: typeof MEDIA_DIAGNOSTICS_VERSION;
  scope: "single-session";
  identity: MediaDiagnosticIdentity;
  parameters: MediaDiagnosticParameters;
  createdAtIso: string;
  exportedAtIso: string;
  clock: {
    durationClock: "performance.now";
    crossDeviceLatency: "not-available-without-a-defensible-shared-clock";
    packetTimestampMeaning: "queue-processing-wall-clock";
  };
  summary: MediaDiagnosticSummary;
  events: readonly MediaDiagnosticEvent[];
}

export interface BufferedRangeLike {
  start(index: number): number;
  end(index: number): number;
  readonly length: number;
}

export interface SequenceGapAssessment {
  firstObservedSequence: number | null;
  lastObservedSequence: number | null;
  observedIntervalSize: number;
  uniqueReceived: number;
  observedGaps: number;
  terminalSequenceKnown: boolean;
}

interface MutableSummary extends MediaDiagnosticSummary {
  observationTotalMs: number;
  observationSamples: number;
  pollDurationTotalMs: number;
  pollDurationSamples: number;
  pollIntervalTotalMs: number;
  pollIntervalSamples: number;
}

export interface MediaDiagnosticClock {
  now(): number;
  wallNow(): number;
}

const DEFAULT_CLOCK: MediaDiagnosticClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
};

const SAFE_DETAIL_KEYS = new Set([
  "appendId",
  "audioContextState",
  "bufferAheadSeconds",
  "bytes",
  "chunkId",
  "codec",
  "contentDurationMs",
  "currentTimeSeconds",
  "depth",
  "distanceSeconds",
  "droppedVideoFrames",
  "durationMs",
  "errorClass",
  "fragmentCount",
  "fragmentIndex",
  "hash",
  "hidden",
  "mediaTimeSeconds",
  "muted",
  "outcome",
  "phase",
  "pollAttempt",
  "presentedFrames",
  "reason",
  "receiptResult",
  "replacementIndex",
  "segmentIndex",
  "sequence",
  "skippedSeconds",
  "status",
  "stage",
  "transportBytes",
  "volume",
  "windowIndex",
  "nonce",
  "role",
]);

function emptySummary(): MutableSummary {
  return {
    elapsedMs: 0,
    activeElapsedMs: 0,
    encoderBytes: 0,
    enqueuedBytes: 0,
    transportBytes: 0,
    discardedBytes: 0,
    unsentTrailingChunks: 0,
    unsentTrailingBytes: 0,
    generatedBytesPerSecond: 0,
    sentPacketsPerSecond: 0,
    segments: 0,
    fragments: 0,
    queueDepth: 0,
    maximumQueueDepth: 0,
    oldestQueueAgeMs: 0,
    recorderPauses: 0,
    recorderResumes: 0,
    packetsAttempted: 0,
    acceptedTransportBytes: 0,
    uncertainTransportBytes: 0,
    rejectedTransportBytes: 0,
    packetsAccepted: 0,
    packetsUncertain: 0,
    packetsRejected: 0,
    packetsObserved: 0,
    meanPollingObservationMs: null,
    polls: 0,
    pollErrors: 0,
    meanPollIntervalMs: null,
    meanPollDurationMs: null,
    packetsReceived: 0,
    duplicates: 0,
    invalidPackets: 0,
    outOfOrderPackets: 0,
    observedSequenceGaps: 0,
    completedSegments: 0,
    incompleteSegments: 0,
    discardedSegments: 0,
    appendsRequested: 0,
    appendsCompleted: 0,
    appendsFailed: 0,
    startupMs: null,
    playRequestToPlaybackMs: null,
    interruptions: 0,
    interruptionDurationMs: 0,
    bufferAheadSeconds: 0,
    localContentDistanceSeconds: null,
    automaticSeekSeconds: 0,
    initialPositioningSeeks: 0,
    initialPositioningSeekSeconds: 0,
    midPlaybackSeeks: 0,
    midPlaybackSeekSeconds: 0,
    postTransportDrainMs: null,
    presentedFrames: null,
    droppedPlaybackFrames: null,
    playbackState: "idle",
    transportEnded: false,
    playbackEnded: false,
    errors: 0,
    boundedEventsDropped: 0,
    observationTotalMs: 0,
    observationSamples: 0,
    pollDurationTotalMs: 0,
    pollDurationSamples: 0,
    pollIntervalTotalMs: 0,
    pollIntervalSamples: 0,
  };
}

function ephemeralRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `patio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function sanitizeDetails(
  details: Readonly<Record<string, unknown>>,
): Record<string, SafeDiagnosticValue> {
  const safe: Record<string, SafeDiagnosticValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === null
    ) {
      safe[key] = typeof value === "string" ? value.slice(0, 180) : value;
      continue;
    }
    const numeric = finiteNonNegative(value);
    if (numeric !== null) safe[key] = numeric;
  }
  return safe;
}

export function continuousBufferAhead(
  ranges: BufferedRangeLike,
  currentTime: number,
): number {
  for (let index = 0; index < ranges.length; index += 1) {
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (currentTime >= start && currentTime <= end) {
      return Math.max(0, end - currentTime);
    }
  }
  return 0;
}

export function assessObservedSequenceGaps(
  sequences: Iterable<number>,
  terminalSequence?: number,
): SequenceGapAssessment {
  const ordered = [...new Set(sequences)]
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .toSorted((left, right) => left - right);
  if (ordered.length === 0) {
    return {
      firstObservedSequence: null,
      lastObservedSequence: null,
      observedIntervalSize: 0,
      uniqueReceived: 0,
      observedGaps: 0,
      terminalSequenceKnown: terminalSequence !== undefined,
    };
  }
  const first = ordered[0] ?? 0;
  const last = ordered.at(-1) ?? first;
  let gaps = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    gaps += Math.max(0, (ordered[index] ?? 0) - (ordered[index - 1] ?? 0) - 1);
  }
  if (terminalSequence !== undefined && terminalSequence > last) {
    gaps += terminalSequence - last;
  }
  return {
    firstObservedSequence: first,
    lastObservedSequence: last,
    observedIntervalSize:
      (terminalSequence === undefined
        ? last
        : Math.max(last, terminalSequence)) -
      first +
      1,
    uniqueReceived: ordered.length,
    observedGaps: gaps,
    terminalSequenceKnown: terminalSequence !== undefined,
  };
}

export function compareMediaDiagnosticReports(
  broadcaster: MediaDiagnosticReport,
  listener: MediaDiagnosticReport,
): {
  sameSession: boolean;
  matchedHashes: number;
  crossDeviceLatencyMs: null;
  explanation: string;
} {
  const broadcasterHashes = new Set(
    broadcaster.events
      .map((event) => event.details.hash)
      .filter((hash): hash is string => typeof hash === "string"),
  );
  const listenerHashes = new Set(
    listener.events
      .map((event) => event.details.hash)
      .filter((hash): hash is string => typeof hash === "string"),
  );
  return {
    sameSession:
      broadcaster.identity.chainId === listener.identity.chainId &&
      broadcaster.identity.sessionAddress.toLowerCase() ===
        listener.identity.sessionAddress.toLowerCase() &&
      broadcaster.identity.streamId.toLowerCase() ===
        listener.identity.streamId.toLowerCase(),
    matchedHashes: [...broadcasterHashes].filter((hash) =>
      listenerHashes.has(hash),
    ).length,
    crossDeviceLatencyMs: null,
    explanation:
      "performance.now values from different browser contexts are not subtracted; hashes and sequence metadata provide correlation only.",
  };
}

export class MediaDiagnosticsSession {
  private identity: MediaDiagnosticIdentity;
  private parameters: MediaDiagnosticParameters;
  private events: MediaDiagnosticEvent[] = [];
  private summary = emptySummary();
  private generation = 0;
  private nextEventId = 1;
  private startedAtPerfMs: number;
  private createdAtMs: number;
  private queueEntries = new Map<string, number>();
  private interruptionStartedAtMs: number | null = null;
  private firstPlaybackObserved = false;
  private lastReceivedSequence: number | null = null;
  private observedSequences = new Set<number>();
  private incompleteSegmentIds = new Set<number>();
  private lastPollStartedAtMs: number | null = null;
  private activeEndedAtPerfMs: number | null = null;
  private playRequestedAtPerfMs: number | null = null;
  private transportEndedAtPerfMs: number | null = null;

  public constructor(
    role: MediaDiagnosticRole,
    chainId = 0,
    clock: MediaDiagnosticClock = DEFAULT_CLOCK,
  ) {
    this.clock = clock;
    this.startedAtPerfMs = clock.now();
    this.createdAtMs = clock.wallNow();
    this.identity = {
      runId: ephemeralRunId(),
      role,
      chainId,
      sessionAddress: "unassigned",
      streamId: "unassigned",
    };
    this.parameters = {
      mediaMode: "audio",
    };
  }

  private readonly clock: MediaDiagnosticClock;

  public begin(
    identity: Omit<MediaDiagnosticIdentity, "runId" | "role">,
    parameters: MediaDiagnosticParameters,
  ): number {
    this.generation += 1;
    this.nextEventId = 1;
    this.startedAtPerfMs = this.clock.now();
    this.createdAtMs = this.clock.wallNow();
    this.events = [];
    this.summary = emptySummary();
    this.queueEntries.clear();
    this.interruptionStartedAtMs = null;
    this.firstPlaybackObserved = false;
    this.lastReceivedSequence = null;
    this.observedSequences.clear();
    this.incompleteSegmentIds.clear();
    this.lastPollStartedAtMs = null;
    this.activeEndedAtPerfMs = null;
    this.playRequestedAtPerfMs = null;
    this.transportEndedAtPerfMs = null;
    this.identity = {
      ...identity,
      runId: ephemeralRunId(),
      role: this.identity.role,
    };
    this.parameters = { ...parameters };
    this.record("session-start", {}, this.generation);
    return this.generation;
  }

  public token(): number {
    return this.generation;
  }

  public close(token = this.generation): void {
    this.record("session-end", {}, token);
    this.generation += 1;
  }

  public record(
    kind: MediaDiagnosticEventKind,
    details: Readonly<Record<string, unknown>> = {},
    token = this.generation,
  ): void {
    try {
      this.recordInternal(kind, details, token);
    } catch {
      // Diagnostics are deliberately fail-open: they never control media,
      // transaction submission, observation, playback or cleanup.
    }
  }

  private recordInternal(
    kind: MediaDiagnosticEventKind,
    details: Readonly<Record<string, unknown>>,
    token: number,
  ): void {
    if (token !== this.generation) return;
    const atPerfMs = this.clock.now();
    const safeDetails = sanitizeDetails(details);
    const event: MediaDiagnosticEvent = {
      id: this.nextEventId,
      kind,
      atPerfMs: Math.max(0, atPerfMs - this.startedAtPerfMs),
      details: safeDetails,
    };
    this.nextEventId += 1;
    this.events.push(event);
    if (this.events.length > MAX_DIAGNOSTIC_EVENTS) {
      const routineKinds = new Set<MediaDiagnosticEventKind>([
        "poll-start",
        "poll-complete",
        "buffer-sample",
        "playback-progress",
        "video-frame",
        "audio-state",
      ]);
      const removableIndex = this.events.findIndex((candidate) =>
        routineKinds.has(candidate.kind),
      );
      this.events.splice(removableIndex >= 0 ? removableIndex : 0, 1);
      this.summary.boundedEventsDropped += 1;
    }
    this.applyEvent(kind, safeDetails, atPerfMs);
  }

  private applyEvent(
    kind: MediaDiagnosticEventKind,
    details: Readonly<Record<string, SafeDiagnosticValue>>,
    absolutePerfMs: number,
  ): void {
    const numeric = (key: string): number =>
      typeof details[key] === "number" ? details[key] : 0;
    switch (kind) {
      case "session-end":
        this.activeEndedAtPerfMs ??= absolutePerfMs;
        break;
      case "recorder-data":
        this.summary.encoderBytes += numeric("bytes");
        break;
      case "recorder-stop":
        this.activeEndedAtPerfMs ??= absolutePerfMs;
        break;
      case "recorder-pause":
        this.summary.recorderPauses += 1;
        break;
      case "recorder-resume":
        this.summary.recorderResumes += 1;
        break;
      case "queue-enter": {
        const chunkId = details.chunkId;
        if (typeof chunkId === "string") {
          this.queueEntries.set(chunkId, absolutePerfMs);
        }
        this.summary.queueDepth = numeric("depth");
        this.summary.enqueuedBytes += numeric("bytes");
        this.summary.maximumQueueDepth = Math.max(
          this.summary.maximumQueueDepth,
          this.summary.queueDepth,
        );
        break;
      }
      case "queue-leave": {
        const chunkId = details.chunkId;
        if (typeof chunkId === "string") this.queueEntries.delete(chunkId);
        this.summary.queueDepth = numeric("depth");
        break;
      }
      case "segment-framed":
        this.summary.segments += 1;
        this.summary.fragments += numeric("fragmentCount");
        break;
      case "packet-send-attempt":
        this.summary.packetsAttempted += 1;
        this.summary.transportBytes += numeric("bytes");
        break;
      case "packet-send-result": {
        const outcome = details.outcome;
        if (outcome === "accepted") {
          this.summary.packetsAccepted += 1;
          this.summary.acceptedTransportBytes += numeric("bytes");
        } else if (outcome === "uncertain") {
          this.summary.packetsUncertain += 1;
          this.summary.uncertainTransportBytes += numeric("bytes");
        } else if (outcome === "rejected") {
          this.summary.packetsRejected += 1;
          this.summary.rejectedTransportBytes += numeric("bytes");
        }
        break;
      }
      case "packet-observed":
        this.summary.packetsObserved += 1;
        this.summary.observationTotalMs += numeric("durationMs");
        this.summary.observationSamples += 1;
        break;
      case "poll-start":
        if (this.lastPollStartedAtMs !== null) {
          this.summary.pollIntervalTotalMs += Math.max(
            0,
            absolutePerfMs - this.lastPollStartedAtMs,
          );
          this.summary.pollIntervalSamples += 1;
        }
        this.lastPollStartedAtMs = absolutePerfMs;
        break;
      case "poll-complete":
        this.summary.polls += 1;
        this.summary.pollDurationTotalMs += numeric("durationMs");
        this.summary.pollDurationSamples += 1;
        break;
      case "poll-error":
        this.summary.pollErrors += 1;
        break;
      case "packet-received": {
        this.summary.packetsReceived += 1;
        const sequence = numeric("sequence");
        if (
          this.lastReceivedSequence !== null &&
          sequence < this.lastReceivedSequence
        ) {
          this.summary.outOfOrderPackets += 1;
        }
        this.lastReceivedSequence = Math.max(
          this.lastReceivedSequence ?? sequence,
          sequence,
        );
        this.observedSequences.add(sequence);
        this.summary.observedSequenceGaps = assessObservedSequenceGaps(
          this.observedSequences,
        ).observedGaps;
        break;
      }
      case "packet-duplicate":
        this.summary.duplicates += 1;
        break;
      case "packet-invalid":
        this.summary.invalidPackets += 1;
        break;
      case "packet-out-of-order":
        this.summary.outOfOrderPackets += 1;
        break;
      case "segment-complete":
        this.summary.completedSegments += 1;
        if (typeof details.segmentIndex === "number") {
          this.incompleteSegmentIds.delete(details.segmentIndex);
          this.summary.incompleteSegments = this.incompleteSegmentIds.size;
        }
        break;
      case "segment-incomplete":
        if (typeof details.segmentIndex === "number") {
          this.incompleteSegmentIds.add(details.segmentIndex);
          this.summary.incompleteSegments = this.incompleteSegmentIds.size;
        }
        break;
      case "media-drop":
        this.summary.discardedSegments += 1;
        this.summary.discardedBytes += numeric("bytes");
        break;
      case "recorder-tail-discarded":
        this.summary.unsentTrailingChunks += 1;
        this.summary.unsentTrailingBytes += numeric("bytes");
        this.summary.discardedSegments += 1;
        this.summary.discardedBytes += numeric("bytes");
        break;
      case "append-requested":
        this.summary.appendsRequested += 1;
        break;
      case "append-complete":
        this.summary.appendsCompleted += 1;
        break;
      case "append-failed":
      case "append-aborted":
        this.summary.appendsFailed += 1;
        break;
      case "buffer-sample":
        this.summary.bufferAheadSeconds = numeric("bufferAheadSeconds");
        this.summary.localContentDistanceSeconds =
          typeof details.distanceSeconds === "number"
            ? details.distanceSeconds
            : null;
        break;
      case "autoplay-blocked":
        this.summary.playbackState = "autoplay-blocked";
        break;
      case "play-request":
        if (
          !this.firstPlaybackObserved &&
          this.playRequestedAtPerfMs === null
        ) {
          this.playRequestedAtPerfMs = absolutePerfMs;
        }
        break;
      case "playback-start":
        this.summary.playbackState = "starting";
        break;
      case "playback-resume":
        this.summary.playbackState = "resuming";
        break;
      case "playback-progress":
        if (!this.firstPlaybackObserved) {
          this.summary.startupMs = Math.max(
            0,
            absolutePerfMs - this.startedAtPerfMs,
          );
          this.firstPlaybackObserved = true;
          this.summary.playRequestToPlaybackMs =
            this.playRequestedAtPerfMs === null
              ? null
              : Math.max(0, absolutePerfMs - this.playRequestedAtPerfMs);
        }
        if (this.interruptionStartedAtMs !== null) {
          this.summary.interruptionDurationMs += Math.max(
            0,
            absolutePerfMs - this.interruptionStartedAtMs,
          );
          this.interruptionStartedAtMs = null;
        }
        this.summary.playbackState = "playing";
        break;
      case "playback-waiting":
        if (
          this.firstPlaybackObserved &&
          this.interruptionStartedAtMs === null
        ) {
          this.summary.interruptions += 1;
          this.interruptionStartedAtMs = absolutePerfMs;
        }
        this.summary.playbackState = this.firstPlaybackObserved
          ? "rebuffering"
          : "starting";
        break;
      case "playback-pause-user":
        if (this.interruptionStartedAtMs !== null) {
          this.summary.interruptionDurationMs += Math.max(
            0,
            absolutePerfMs - this.interruptionStartedAtMs,
          );
        }
        this.summary.playbackState = "paused-by-user";
        this.interruptionStartedAtMs = null;
        break;
      case "playback-pause-other":
        this.summary.playbackState = "paused";
        break;
      case "playback-seek":
        if (details.phase === "initial") {
          this.summary.automaticSeekSeconds += numeric("skippedSeconds");
          this.summary.initialPositioningSeeks += 1;
          this.summary.initialPositioningSeekSeconds +=
            numeric("skippedSeconds");
        } else if (details.phase !== "user") {
          this.summary.automaticSeekSeconds += numeric("skippedSeconds");
          this.summary.midPlaybackSeeks += 1;
          this.summary.midPlaybackSeekSeconds += numeric("skippedSeconds");
        }
        this.summary.playbackState = "seeking";
        break;
      case "transport-end":
        this.summary.transportEnded = true;
        this.transportEndedAtPerfMs ??= absolutePerfMs;
        this.summary.playbackState = "transport-ended-buffer-may-remain";
        break;
      case "media-source-end":
        this.summary.playbackState = "draining-after-transport-end";
        break;
      case "playback-end":
        this.summary.playbackEnded = true;
        if (this.interruptionStartedAtMs !== null) {
          this.summary.interruptionDurationMs += Math.max(
            0,
            absolutePerfMs - this.interruptionStartedAtMs,
          );
          this.interruptionStartedAtMs = null;
        }
        this.activeEndedAtPerfMs ??= absolutePerfMs;
        this.summary.postTransportDrainMs =
          this.transportEndedAtPerfMs === null
            ? null
            : Math.max(0, absolutePerfMs - this.transportEndedAtPerfMs);
        this.summary.playbackState = "content-ended";
        break;
      case "video-frame":
        this.summary.presentedFrames = numeric("presentedFrames");
        if (typeof details.droppedVideoFrames === "number") {
          this.summary.droppedPlaybackFrames = details.droppedVideoFrames;
        }
        if (!this.firstPlaybackObserved) {
          this.summary.startupMs = Math.max(
            0,
            absolutePerfMs - this.startedAtPerfMs,
          );
          this.firstPlaybackObserved = true;
          this.summary.playRequestToPlaybackMs =
            this.playRequestedAtPerfMs === null
              ? null
              : Math.max(0, absolutePerfMs - this.playRequestedAtPerfMs);
        }
        if (this.interruptionStartedAtMs !== null) {
          this.summary.interruptionDurationMs += Math.max(
            0,
            absolutePerfMs - this.interruptionStartedAtMs,
          );
          this.interruptionStartedAtMs = null;
        }
        this.summary.playbackState = "playing";
        break;
      case "error":
        this.summary.errors += 1;
        break;
      default:
        break;
    }
  }

  public snapshot(): MediaDiagnosticReport {
    const now = this.clock.now();
    const elapsedMs = Math.max(0, now - this.startedAtPerfMs);
    const activeElapsedMs = Math.max(
      0,
      (this.activeEndedAtPerfMs ?? now) - this.startedAtPerfMs,
    );
    const oldestQueueEntry = Math.min(...this.queueEntries.values());
    const elapsedSeconds = activeElapsedMs / 1_000;
    const summary: MediaDiagnosticSummary = {
      ...this.summary,
      elapsedMs,
      activeElapsedMs,
      generatedBytesPerSecond:
        elapsedSeconds > 0 ? this.summary.encoderBytes / elapsedSeconds : 0,
      sentPacketsPerSecond:
        elapsedSeconds > 0 ? this.summary.packetsAccepted / elapsedSeconds : 0,
      oldestQueueAgeMs:
        this.queueEntries.size > 0 && Number.isFinite(oldestQueueEntry)
          ? Math.max(0, now - oldestQueueEntry)
          : 0,
      meanPollingObservationMs:
        this.summary.observationSamples > 0
          ? this.summary.observationTotalMs / this.summary.observationSamples
          : null,
      meanPollDurationMs:
        this.summary.pollDurationSamples > 0
          ? this.summary.pollDurationTotalMs / this.summary.pollDurationSamples
          : null,
      meanPollIntervalMs:
        this.summary.pollIntervalSamples > 0
          ? this.summary.pollIntervalTotalMs / this.summary.pollIntervalSamples
          : null,
      interruptionDurationMs:
        this.summary.interruptionDurationMs +
        (this.interruptionStartedAtMs === null
          ? 0
          : Math.max(0, now - this.interruptionStartedAtMs)),
    };
    delete (summary as Partial<MutableSummary>).observationTotalMs;
    delete (summary as Partial<MutableSummary>).observationSamples;
    delete (summary as Partial<MutableSummary>).pollDurationTotalMs;
    delete (summary as Partial<MutableSummary>).pollDurationSamples;
    delete (summary as Partial<MutableSummary>).pollIntervalTotalMs;
    delete (summary as Partial<MutableSummary>).pollIntervalSamples;
    return {
      version: MEDIA_DIAGNOSTICS_VERSION,
      scope: "single-session",
      identity: { ...this.identity },
      parameters: { ...this.parameters },
      createdAtIso: new Date(this.createdAtMs).toISOString(),
      exportedAtIso: new Date(this.clock.wallNow()).toISOString(),
      clock: {
        durationClock: "performance.now",
        crossDeviceLatency: "not-available-without-a-defensible-shared-clock",
        packetTimestampMeaning: "queue-processing-wall-clock",
      },
      summary,
      events: this.events.map((event) => ({
        ...event,
        details: { ...event.details },
      })),
    };
  }

  public exportJson(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }
}
