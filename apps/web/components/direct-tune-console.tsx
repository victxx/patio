"use client";
import { createClassicEndProbe } from "../lib/classic-listener-end";

import type { PrivateRetirementEnvironment } from "../lib/private-retirement-environment";
import { readCanonicalRetirement } from "../lib/private-retirement-environment";

import {
  PATIO_MEDIA_TYPE,
  PATIO_VIDEO_MEDIA_TYPES,
  patioNetworkByChainId,
} from "@patio/config";
import {
  decodeVideoBetaPayload,
  decodeVideoFragment,
  packetFromHex,
  PatioCodec,
  PatioPacketType,
  VideoSegmentReassembler,
  type DecodedPatioPacketV1,
  type ReassembledVideoSegment,
} from "@patio/protocol";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createLegacyObserverRpc,
  assertRpcChain,
  DIRECT_OBSERVER_POLL_INTERVAL_MS,
  DIRECT_SESSION_STORAGE_KEY,
  flattenTxpoolTransactions,
  parseDirectSession,
  type DirectSessionDescriptor,
  type TxpoolTransaction,
} from "../lib/direct-hoodi";
import {
  networkRuntimeByChainId,
  type PatioNetworkRuntimeConfig,
} from "../lib/network-runtime";
import { prepareWebmMediaSourceChunk } from "../lib/webm";
import {
  AUDIO_STARTUP_MAX_WAIT_MS,
  audioDiscontinuityRecoveryPosition,
  chooseAudioStartupPosition,
  snapshotBufferedRanges,
} from "../lib/audio-playback-policy";
import { startObserverPolling } from "../lib/observer-polling";
import { stalledVideoRecoveryPosition } from "../lib/video-playback-policy";
import {
  continuousBufferAhead,
  MediaDiagnosticsSession,
} from "../lib/media-diagnostics";
import { MediaDiagnosticsPanel } from "./media-diagnostics-panel";
import {
  AudioPlayRequests,
  audioListenerPresentation,
  naturalAudioProgress,
} from "../lib/audio-listener-presentation";

const LiveReactions = dynamic(
  () => import("./live-reactions").then((module) => module.LiveReactions),
  { ssr: false },
);
const EMPTY_RPC_CONFIG = { url: "" } as const;

type TuneStatus = "off-air" | "waiting" | "live" | "ended";
type PlaybackMode = "audio" | "video" | "video-beta";

interface PacketProof {
  sequence: number;
  segmentIndex: number | null;
  fragmentIndex: number | null;
  fragmentCount: number | null;
  bytes: number;
  txHash: string;
  nonce: string;
  windowIndex: number;
}

function statusLabel(status: TuneStatus): string {
  if (status === "live") return "Live";
  if (status === "waiting") return "Waiting";
  if (status === "ended") return "Ended";
  return "Off air";
}

function storedSession(): DirectSessionDescriptor | null {
  const current = parseDirectSession(window.location.search);
  if (current) return current;
  const stored = localStorage.getItem(DIRECT_SESSION_STORAGE_KEY);
  if (!stored) return null;
  try {
    return parseDirectSession(new URL(stored).searchParams);
  } catch {
    return null;
  }
}

function videoMimeType(codec: PatioCodec): string {
  return codec === PatioCodec.WEBM_VP9_OPUS
    ? PATIO_VIDEO_MEDIA_TYPES[1]
    : PATIO_VIDEO_MEDIA_TYPES[0];
}

function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function packetGapCount(sequences: ReadonlySet<number>): number {
  const ordered = [...sequences].toSorted((left, right) => left - right);
  let gaps = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    gaps += Math.max(0, (ordered[index] ?? 0) - (ordered[index - 1] ?? 0) - 1);
  }
  return gaps;
}

async function drawVideoBetaFrame(
  canvas: HTMLCanvasElement,
  image: Uint8Array,
  width: number,
  height: number,
): Promise<void> {
  if (image.length === 0) return;
  const bitmap = await createImageBitmap(
    new Blob([image.slice().buffer], { type: "image/webp" }),
  );
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context?.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
}

export function DirectTuneConsole({
  networkConfigs,
  stationFrequency,
  privateFixture,
}: {
  networkConfigs: readonly PatioNetworkRuntimeConfig[];
  stationFrequency: string;
  /** Explicit private host injection, never activated by a URL/network profile. */
  privateFixture?: {
    environment: PrivateRetirementEnvironment;
    descriptor: DirectSessionDescriptor;
  };
}) {
  const [session, setSession] = useState<DirectSessionDescriptor | null>(null);
  const [status, setStatus] = useState<TuneStatus>("off-air");
  const [listening, setListening] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("audio");
  const [mediaMimeType, setMediaMimeType] = useState(PATIO_MEDIA_TYPE);
  const [packetCount, setPacketCount] = useState(0);
  const [packetGaps, setPacketGaps] = useState(0);
  const [segmentCount, setSegmentCount] = useState(0);
  const [lostSegments, setLostSegments] = useState(0);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [latestProof, setLatestProof] = useState<PacketProof | null>(null);
  const [observerError, setObserverError] = useState<string | null>(null);
  const [receptionStalled, setReceptionStalled] = useState(false);
  const lastPacketAtRef = useRef<number | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [audioCompatible, setAudioCompatible] = useState(false);
  const [observerReady, setObserverReady] = useState(false);
  const [audioIntent, setAudioIntent] = useState<"idle" | "listen" | "pause">(
    "idle",
  );
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioBlockReason, setAudioBlockReason] = useState<
    "permission" | "interrupted" | "unsupported" | null
  >(null);
  const [contextSuspended, setContextSuspended] = useState(false);
  const [playbackEnded, setPlaybackEnded] = useState(false);
  const [audioHasProgress, setAudioHasProgress] = useState(false);
  const audioPlayRef = useRef(new AudioPlayRequests());
  const audioStartupExpiredRef = useRef(false);
  const visualizerEpochRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const videoSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const visualizerFrameRef = useRef<number | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const diagnosticsRef = useRef<MediaDiagnosticsSession | null>(null);
  diagnosticsRef.current ??= new MediaDiagnosticsSession("listener");
  const diagnostics = diagnosticsRef.current;
  const diagnosticsTokenRef = useRef(0);
  const appendSequenceRef = useRef(0);
  const appendInFlightRef = useRef<{
    appendId: string;
    token: number;
  } | null>(null);
  const userPauseRequestedRef = useRef(false);
  const automaticSeekInProgressRef = useRef(false);
  const mediaWaitingRef = useRef(false);
  const lastNaturalProgressAtRef = useRef(0);
  const lastVideoRecoveryAtRef = useRef(0);
  const gapRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const gapRecoveryExpiredRef = useRef(false);
  const lastPlaybackSampleRef = useRef({ atMs: 0, currentTime: 0 });
  const videoFrameCallbackRef = useRef<number | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const mediaQueueRef = useRef<Uint8Array[]>([]);
  const parserResetChunksRef = useRef(new WeakSet<Uint8Array>());
  const audioNeedsSyncRef = useRef(false);
  const videoNeedsSyncRef = useRef(false);
  const audioPacketsRef = useRef(new Map<number, Uint8Array>());
  const audioStartSequenceRef = useRef<number | null>(null);
  const lastQueuedAudioSequenceRef = useRef(-1);
  const audioInitializationLengthRef = useRef<number | null>(null);
  const videoAssemblerRef = useRef(new VideoSegmentReassembler());
  const completedVideoSegmentsRef = useRef(
    new Map<number, ReassembledVideoSegment>(),
  );
  const nextVideoSegmentRef = useRef(0);
  const highestVideoSegmentRef = useRef(-1);
  const videoInitializationLengthRef = useRef<number | null>(null);
  const seenSequencesRef = useRef(new Set<number>());
  const mediaUrlRef = useRef<string | null>(null);
  const playbackRequestedRef = useRef(false);
  const audioStartupPositionedRef = useRef(false);
  const audioStartupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const transportEndedRef = useRef(false);
  const mediaSourceEndedRef = useRef(false);
  const sessionProfile = session
    ? patioNetworkByChainId(session.chainId)
    : undefined;
  const networkRuntime = session
    ? networkRuntimeByChainId(networkConfigs, session.chainId)
    : undefined;
  const observerRpc = networkRuntime?.observerRpc ?? EMPTY_RPC_CONFIG;

  const stopVisualizer = useCallback(() => {
    ++visualizerEpochRef.current;
    if (visualizerFrameRef.current !== null) {
      cancelAnimationFrame(visualizerFrameRef.current);
      visualizerFrameRef.current = null;
    }
    for (const source of [audioSourceRef.current, videoSourceRef.current]) {
      try {
        source?.disconnect();
      } catch {
        // A source can already be disconnected while switching sessions.
      }
    }
    try {
      analyserRef.current?.disconnect();
    } catch {
      // The analyser can already be disconnected during teardown.
    }
  }, []);

  const startVisualizer = useCallback(
    async (mediaElement: HTMLMediaElement, mode: PlaybackMode) => {
      stopVisualizer();
      const epoch = visualizerEpochRef.current;
      const context =
        audioContextRef.current ??
        new AudioContext({ latencyHint: "interactive" });
      audioContextRef.current = context;
      if (mode === "audio") {
        setContextSuspended(context.state !== "running");
        context.onstatechange = () => {
          if (epoch === visualizerEpochRef.current)
            setContextSuspended(context.state !== "running");
        };
      }
      if (context.state === "suspended") await context.resume();
      if (epoch !== visualizerEpochRef.current) return;
      const sourceRef = mode === "video" ? videoSourceRef : audioSourceRef;
      sourceRef.current ??= context.createMediaElementSource(mediaElement);
      const analyser = analyserRef.current ?? context.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.74;
      sourceRef.current.connect(analyser);
      analyser.connect(context.destination);
      const frequencies = new Uint8Array(analyser.frequencyBinCount);

      const paint = () => {
        analyser.getByteFrequencyData(frequencies);
        const bars = waveformRef.current?.children;
        if (bars) {
          for (let index = 0; index < bars.length; index += 1) {
            const bin = frequencies[index + 1] ?? 0;
            const level = Math.max(0.12, Math.min(1, bin / 190));
            (bars[index] as HTMLElement).style.transform = `scaleY(${level})`;
          }
        }
        visualizerFrameRef.current = requestAnimationFrame(paint);
      };
      paint();
    },
    [stopVisualizer],
  );

  const maybeFinalizeMediaSource = useCallback((): void => {
    const mediaSource = mediaSourceRef.current;
    const sourceBuffer = sourceBufferRef.current;
    if (
      !transportEndedRef.current ||
      mediaSourceEndedRef.current ||
      mediaQueueRef.current.length > 0 ||
      appendInFlightRef.current ||
      !mediaSource ||
      !sourceBuffer ||
      mediaSource.readyState !== "open" ||
      sourceBuffer.updating
    ) {
      return;
    }
    try {
      mediaSource.endOfStream();
      mediaSourceEndedRef.current = true;
      diagnostics.record(
        "media-source-end",
        { status: "queued-media-drained" },
        diagnosticsTokenRef.current,
      );
    } catch (cause) {
      diagnostics.record(
        "error",
        {
          errorClass:
            cause instanceof DOMException
              ? cause.name
              : "media-source-finalization",
          reason: "end-of-stream-failed",
        },
        diagnosticsTokenRef.current,
      );
      setPlaybackError("Patio could not finalize the remaining media buffer.");
    }
  }, [diagnostics]);

  const maybeStartAudioPlayback = useCallback(
    (force: boolean): void => {
      const audio = audioRef.current;
      const sourceBuffer = sourceBufferRef.current;
      if (
        !playbackRequestedRef.current ||
        userPauseRequestedRef.current ||
        !audio?.src ||
        !sourceBuffer ||
        sourceBuffer.updating ||
        appendInFlightRef.current ||
        mediaQueueRef.current.length > 0
      ) {
        return;
      }
      if (!audioStartupPositionedRef.current) {
        const decision = chooseAudioStartupPosition(
          snapshotBufferedRanges(audio.buffered),
          {
            force:
              force ||
              audioStartupExpiredRef.current ||
              transportEndedRef.current,
          },
        );
        if (!decision) return;
        const previousTime = audio.currentTime;
        if (Math.abs(decision.targetTime - previousTime) > 0.05) {
          diagnostics.record(
            "playback-seek",
            {
              currentTimeSeconds: previousTime,
              skippedSeconds: Math.abs(decision.targetTime - previousTime),
              reason: "initial-audio-position",
              phase: "initial",
            },
            diagnosticsTokenRef.current,
          );
          automaticSeekInProgressRef.current = true;
          audio.currentTime = decision.targetTime;
        }
        audioStartupPositionedRef.current = true;
        if (audioStartupTimerRef.current) {
          clearTimeout(audioStartupTimerRef.current);
          audioStartupTimerRef.current = null;
        }
      }
      if (!playbackRequestedRef.current || !audio.paused) return;
      audioPlayRef.current.attempt(audio, (reason) => {
        setAudioBlocked(true);
        setAudioBlockReason(reason);
        setPlaying(false);
        if (reason === "unsupported")
          setPlaybackError(
            "The browser could not decode this audio. The received buffer is retained; no replay/recovery is available here.",
          );
        diagnostics.record(
          reason === "permission" ? "autoplay-blocked" : "error",
          {
            reason: `audio-start-${reason}`,
            ...(reason === "permission"
              ? {}
              : { errorClass: `play-${reason}` }),
          },
          diagnosticsTokenRef.current,
        );
      });
    },
    [diagnostics],
  );

  const flushMediaQueue = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    const mediaSource = mediaSourceRef.current;
    const next = mediaQueueRef.current[0];
    if (
      !sourceBuffer ||
      !mediaSource ||
      mediaSource.readyState !== "open" ||
      sourceBuffer.updating
    ) {
      return;
    }
    const mediaElement = videoRef.current?.src
      ? videoRef.current
      : audioRef.current;
    const videoPlayback = Boolean(videoRef.current?.src);
    if (mediaElement && mediaElement.buffered.length > 0) {
      const ranges = snapshotBufferedRanges(mediaElement.buffered);
      let recoveryTime = audioDiscontinuityRecoveryPosition(
        ranges,
        mediaElement.currentTime,
        0.05,
        mediaWaitingRef.current,
      );
      if (
        videoPlayback &&
        mediaElement.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
      ) {
        recoveryTime = stalledVideoRecoveryPosition(
          ranges,
          mediaElement.currentTime,
          performance.now() -
            Math.max(
              lastNaturalProgressAtRef.current,
              lastVideoRecoveryAtRef.current,
            ),
        );
      }
      if (
        !videoPlayback &&
        recoveryTime !== null &&
        playbackRequestedRef.current &&
        !userPauseRequestedRef.current
      ) {
        const nextRange = ranges.find((range) => range.start === recoveryTime);
        // A recovered Cluster can initially contain only a few milliseconds.
        // Build one chunk of cushion rather than seek/play/stall on every append.
        if (
          nextRange &&
          nextRange.end - nextRange.start < 3 &&
          !transportEndedRef.current &&
          !gapRecoveryExpiredRef.current
        ) {
          if (gapRecoveryTimerRef.current === null) {
            gapRecoveryTimerRef.current = setTimeout(() => {
              gapRecoveryTimerRef.current = null;
              gapRecoveryExpiredRef.current = true;
              flushMediaQueue();
            }, AUDIO_STARTUP_MAX_WAIT_MS);
          }
          recoveryTime = null;
        } else {
          if (gapRecoveryTimerRef.current !== null)
            clearTimeout(gapRecoveryTimerRef.current);
          gapRecoveryTimerRef.current = null;
          gapRecoveryExpiredRef.current = false;
        }
      }
      if (
        videoPlayback &&
        playbackRequestedRef.current &&
        !userPauseRequestedRef.current &&
        recoveryTime !== null
      ) {
        const previousTime = mediaElement.currentTime;
        const targetTime = recoveryTime;
        diagnostics.record(
          "playback-seek",
          {
            currentTimeSeconds: previousTime,
            skippedSeconds: Math.abs(targetTime - previousTime),
            reason: "video-buffer-discontinuity",
            phase: "mid-playback",
          },
          diagnosticsTokenRef.current,
        );
        automaticSeekInProgressRef.current = true;
        lastVideoRecoveryAtRef.current = performance.now();
        mediaElement.currentTime = targetTime;
      }
      if (
        videoPlayback &&
        playbackRequestedRef.current &&
        !userPauseRequestedRef.current &&
        mediaElement.paused
      ) {
        audioPlayRef.current.attempt(mediaElement, (reason) => {
          setAudioBlocked(true);
          setAudioBlockReason(reason);
          diagnostics.record(
            reason === "permission" ? "autoplay-blocked" : "error",
            { reason: `video-resume-${reason}` },
            diagnosticsTokenRef.current,
          );
        });
      }
      if (
        !videoPlayback &&
        playbackRequestedRef.current &&
        !userPauseRequestedRef.current &&
        audioStartupPositionedRef.current
      ) {
        if (recoveryTime !== null) {
          const previousTime = mediaElement.currentTime;
          diagnostics.record(
            "playback-seek",
            {
              currentTimeSeconds: previousTime,
              skippedSeconds: Math.abs(recoveryTime - previousTime),
              reason: "audio-buffer-discontinuity",
              phase: "mid-playback",
            },
            diagnosticsTokenRef.current,
          );
          automaticSeekInProgressRef.current = true;
          mediaElement.currentTime = recoveryTime;
        }
      }
    }
    if (!next) {
      if (!videoPlayback) maybeStartAudioPlayback(false);
      maybeFinalizeMediaSource();
      return;
    }
    const appendId = `append-${++appendSequenceRef.current}`;
    try {
      if (parserResetChunksRef.current.has(next)) {
        // Reset the incomplete byte parser after packet loss, not buffered media.
        // Called only when !updating and MediaSource is open (guards above).
        sourceBuffer.abort();
        parserResetChunksRef.current.delete(next);
      }
      appendInFlightRef.current = {
        appendId,
        token: diagnosticsTokenRef.current,
      };
      diagnostics.record(
        "append-requested",
        { appendId, bytes: next.length },
        diagnosticsTokenRef.current,
      );
      sourceBuffer.appendBuffer(next.slice().buffer);
      mediaQueueRef.current.shift();
      if (videoPlayback && !videoRef.current?.error) setPlaybackError(null);
    } catch (cause) {
      appendInFlightRef.current = null;
      diagnostics.record(
        "append-failed",
        {
          appendId,
          errorClass:
            cause instanceof DOMException ? cause.name : "append-exception",
        },
        diagnosticsTokenRef.current,
      );
      if (
        cause instanceof DOMException &&
        cause.name === "QuotaExceededError" &&
        sourceBuffer.buffered.length > 0 &&
        mediaElement
      ) {
        const removeBefore = Math.max(0, mediaElement.currentTime - 12);
        if (removeBefore > sourceBuffer.buffered.start(0)) {
          sourceBuffer.remove(sourceBuffer.buffered.start(0), removeBefore);
          return;
        }
      }
      setPlaybackError(
        videoPlayback
          ? "Live playback lost sync. Pause and press play to reconnect."
          : "Audio could not be appended. The available buffer is retained; no automatic replay or reload.",
      );
    }
  }, [diagnostics, maybeFinalizeMediaSource, maybeStartAudioPlayback]);

  const handleSourceBufferUpdateEnd = useCallback(() => {
    const inFlight = appendInFlightRef.current;
    if (inFlight) {
      diagnostics.record(
        "append-complete",
        { appendId: inFlight.appendId },
        inFlight.token,
      );
      appendInFlightRef.current = null;
    }
    const element = videoRef.current?.src ? videoRef.current : audioRef.current;
    if (element) {
      const lastEnd =
        element.buffered.length > 0
          ? element.buffered.end(element.buffered.length - 1)
          : null;
      diagnostics.record(
        "buffer-sample",
        {
          currentTimeSeconds: element.currentTime,
          bufferAheadSeconds: continuousBufferAhead(
            element.buffered,
            element.currentTime,
          ),
          ...(lastEnd === null
            ? {}
            : { distanceSeconds: Math.max(0, lastEnd - element.currentTime) }),
        },
        diagnosticsTokenRef.current,
      );
    }
    flushMediaQueue();
    maybeFinalizeMediaSource();
  }, [diagnostics, flushMediaQueue, maybeFinalizeMediaSource]);

  const handleSourceBufferError = useCallback(() => {
    const inFlight = appendInFlightRef.current;
    diagnostics.record(
      "append-failed",
      {
        ...(inFlight ? { appendId: inFlight.appendId } : {}),
        errorClass: "source-buffer-error",
      },
      inFlight?.token ?? diagnosticsTokenRef.current,
    );
    appendInFlightRef.current = null;
    setPlaybackError("Chrome could not append this Patio media segment.");
  }, [diagnostics]);

  const handleSourceBufferAbort = useCallback(() => {
    const inFlight = appendInFlightRef.current;
    diagnostics.record(
      "append-aborted",
      {
        ...(inFlight ? { appendId: inFlight.appendId } : {}),
        reason: "source-buffer-abort",
      },
      inFlight?.token ?? diagnosticsTokenRef.current,
    );
    appendInFlightRef.current = null;
  }, [diagnostics]);

  const queueOrderedAudio = useCallback(
    (diagnosticsToken = diagnosticsTokenRef.current) => {
      const startSequence = audioStartSequenceRef.current;
      if (startSequence === null) return;
      const nextPackets = [...audioPacketsRef.current.entries()]
        .filter(
          ([sequence]) =>
            sequence >= startSequence &&
            sequence > lastQueuedAudioSequenceRef.current,
        )
        .toSorted(([left], [right]) => left - right);
      for (const [sequence, payload] of nextPackets) {
        if (
          lastQueuedAudioSequenceRef.current >= 0 &&
          sequence > lastQueuedAudioSequenceRef.current + 1
        )
          audioNeedsSyncRef.current = true;
        const prepared = prepareWebmMediaSourceChunk(
          payload,
          audioInitializationLengthRef.current,
          audioNeedsSyncRef.current,
        );
        lastQueuedAudioSequenceRef.current = sequence;
        if (!prepared.payload.length) continue;
        if (prepared.resetParser) {
          parserResetChunksRef.current.add(prepared.payload);
          audioNeedsSyncRef.current = false;
        }
        mediaQueueRef.current.push(prepared.payload);
        diagnostics.record(
          "segment-complete",
          { sequence, bytes: prepared.payload.length },
          diagnosticsToken,
        );
        audioInitializationLengthRef.current = prepared.initializationLength;
        lastQueuedAudioSequenceRef.current = sequence;
      }
      flushMediaQueue();
    },
    [diagnostics, flushMediaQueue],
  );

  const queueOrderedVideo = useCallback(
    (diagnosticsToken = diagnosticsTokenRef.current) => {
      if (videoInitializationLengthRef.current === null) {
        const syncSegment = [...completedVideoSegmentsRef.current.values()]
          .filter((segment) => segment.initialization)
          .toSorted((left, right) => left.segmentIndex - right.segmentIndex)[0];
        if (!syncSegment) {
          diagnostics.record(
            "sync-wait",
            { reason: "video-initialization-not-observed" },
            diagnosticsToken,
          );
          if (highestVideoSegmentRef.current >= 2) {
            setPlaybackError("Waiting for the next Patio video sync point…");
          }
          return;
        }
        for (const segmentIndex of completedVideoSegmentsRef.current.keys()) {
          if (segmentIndex < syncSegment.segmentIndex) {
            completedVideoSegmentsRef.current.delete(segmentIndex);
            setLostSegments((current) => current + 1);
            diagnostics.record(
              "media-drop",
              { segmentIndex, reason: "before-late-sync-point" },
              diagnosticsToken,
            );
          }
        }
        nextVideoSegmentRef.current = syncSegment.segmentIndex;
        if (syncSegment.segmentIndex > 0) videoNeedsSyncRef.current = true;
        videoAssemblerRef.current.discardBefore(syncSegment.segmentIndex);
      }

      while (true) {
        const nextIndex = nextVideoSegmentRef.current;
        const segment = completedVideoSegmentsRef.current.get(nextIndex);
        if (segment) {
          completedVideoSegmentsRef.current.delete(nextIndex);
          const prepared = prepareWebmMediaSourceChunk(
            segment.bytes,
            videoInitializationLengthRef.current,
            videoNeedsSyncRef.current,
          );
          if (!prepared.payload.length) {
            nextVideoSegmentRef.current += 1;
            setLostSegments((current) => current + 1);
            continue;
          }
          if (prepared.initializationLength === null) {
            setPlaybackError("Waiting for the next Patio video sync point…");
            break;
          }
          videoInitializationLengthRef.current = prepared.initializationLength;
          if (prepared.resetParser) {
            parserResetChunksRef.current.add(prepared.payload);
            videoNeedsSyncRef.current = false;
          }
          mediaQueueRef.current.push(prepared.payload);
          nextVideoSegmentRef.current += 1;
          if (segment.initialization) {
            setMediaReady(true);
            if (!videoRef.current?.error) setPlaybackError(null);
          }
          continue;
        }
        if (highestVideoSegmentRef.current >= nextIndex + 2) {
          videoNeedsSyncRef.current = true;
          nextVideoSegmentRef.current += 1;
          videoAssemblerRef.current.discardBefore(nextVideoSegmentRef.current);
          setLostSegments((current) => current + 1);
          diagnostics.record(
            "segment-incomplete",
            { segmentIndex: nextIndex, reason: "later-segments-observed" },
            diagnosticsToken,
          );
          diagnostics.record(
            "media-drop",
            { segmentIndex: nextIndex, reason: "incomplete-video-segment" },
            diagnosticsToken,
          );
          continue;
        }
        break;
      }
      flushMediaQueue();
    },
    [diagnostics, flushMediaQueue],
  );

  const resetPlayback = useCallback(() => {
    audioPlayRef.current.reset();
    audioStartupExpiredRef.current = false;
    setAudioIntent("idle");
    setAudioBlocked(false);
    setAudioBlockReason(null);
    setContextSuspended(false);
    setPlaybackEnded(false);
    setAudioHasProgress(false);
    setObserverReady(false);
    lastPlaybackSampleRef.current = { atMs: performance.now(), currentTime: 0 };
    sourceBufferRef.current?.removeEventListener(
      "updateend",
      handleSourceBufferUpdateEnd,
    );
    sourceBufferRef.current?.removeEventListener(
      "error",
      handleSourceBufferError,
    );
    sourceBufferRef.current?.removeEventListener(
      "abort",
      handleSourceBufferAbort,
    );
    sourceBufferRef.current = null;
    mediaSourceRef.current = null;
    mediaQueueRef.current = [];
    parserResetChunksRef.current = new WeakSet();
    audioNeedsSyncRef.current = false;
    videoNeedsSyncRef.current = false;
    lastPacketAtRef.current = null;
    setReceptionStalled(false);
    audioPacketsRef.current.clear();
    audioStartSequenceRef.current = null;
    lastQueuedAudioSequenceRef.current = -1;
    audioInitializationLengthRef.current = null;
    videoAssemblerRef.current.reset();
    completedVideoSegmentsRef.current.clear();
    nextVideoSegmentRef.current = 0;
    highestVideoSegmentRef.current = -1;
    videoInitializationLengthRef.current = null;
    seenSequencesRef.current.clear();
    setPacketCount(0);
    setPacketGaps(0);
    setSegmentCount(0);
    setLostSegments(0);
    setReceivedBytes(0);
    setLatestProof(null);
    setMediaReady(false);
    setListening(false);
    setPlaying(false);
    setPlaybackMode("audio");
    setMediaMimeType(PATIO_MEDIA_TYPE);
    setPlaybackError(null);
    playbackRequestedRef.current = false;
    audioStartupPositionedRef.current = false;
    if (audioStartupTimerRef.current) {
      clearTimeout(audioStartupTimerRef.current);
      audioStartupTimerRef.current = null;
    }
    transportEndedRef.current = false;
    mediaSourceEndedRef.current = false;
    appendInFlightRef.current = null;
    appendSequenceRef.current = 0;
    userPauseRequestedRef.current = false;
    mediaWaitingRef.current = false;
    lastNaturalProgressAtRef.current = 0;
    lastVideoRecoveryAtRef.current = 0;
    if (gapRecoveryTimerRef.current !== null)
      clearTimeout(gapRecoveryTimerRef.current);
    gapRecoveryTimerRef.current = null;
    gapRecoveryExpiredRef.current = false;
    if (videoFrameCallbackRef.current !== null && videoRef.current) {
      videoRef.current.cancelVideoFrameCallback?.(
        videoFrameCallbackRef.current,
      );
    }
    videoFrameCallbackRef.current = null;
    stopVisualizer();
    for (const element of [audioRef.current, videoRef.current]) {
      element?.pause();
      if (element) {
        element.removeAttribute("src");
        element.load();
      }
    }
    if (mediaUrlRef.current) URL.revokeObjectURL(mediaUrlRef.current);
    mediaUrlRef.current = null;
  }, [
    handleSourceBufferAbort,
    handleSourceBufferError,
    handleSourceBufferUpdateEnd,
    stopVisualizer,
  ]);

  const receivePacket = useCallback(
    (
      packet: DecodedPatioPacketV1,
      transaction: TxpoolTransaction,
      diagnosticsToken: number,
    ) => {
      if (seenSequencesRef.current.has(packet.sequence)) {
        diagnostics.record(
          "packet-duplicate",
          { sequence: packet.sequence, hash: transaction.hash },
          diagnosticsToken,
        );
        return;
      }
      diagnostics.record(
        "packet-received",
        {
          sequence: packet.sequence,
          windowIndex: packet.windowIndex,
          bytes: packet.payload.length,
          hash: transaction.hash,
        },
        diagnosticsToken,
      );
      seenSequencesRef.current.add(packet.sequence);
      lastPacketAtRef.current = performance.now();
      setReceptionStalled(false);
      setPacketCount(seenSequencesRef.current.size);
      setPacketGaps(packetGapCount(seenSequencesRef.current));
      setReceivedBytes((current) => current + packet.payload.length);

      if (
        packet.codec === PatioCodec.WEBM_VP8_OPUS ||
        packet.codec === PatioCodec.WEBM_VP9_OPUS
      ) {
        try {
          const fragment = decodeVideoFragment(packet.payload);
          if (
            (fragment.initialization &&
              packet.type !== PatioPacketType.START) ||
            (!fragment.initialization && packet.type !== PatioPacketType.VIDEO)
          ) {
            throw new Error(
              "Video initialization flags do not match the packet type.",
            );
          }
          setPlaybackMode("video");
          setMediaMimeType(videoMimeType(packet.codec));
          highestVideoSegmentRef.current = Math.max(
            highestVideoSegmentRef.current,
            fragment.segmentIndex,
          );
          setLatestProof({
            sequence: packet.sequence,
            segmentIndex: fragment.segmentIndex,
            fragmentIndex: fragment.fragmentIndex,
            fragmentCount: fragment.fragmentCount,
            bytes: fragment.data.length,
            txHash: transaction.hash,
            nonce: BigInt(transaction.nonce).toString(),
            windowIndex: packet.windowIndex,
          });
          const result = videoAssemblerRef.current.add(fragment);
          if (result.status === "complete") {
            completedVideoSegmentsRef.current.set(
              result.segment.segmentIndex,
              result.segment,
            );
            setSegmentCount((current) => current + 1);
            diagnostics.record(
              "segment-complete",
              {
                segmentIndex: result.segment.segmentIndex,
                bytes: result.segment.bytes.length,
                fragmentCount: fragment.fragmentCount,
              },
              diagnosticsToken,
            );
            queueOrderedVideo(diagnosticsToken);
          } else if (
            result.status === "pending" &&
            result.receivedFragments === 1
          ) {
            diagnostics.record(
              "segment-incomplete",
              {
                segmentIndex: fragment.segmentIndex,
                fragmentCount: fragment.fragmentCount,
              },
              diagnosticsToken,
            );
          } else if (result.status === "duplicate") {
            diagnostics.record(
              "packet-duplicate",
              {
                sequence: packet.sequence,
                segmentIndex: fragment.segmentIndex,
                fragmentIndex: fragment.fragmentIndex,
              },
              diagnosticsToken,
            );
          }
        } catch (cause) {
          diagnostics.record(
            "packet-invalid",
            {
              sequence: packet.sequence,
              hash: transaction.hash,
              reason: "invalid-video-fragment",
            },
            diagnosticsToken,
          );
          setPlaybackError(
            cause instanceof Error
              ? cause.message
              : "Invalid Patio video fragment.",
          );
        }
        return;
      }

      if (
        packet.type !== PatioPacketType.START &&
        packet.type !== PatioPacketType.AUDIO &&
        packet.type !== PatioPacketType.VIDEO
      ) {
        return;
      }
      let audioPayload = packet.payload;
      if (packet.codec === PatioCodec.OPUS_WEBM_WEBP) {
        try {
          const videoPayload = decodeVideoBetaPayload(packet.payload);
          audioPayload = videoPayload.audio;
          setPlaybackMode("video-beta");
          const canvas = videoCanvasRef.current;
          if (canvas) {
            void drawVideoBetaFrame(
              canvas,
              videoPayload.image,
              videoPayload.width,
              videoPayload.height,
            ).catch(() =>
              setPlaybackError("Chrome could not decode a legacy video frame."),
            );
          }
        } catch {
          diagnostics.record(
            "packet-invalid",
            {
              sequence: packet.sequence,
              hash: transaction.hash,
              reason: "invalid-legacy-video-payload",
            },
            diagnosticsToken,
          );
          setPlaybackError("Invalid legacy Video beta payload.");
          return;
        }
      }
      setLatestProof({
        sequence: packet.sequence,
        segmentIndex: null,
        fragmentIndex: null,
        fragmentCount: null,
        bytes: audioPayload.length,
        txHash: transaction.hash,
        nonce: BigInt(transaction.nonce).toString(),
        windowIndex: packet.windowIndex,
      });
      audioPacketsRef.current.set(packet.sequence, audioPayload);
      if (
        packet.type === PatioPacketType.START &&
        (audioStartSequenceRef.current === null ||
          packet.sequence < audioStartSequenceRef.current)
      ) {
        audioStartSequenceRef.current = packet.sequence;
        setMediaReady(true);
      }
      queueOrderedAudio(diagnosticsToken);
    },
    [diagnostics, queueOrderedAudio, queueOrderedVideo],
  );

  useEffect(() => {
    setAudioCompatible(
      typeof MediaSource !== "undefined" &&
        MediaSource.isTypeSupported(PATIO_MEDIA_TYPE),
    );
    setSession(privateFixture?.descriptor ?? storedSession());
  }, [privateFixture]);

  useEffect(() => {
    resetPlayback();
    if (!session) {
      setStatus("off-air");
      return;
    }
    const retirement =
      session.transportMode === "single-nonce-retirement-v1"
        ? privateFixture
        : undefined;
    if (!retirement && (!sessionProfile || !sessionProfile.safety.enabled)) {
      setObserverError(`Unsupported Patio chain ID: ${session.chainId}.`);
      return;
    }
    if (!retirement && !observerRpc.url) {
      setObserverError(
        `Direct ${sessionProfile?.name ?? "private"} observer RPC is not configured.`,
      );
      return;
    }
    const requestedMode = new URLSearchParams(window.location.search).get(
      "mode",
    );
    const diagnosticsToken = diagnostics.begin(
      {
        chainId: session.chainId,
        sessionAddress: session.sessionAddress,
        streamId: session.streamId,
      },
      {
        mediaMode: requestedMode === "video" ? "video" : "audio",
        listenerPollIntervalMs:
          observerRpc.url === "/api/hoodi-beta"
            ? 500
            : DIRECT_OBSERVER_POLL_INTERVAL_MS,
      },
    );
    diagnosticsTokenRef.current = diagnosticsToken;
    const rpc = createLegacyObserverRpc(
      observerRpc.url === "/api/hoodi-beta"
        ? { ...observerRpc, betaContext: { descriptor: session } }
        : observerRpc,
      Boolean(retirement),
    );
    const seenHashes = new Set<string>();
    let cancelled = false;
    let polling = false;
    let observerVerified = false;
    const classicEndProbe = !retirement
      ? createClassicEndProbe(rpc!, session)
      : null;
    setStatus("waiting");
    setObserverError(null);

    const poll = async () => {
      if (cancelled || polling || transportEndedRef.current) return;
      // Presentation only; absence is not canonical closure. Keep bounded
      // polling so later packets can resume without a new player/session.
      setReceptionStalled(
        lastPacketAtRef.current !== null &&
          performance.now() - lastPacketAtRef.current > 12_000,
      );
      polling = true;
      const pollStartedAt = performance.now();
      diagnostics.record("poll-start", {}, diagnosticsToken);
      try {
        if (!observerVerified) {
          if (retirement) await retirement.environment.revalidate();
          else await assertRpcChain(rpc!, session.chainId, "Observer");
          observerVerified = true;
          if (!cancelled && diagnostics.token() === diagnosticsToken)
            setObserverReady(true);
        }
        const content = retirement
          ? await retirement.environment.observer.request<unknown>(
              "txpool_content",
            )
          : await rpc!.txpoolContentFrom(session.sessionAddress);
        if (cancelled || diagnostics.token() !== diagnosticsToken) return;
        const packets: Array<{
          packet: DecodedPatioPacketV1;
          transaction: TxpoolTransaction;
        }> = [];
        let releaseSeen = false;
        for (const transaction of flattenTxpoolTransactions(content)) {
          if (
            transaction.from.toLowerCase() !==
            session.sessionAddress.toLowerCase()
          ) {
            continue;
          }
          if (seenHashes.has(transaction.hash.toLowerCase())) {
            continue;
          }
          seenHashes.add(transaction.hash.toLowerCase());
          const nonce = BigInt(transaction.nonce);
          if (
            transaction.input === "0x" &&
            nonce === BigInt(session.nonceStart)
          ) {
            diagnostics.record(
              "cleanup-stage",
              {
                stage: retirement
                  ? "retirement-candidate-observed"
                  : "classic-release-pending-not-terminal",
                hash: transaction.hash,
                nonce: nonce.toString(),
                status: "pending-not-terminal",
              },
              diagnosticsToken,
            );
            continue;
          }
          if (transaction.input === "0x") continue;
          try {
            const packet = packetFromHex(transaction.input);
            if (packet.streamId === session.streamId) {
              packets.push({ packet, transaction });
            }
          } catch {
            diagnostics.record(
              "packet-invalid",
              {
                hash: transaction.hash,
                reason: "invalid-patio-envelope",
              },
              diagnosticsToken,
            );
            // Ignore unrelated pending calldata from the watched wallet.
          }
        }
        packets
          .toSorted(
            (left, right) => left.packet.sequence - right.packet.sequence,
          )
          .forEach(({ packet, transaction }) =>
            receivePacket(packet, transaction, diagnosticsToken),
          );
        // Reception is already established. A later close-status read failure
        // must not disable Play or reactions for usable buffered media.
        if (packets.length > 0) setStatus("live");
        if (retirement) {
          const evidence = await readCanonicalRetirement(
            retirement.environment,
            session.sessionAddress,
            Number(BigInt(session.nonceStart) + 2n),
          );
          if (cancelled || diagnostics.token() !== diagnosticsToken) return;
          releaseSeen = evidence.retired;
          if (releaseSeen)
            diagnostics.record(
              "cleanup-stage",
              {
                stage: "canonical-retirement-observed",
                nonce: evidence.nonce.toString(),
                hash: evidence.blockHash,
              },
              diagnosticsToken,
            );
        } else {
          const evidence = classicEndProbe!.poll();
          if (cancelled || diagnostics.token() !== diagnosticsToken) return;
          releaseSeen = evidence?.ended ?? false;
          if (releaseSeen)
            diagnostics.record(
              "cleanup-stage",
              {
                stage: evidence!.reason,
                ...(evidence!.nonce ? { nonce: evidence!.nonce } : {}),
                ...(evidence!.blockHash ? { hash: evidence!.blockHash } : {}),
              },
              diagnosticsToken,
            );
        }
        if (releaseSeen && !transportEndedRef.current) {
          transportEndedRef.current = true;
          diagnostics.record(
            "transport-end",
            {
              status: retirement
                ? "canonical-retirement-draining"
                : session.classicEnd
                  ? "classic-nonces-consumed-draining-not-finalized"
                  : "legacy-gap-consumed-draining-not-finalized",
            },
            diagnosticsToken,
          );
          setStatus("ended");
          stopPolling();
          flushMediaQueue();
        }
        setObserverError(null);
        diagnostics.record(
          "poll-complete",
          {
            durationMs: performance.now() - pollStartedAt,
            status: "observer-response",
          },
          diagnosticsToken,
        );
        return true;
      } catch (cause) {
        if (cancelled || diagnostics.token() !== diagnosticsToken) return;
        const message =
          cause instanceof Error ? cause.message.toLowerCase() : "unknown";
        diagnostics.record(
          "poll-error",
          {
            durationMs: performance.now() - pollStartedAt,
            errorClass:
              message.includes("quota") || message.includes("rate")
                ? "rate-limit"
                : "observer-rpc",
          },
          diagnosticsToken,
        );
        setObserverError(
          cause instanceof Error
            ? cause.message
            : "Observer RPC is unavailable.",
        );
        return false;
      } finally {
        polling = false;
      }
    };

    const stopPolling = startObserverPolling(
      poll,
      observerRpc.url === "/api/hoodi-beta"
        ? 500
        : DIRECT_OBSERVER_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      classicEndProbe?.dispose();
      stopPolling();
      diagnostics.close(diagnosticsToken);
    };
  }, [
    diagnostics,
    flushMediaQueue,
    observerRpc,
    receivePacket,
    resetPlayback,
    session,
    sessionProfile,
    privateFixture,
  ]);

  useEffect(
    () => () => {
      resetPlayback();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    },
    [resetPlayback],
  );

  const beginListening = useCallback(
    async (startMuted = muted): Promise<void> => {
      if (mediaSourceRef.current) return; // synchronous resource guard, not just React button state
      setPlaybackError(null);
      const diagnosticsToken = diagnosticsTokenRef.current;
      diagnostics.record(
        "play-request",
        { muted: startMuted, volume },
        diagnosticsToken,
      );
      if (
        typeof MediaSource === "undefined" ||
        !MediaSource.isTypeSupported(mediaMimeType)
      ) {
        setPlaybackError("Use desktop Chrome to listen to this Patio codec.");
        return;
      }
      const mediaElement =
        playbackMode === "video" ? videoRef.current : audioRef.current;
      if (!mediaElement) return;
      if (playbackMode !== "video") {
        audioStartupPositionedRef.current = false;
        if (audioStartupTimerRef.current) {
          clearTimeout(audioStartupTimerRef.current);
        }
      }
      const mediaSource = new MediaSource();
      mediaSourceRef.current = mediaSource;
      const mediaUrl = URL.createObjectURL(mediaSource);
      mediaUrlRef.current = mediaUrl;
      mediaElement.src = mediaUrl;
      mediaSource.addEventListener(
        "sourceopen",
        () => {
          if (
            mediaSourceRef.current !== mediaSource ||
            diagnostics.token() !== diagnosticsToken
          )
            return;
          try {
            const sourceBuffer = mediaSource.addSourceBuffer(mediaMimeType);
            // MediaRecorder emits one continuous WebM timeline. Keeping the
            // encoded timestamps lets later clusters extend the live buffer;
            // `sequence` mode can collapse Chrome's timesliced clusters onto
            // the first short range.
            sourceBuffer.mode = "segments";
            sourceBufferRef.current = sourceBuffer;
            sourceBuffer.addEventListener(
              "updateend",
              handleSourceBufferUpdateEnd,
            );
            sourceBuffer.addEventListener("error", handleSourceBufferError);
            sourceBuffer.addEventListener("abort", handleSourceBufferAbort);
            if (playbackMode === "video") {
              queueOrderedVideo(diagnosticsToken);
            } else {
              queueOrderedAudio(diagnosticsToken);
            }
            maybeFinalizeMediaSource();
          } catch {
            diagnostics.record(
              "error",
              {
                errorClass: "media-source",
                reason: "source-buffer-open-failed",
              },
              diagnosticsToken,
            );
            setPlaybackError("Chrome could not open the Patio media buffer.");
          }
        },
        { once: true },
      );
      setListening(true);
      lastNaturalProgressAtRef.current = performance.now();
      playbackRequestedRef.current = true;
      userPauseRequestedRef.current = false;
      const playGeneration = audioPlayRef.current.allow();
      setAudioIntent("listen");
      setAudioBlocked(false);
      setAudioBlockReason(null);
      mediaElement.muted = startMuted;
      mediaElement.volume = volume;
      if (playbackMode !== "video") {
        // The startup deadline also survives a pause while resume() is pending.
        // It never forces play: maybeStartAudioPlayback checks user intent.
        audioStartupTimerRef.current = setTimeout(() => {
          audioStartupTimerRef.current = null;
          audioStartupExpiredRef.current = true;
          maybeStartAudioPlayback(true);
        }, AUDIO_STARTUP_MAX_WAIT_MS);
      }
      // Muted video can play natively before a gesture. Do not put its play()
      // behind AudioContext.resume(), which may remain pending indefinitely.
      if (playbackMode !== "video")
        await startVisualizer(mediaElement, playbackMode).catch(() => {
          if (
            playbackMode === "audio" &&
            diagnostics.token() === diagnosticsToken
          )
            setContextSuspended(audioContextRef.current?.state === "suspended");
        });
      if (
        mediaSourceRef.current !== mediaSource ||
        diagnostics.token() !== diagnosticsToken ||
        audioPlayRef.current.generation !== playGeneration
      )
        return;
      diagnostics.record(
        "audio-state",
        {
          muted: mediaElement.muted,
          volume: mediaElement.volume,
          audioContextState: audioContextRef.current?.state ?? "unavailable",
        },
        diagnosticsToken,
      );
      if (playbackMode !== "video") {
        maybeStartAudioPlayback(false);
        return;
      }
      audioPlayRef.current.attempt(mediaElement, (reason) => {
        setAudioBlocked(true);
        setAudioBlockReason(reason);
        diagnostics.record(
          reason === "permission" ? "autoplay-blocked" : "error",
          { reason: `video-play-${reason}` },
          diagnosticsToken,
        );
      });
    },
    [
      diagnostics,
      handleSourceBufferAbort,
      handleSourceBufferError,
      handleSourceBufferUpdateEnd,
      mediaMimeType,
      maybeFinalizeMediaSource,
      maybeStartAudioPlayback,
      muted,
      playbackMode,
      queueOrderedAudio,
      queueOrderedVideo,
      startVisualizer,
      volume,
    ],
  );

  useEffect(() => {
    if (
      playbackMode !== "video" ||
      listening ||
      !session ||
      status !== "live"
    ) {
      return;
    }
    setMuted(true);
    void beginListening(true);
  }, [beginListening, listening, playbackMode, session, status]);

  const recordPlaybackProgress = useCallback(
    (element: HTMLMediaElement): void => {
      const now = performance.now();
      const previous = lastPlaybackSampleRef.current;
      const audio = element === audioRef.current;
      if (
        element.seeking ||
        automaticSeekInProgressRef.current ||
        element.paused
      ) {
        lastPlaybackSampleRef.current = {
          atMs: now,
          currentTime: element.currentTime,
        };
        return;
      }
      if (
        now - previous.atMs < 200 ||
        element.currentTime <= previous.currentTime
      ) {
        return;
      }
      lastPlaybackSampleRef.current = {
        atMs: now,
        currentTime: element.currentTime,
      };
      if (
        !naturalAudioProgress(previous, {
          atMs: now,
          currentTime: element.currentTime,
          paused: element.paused,
          seeking: element.seeking,
        })
      )
        return;
      lastNaturalProgressAtRef.current = now;
      if (audio) {
        setPlaying(true);
        setAudioHasProgress(true);
      }
      const lastEnd =
        element.buffered.length > 0
          ? element.buffered.end(element.buffered.length - 1)
          : null;
      diagnostics.record(
        "playback-progress",
        { currentTimeSeconds: element.currentTime },
        diagnosticsTokenRef.current,
      );
      diagnostics.record(
        "buffer-sample",
        {
          currentTimeSeconds: element.currentTime,
          bufferAheadSeconds: continuousBufferAhead(
            element.buffered,
            element.currentTime,
          ),
          ...(lastEnd === null
            ? {}
            : { distanceSeconds: Math.max(0, lastEnd - element.currentTime) }),
        },
        diagnosticsTokenRef.current,
      );
    },
    [diagnostics],
  );

  const handleMediaPlaying = useCallback(
    (event: React.SyntheticEvent<HTMLMediaElement>) => {
      mediaWaitingRef.current = false;
      if (event.currentTarget !== audioRef.current) setPlaying(true);
      diagnostics.record(
        "playback-start",
        { status: "media-element-playing" },
        diagnosticsTokenRef.current,
      );
    },
    [diagnostics],
  );

  const handleMediaPause = useCallback(() => {
    setPlaying(false);
    diagnostics.record(
      userPauseRequestedRef.current
        ? "playback-pause-user"
        : "playback-pause-other",
      {
        reason: userPauseRequestedRef.current
          ? "user-control"
          : "media-element-pause",
      },
      diagnosticsTokenRef.current,
    );
  }, [diagnostics]);

  const handleMediaWaiting = useCallback(() => {
    mediaWaitingRef.current = true;
    setPlaying(false);
    diagnostics.record(
      "playback-waiting",
      { reason: "media-element-waiting" },
      diagnosticsTokenRef.current,
    );
    flushMediaQueue();
  }, [diagnostics, flushMediaQueue]);

  const handleMediaSeeking = useCallback(() => {
    if (!videoRef.current?.src) setPlaying(false);
    if (automaticSeekInProgressRef.current) return;
    diagnostics.record(
      "playback-seek",
      {
        skippedSeconds: 0,
        reason: "user-or-browser-seek",
        phase: "user",
      },
      diagnosticsTokenRef.current,
    );
  }, [diagnostics]);

  const handleMediaSeeked = useCallback(() => {
    automaticSeekInProgressRef.current = false;
    const element = videoRef.current?.src ? videoRef.current : audioRef.current;
    if (element)
      lastPlaybackSampleRef.current = {
        atMs: performance.now(),
        currentTime: element.currentTime,
      };
  }, []);

  const handleMediaEnded = useCallback(() => {
    setPlaying(false);
    setPlaybackEnded(true);
    if (!videoRef.current?.src) {
      playbackRequestedRef.current = false;
      audioPlayRef.current.cancel(null);
    }
    diagnostics.record(
      "playback-end",
      { status: "remaining-content-played" },
      diagnosticsTokenRef.current,
    );
  }, [diagnostics]);

  const handleMediaError = useCallback(() => {
    if (videoRef.current?.src && videoRef.current.error) {
      setPlaying(false);
      setPlaybackError("Video playback interrupted.");
    } else if (audioRef.current?.error) {
      setPlaying(false);
      setPlaybackError(
        "The browser reported an audio decoding/playback error. No automatic replay is available; the session has not been reset.",
      );
    }
    diagnostics.record(
      "error",
      { errorClass: "media-element", reason: "playback-error" },
      diagnosticsTokenRef.current,
    );
  }, [diagnostics]);

  useEffect(() => {
    const video = videoRef.current;
    if (
      !listening ||
      playbackMode !== "video" ||
      !video ||
      typeof video.requestVideoFrameCallback !== "function"
    ) {
      return;
    }
    const diagnosticsToken = diagnosticsTokenRef.current;
    let cancelled = false;
    const observeFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (cancelled) return;
      const quality = video.getVideoPlaybackQuality?.();
      diagnostics.record(
        "video-frame",
        {
          mediaTimeSeconds: metadata.mediaTime,
          presentedFrames: metadata.presentedFrames,
          droppedVideoFrames: quality?.droppedVideoFrames ?? 0,
          hidden: document.hidden,
        },
        diagnosticsToken,
      );
      videoFrameCallbackRef.current =
        video.requestVideoFrameCallback(observeFrame);
    };
    videoFrameCallbackRef.current =
      video.requestVideoFrameCallback(observeFrame);
    return () => {
      cancelled = true;
      if (videoFrameCallbackRef.current !== null) {
        video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      }
      videoFrameCallbackRef.current = null;
    };
  }, [diagnostics, listening, playbackMode]);

  const togglePlayback = async (): Promise<void> => {
    if (playbackMode === "audio") {
      if (
        !session ||
        (!privateFixture && !classicEarlyAudio && !mediaReady) ||
        !audioCompatible ||
        playbackError ||
        playbackEnded ||
        (transportEndedRef.current && !mediaReady)
      )
        return;
      const audio = audioRef.current;
      if (!audio) return;
      if (playbackRequestedRef.current && !audioBlocked && !contextSuspended) {
        playbackRequestedRef.current = false;
        userPauseRequestedRef.current = true;
        setAudioIntent("pause");
        setPlaying(false);
        audioPlayRef.current.cancel(audio);
        diagnostics.record(
          "playback-pause-user",
          { reason: "user-control" },
          diagnosticsTokenRef.current,
        );
        return;
      }
      if (!mediaSourceRef.current) {
        await beginListening();
        return;
      }
      playbackRequestedRef.current = true;
      userPauseRequestedRef.current = false;
      setAudioIntent("listen");
      setAudioBlocked(false);
      setAudioBlockReason(null);
      const token = diagnosticsTokenRef.current;
      const generation = audioPlayRef.current.allow();
      diagnostics.record(
        "play-request",
        { muted: audio.muted, volume: audio.volume },
        token,
      );
      // Activation happens directly in this click, never behind an RPC read.
      await startVisualizer(audio, "audio").catch(() => {
        if (token === diagnostics.token())
          setContextSuspended(audioContextRef.current?.state === "suspended");
      });
      await audioPlayRef.current.pending;
      if (
        token !== diagnostics.token() ||
        generation !== audioPlayRef.current.generation ||
        !playbackRequestedRef.current
      )
        return;
      maybeStartAudioPlayback(false);
      return;
    }
    if (!listening) {
      await beginListening();
      return;
    }
    const mediaElement = realVideo ? videoRef.current : audioRef.current;
    if (!mediaElement) return;
    if (!playbackRequestedRef.current || audioBlocked) {
      playbackRequestedRef.current = true;
      userPauseRequestedRef.current = false;
      setAudioIntent("listen");
      setAudioBlocked(false);
      const generation = audioPlayRef.current.allow();
      const token = diagnosticsTokenRef.current;
      diagnostics.record(
        "play-request",
        { muted: mediaElement.muted, volume: mediaElement.volume },
        diagnosticsTokenRef.current,
      );
      if (!realVideo) {
        maybeStartAudioPlayback(false);
        return;
      }
      await audioPlayRef.current.pending;
      if (
        !playbackRequestedRef.current ||
        generation !== audioPlayRef.current.generation ||
        token !== diagnosticsTokenRef.current
      )
        return;
      flushMediaQueue();
      audioPlayRef.current.attempt(mediaElement, (reason) => {
        setAudioBlocked(true);
        setAudioBlockReason(reason);
        diagnostics.record(
          reason === "permission" ? "autoplay-blocked" : "error",
          { reason: `video-user-play-${reason}` },
          diagnosticsTokenRef.current,
        );
      });
    } else {
      playbackRequestedRef.current = false;
      userPauseRequestedRef.current = true;
      setAudioIntent("pause");
      audioPlayRef.current.cancel(mediaElement);
    }
  };

  const toggleMute = (): void => {
    const next = !muted;
    setMuted(next);
    for (const element of [audioRef.current, videoRef.current]) {
      if (element) element.muted = next;
    }
    diagnostics.record(
      "audio-state",
      {
        muted: next,
        volume,
        audioContextState: audioContextRef.current?.state ?? "unavailable",
      },
      diagnosticsTokenRef.current,
    );
  };

  const changeVolume = (next: number): void => {
    setVolume(next);
    setMuted(false);
    for (const element of [audioRef.current, videoRef.current]) {
      if (element) {
        element.volume = next;
        element.muted = false;
      }
    }
    diagnostics.record(
      "audio-state",
      {
        muted: false,
        volume: next,
        audioContextState: audioContextRef.current?.state ?? "unavailable",
      },
      diagnosticsTokenRef.current,
    );
  };

  const ready = (status === "live" || status === "ended") && mediaReady;
  const classicEarlyAudio =
    Boolean(
      session && session.transportMode !== "single-nonce-retirement-v1",
    ) &&
    new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search,
    ).get("mode") === "audio";
  const realVideo = playbackMode === "video";
  const legacyVideo = playbackMode === "video-beta";
  const audioView = audioListenerPresentation({
    session: Boolean(session),
    compatible: audioCompatible,
    observerReady,
    // Explicit audio links (including registry v1) reuse D3 early intent.
    // Unlabelled/video links identify their codec from the received packets.
    waitingForPacket: !privateFixture && !classicEarlyAudio && !mediaReady,
    received: packetCount > 0,
    playable: mediaReady,
    requested: audioIntent === "listen",
    userPaused: audioIntent === "pause",
    progressing: playing,
    started: audioHasProgress,
    ended: playbackEnded,
    transportEnded: status === "ended",
    blocked: audioBlocked,
    blockReason: audioBlockReason,
    contextSuspended,
    error: playbackError,
    connectionError: Boolean(observerError),
    receptionStalled,
  });

  return (
    <section
      className="simple-card station-player"
      aria-labelledby="station-title"
      aria-label={`Patio ${stationFrequency}`}
    >
      <div className="station-player__topline">
        <span className="selected-operator">
          {session
            ? `${session.operator.slice(0, 6)}…${session.operator.slice(-4)}`
            : "No wallet"}
        </span>
        <span
          className={`simple-status${status === "live" && !receptionStalled && !playbackError ? " is-live" : ""}`}
        >
          {playbackError
            ? "Playback interrupted"
            : receptionStalled && status !== "ended"
              ? "Broadcast interrupted"
              : playbackMode === "audio"
                ? status === "ended"
                  ? "Reception ended"
                  : packetCount > 0
                    ? "Packets received"
                    : "Waiting for packets"
                : statusLabel(status)}
        </span>
      </div>
      <h1 id="station-title">Patio</h1>

      <video
        ref={videoRef}
        className={`patio-video-player${realVideo ? " is-visible" : ""}`}
        playsInline
        muted={muted}
        aria-label="Patio live encoded video"
        onPlaying={handleMediaPlaying}
        onPause={handleMediaPause}
        onWaiting={handleMediaWaiting}
        onStalled={handleMediaWaiting}
        onSeeking={handleMediaSeeking}
        onSeeked={handleMediaSeeked}
        onTimeUpdate={(event) => recordPlaybackProgress(event.currentTarget)}
        onEnded={handleMediaEnded}
        onError={handleMediaError}
      />
      <canvas
        ref={videoCanvasRef}
        className={`video-beta-canvas${legacyVideo ? " is-visible" : ""}`}
        width={160}
        height={90}
        aria-label="Legacy Patio Video beta stream"
      />

      <div
        ref={waveformRef}
        className={`simple-signal${playing && !playbackError ? " is-live" : ""}`}
        aria-label="Live audio level"
      >
        {Array.from({ length: 16 }, (_, index) => (
          <span key={index} />
        ))}
      </div>

      <div className="patio-player-controls">
        <button
          className="patio-player-controls__play"
          type="button"
          onClick={togglePlayback}
          disabled={
            playbackMode === "audio" ? audioView.action === "none" : !ready
          }
          aria-label={
            playbackMode === "audio"
              ? audioView.action === "pause"
                ? "Pause Patio live media"
                : audioView.action === "enable"
                  ? "Enable audio"
                  : "Play Patio live media"
              : audioIntent === "listen" && !audioBlocked && !playbackEnded
                ? "Pause Patio live media"
                : "Play Patio live media"
          }
        >
          {(
            playbackMode === "audio"
              ? audioView.action === "pause"
              : audioIntent === "listen" && !audioBlocked && !playbackEnded
          )
            ? "Ⅱ"
            : "▶"}
        </button>
        <span className="patio-player-controls__state">
          {playbackMode === "audio"
            ? audioView.message
            : playbackError
              ? playbackError
              : playbackEnded
                ? "Playback finished"
                : status === "ended"
                  ? playing
                    ? "Broadcast ended — playing remaining video"
                    : "Broadcast ended"
                  : receptionStalled
                    ? "Waiting for broadcast"
                    : ready
                      ? realVideo
                        ? audioBlocked
                          ? "Press Play to enable video"
                          : audioIntent === "pause"
                            ? "Paused by you"
                            : playing
                              ? "Live video"
                              : "Waiting for video"
                        : "Live audio"
                      : session
                        ? "Buffering Ethereum media"
                        : "Waiting for a broadcast link"}
        </span>
        <button
          className="patio-player-controls__mute"
          type="button"
          onClick={toggleMute}
          disabled={!listening}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? "Muted" : "Sound"}
        </button>
        <input
          aria-label="Playback volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          disabled={!listening}
          onChange={(event) => changeVolume(Number(event.target.value))}
        />
        <LiveReactions
          streamId={session?.streamId ?? null}
          active={ready}
          canReact
        />
      </div>
      {playbackMode === "audio" && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={
            audioView.tone === "error" ? "simple-error" : "simple-meta"
          }
          style={
            audioView.tone === "warning" ? { color: "#e7b8b4" } : undefined
          }
        >
          <strong>{audioView.message}</strong>
          <p>{audioView.detail}</p>
        </div>
      )}
      <audio
        ref={audioRef}
        className="simple-audio"
        aria-label="Patio live audio"
        onPlay={playbackMode === "audio" ? undefined : () => setPlaying(true)}
        onPlaying={handleMediaPlaying}
        onPause={handleMediaPause}
        onWaiting={handleMediaWaiting}
        onStalled={handleMediaWaiting}
        onSeeking={handleMediaSeeking}
        onSeeked={handleMediaSeeked}
        onTimeUpdate={(event) => recordPlaybackProgress(event.currentTarget)}
        onEnded={handleMediaEnded}
        onError={handleMediaError}
      />
      <p className="simple-meta">
        {packetCount} packets · {packetGaps} gaps · {segmentCount} video
        segments
      </p>
      {latestProof ? (
        <details className="stream-transport-proof">
          <summary>
            <span>Ethereum media data</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <dl aria-label="Ethereum media proof">
            <div>
              <dt>packet</dt>
              <dd>#{latestProof.sequence}</dd>
            </div>
            {latestProof.segmentIndex !== null ? (
              <div>
                <dt>segment</dt>
                <dd>
                  {latestProof.segmentIndex} · fragment{" "}
                  {(latestProof.fragmentIndex ?? 0) + 1}/
                  {latestProof.fragmentCount}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>bytes</dt>
              <dd>{latestProof.bytes} from transaction.input</dd>
            </div>
            <div>
              <dt>tx</dt>
              <dd title={latestProof.txHash}>
                {shortHash(latestProof.txHash)}
              </dd>
            </div>
            <div>
              <dt>nonce / window</dt>
              <dd>
                {latestProof.nonce} / {latestProof.windowIndex}
              </dd>
            </div>
            <div>
              <dt>observer</dt>
              <dd>
                confirmed · {receivedBytes} bytes · {lostSegments} lost
              </dd>
            </div>
          </dl>
        </details>
      ) : null}
      {session ? <MediaDiagnosticsPanel session={diagnostics} /> : null}
      {observerError ? (
        playbackMode === "audio" ? (
          <p className="simple-meta">
            Connection unavailable. Received audio is retained; no provider
            switch.
          </p>
        ) : (
          <p className="simple-error">{observerError}</p>
        )
      ) : null}
      {playbackError && playbackMode !== "audio" ? (
        <p className="simple-error">{playbackError}</p>
      ) : null}
    </section>
  );
}
