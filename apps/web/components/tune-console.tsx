"use client";

import { PATIO_MEDIA_TYPE } from "@patio/config";
import {
  base64ToBytes,
  PatioPacketType,
  type SerializedPatioPacketV1,
} from "@patio/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  patioFetch,
  shortAddress,
  websocketUrl,
  type BroadcastStatus,
  type BroadcastSummary,
} from "../lib/patio-api";

interface ObserverMessage {
  type: "snapshot" | "packet" | "health" | "ended" | "error";
  packet?: SerializedPatioPacketV1;
  packets?: SerializedPatioPacketV1[];
  status?: BroadcastStatus | "off-air";
  error?: string;
}

function statusLabel(status: BroadcastStatus | "off-air"): string {
  if (status === "live") return "Live";
  if (status === "waiting") return "Starting";
  if (status === "ended") return "Ended";
  return "Off air";
}

export function TuneConsole({
  observerUrl,
  stationFrequency,
}: {
  observerUrl: string;
  stationFrequency: string;
}) {
  const [broadcasts, setBroadcasts] = useState<BroadcastSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<BroadcastStatus | "off-air">("off-air");
  const [listening, setListening] = useState(false);
  const [packetCount, setPacketCount] = useState(0);
  const [observerError, setObserverError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [levels, setLevels] = useState(() =>
    Array.from({ length: 16 }, () => 0.14),
  );
  const audioRef = useRef<HTMLAudioElement>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioQueueRef = useRef<Uint8Array[]>([]);
  const audioUrlRef = useRef<string | null>(null);
  const seenSequencesRef = useRef(new Set<number>());
  const streamIdRef = useRef<string | null>(null);

  const flushAudioQueue = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    const next = audioQueueRef.current[0];
    if (!sourceBuffer || sourceBuffer.updating || !next) return;
    audioQueueRef.current.shift();
    try {
      sourceBuffer.appendBuffer(next.slice().buffer);
    } catch {
      setPlaybackError("The audio stream could not be decoded.");
    }
  }, []);

  const resetPlayback = useCallback(() => {
    sourceBufferRef.current?.removeEventListener("updateend", flushAudioQueue);
    sourceBufferRef.current = null;
    seenSequencesRef.current.clear();
    streamIdRef.current = null;
    audioQueueRef.current = [];
    setPacketCount(0);
    setListening(false);
    setPlaybackError(null);
    const audio = audioRef.current;
    audio?.pause();
    if (audio) {
      audio.removeAttribute("src");
      audio.load();
    }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, [flushAudioQueue]);

  const receivePacket = useCallback(
    (packet: SerializedPatioPacketV1) => {
      if (streamIdRef.current !== packet.streamId) {
        streamIdRef.current = packet.streamId;
        seenSequencesRef.current.clear();
        audioQueueRef.current = [];
        setPacketCount(0);
      }
      if (seenSequencesRef.current.has(packet.sequence)) return;
      seenSequencesRef.current.add(packet.sequence);
      if (
        packet.type === PatioPacketType.START ||
        packet.type === PatioPacketType.AUDIO
      ) {
        const bytes = base64ToBytes(packet.payloadBase64);
        audioQueueRef.current.push(bytes);
        flushAudioQueue();
        const sample = [...bytes.slice(0, 16)].map(
          (value) => 0.14 + (value / 255) * 0.86,
        );
        if (sample.length === 16) setLevels(sample);
      }
      setPacketCount(seenSequencesRef.current.size);
    },
    [flushAudioQueue],
  );

  const loadBroadcasts = useCallback(async () => {
    if (!observerUrl) {
      setObserverError("Ethereum observer not configured.");
      return;
    }
    try {
      const response = await patioFetch<{ broadcasts: BroadcastSummary[] }>(
        new URL("/v1/broadcasts", observerUrl),
      );
      setBroadcasts(response.broadcasts);
      setObserverError(null);
      setSelectedId((current) => {
        if (
          current &&
          response.broadcasts.some((item) => item.id === current)
        ) {
          return current;
        }
        return (
          response.broadcasts.find((item) => item.status === "live")?.id ??
          response.broadcasts[0]?.id ??
          null
        );
      });
    } catch (cause) {
      setObserverError(
        cause instanceof Error ? cause.message : "Observer unavailable.",
      );
    }
  }, [observerUrl]);

  useEffect(() => {
    void loadBroadcasts();
    const timer = setInterval(() => void loadBroadcasts(), 2_000);
    return () => clearInterval(timer);
  }, [loadBroadcasts]);

  useEffect(() => {
    resetPlayback();
    if (!observerUrl || !selectedId) {
      setStatus("off-air");
      return;
    }
    setStatus("off-air");
    const socket = new WebSocket(
      websocketUrl(observerUrl, `/v1/broadcasts/${selectedId}/stream`),
    );
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ObserverMessage;
        if (message.type === "snapshot") {
          setStatus(message.status ?? "off-air");
          message.packets?.forEach(receivePacket);
        } else if (message.type === "packet" && message.packet) {
          setStatus("live");
          receivePacket(message.packet);
        } else if (message.type === "ended") {
          setStatus("ended");
        } else if (message.type === "error") {
          setObserverError(message.error ?? "Observer stream error.");
        }
      } catch {
        setObserverError("Observer returned an invalid stream message.");
      }
    });
    socket.addEventListener("close", () => {
      setStatus((current) => (current === "ended" ? current : "off-air"));
    });
    return () => socket.close();
  }, [observerUrl, receivePacket, resetPlayback, selectedId]);

  useEffect(() => () => resetPlayback(), [resetPlayback]);

  const beginListening = async (): Promise<void> => {
    setPlaybackError(null);
    if (
      typeof MediaSource === "undefined" ||
      !MediaSource.isTypeSupported(PATIO_MEDIA_TYPE)
    ) {
      setPlaybackError("Use desktop Chrome to listen.");
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const mediaSource = new MediaSource();
    const audioUrl = URL.createObjectURL(mediaSource);
    audioUrlRef.current = audioUrl;
    audio.src = audioUrl;
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        const sourceBuffer = mediaSource.addSourceBuffer(PATIO_MEDIA_TYPE);
        sourceBuffer.mode = "sequence";
        sourceBufferRef.current = sourceBuffer;
        sourceBuffer.addEventListener("updateend", flushAudioQueue);
        flushAudioQueue();
      },
      { once: true },
    );
    setListening(true);
    await audio.play().catch(() => undefined);
  };

  const selected = broadcasts.find((item) => item.id === selectedId);
  const ready = status === "live" && packetCount >= 2;

  return (
    <section className="listen-shell" aria-labelledby="station-title">
      <div className="simple-card station-player">
        <span className={`simple-status${status === "live" ? " is-live" : ""}`}>
          {statusLabel(status)}
        </span>
        <p className="frequency">{stationFrequency}</p>
        <h1 id="station-title">Patio</h1>
        <p className="selected-operator">
          {selected ? shortAddress(selected.operator) : "No broadcast selected"}
        </p>

        <div
          className={`simple-signal${status === "live" ? " is-live" : ""}`}
          aria-label="Audio signal"
        >
          {levels.map((level, index) => (
            <span key={index} style={{ transform: `scaleY(${level})` }} />
          ))}
        </div>

        <button
          className="primary-action"
          type="button"
          onClick={beginListening}
          disabled={!ready || listening}
        >
          {listening
            ? "Listening"
            : ready
              ? "Listen"
              : "Waiting for Ethereum audio"}
        </button>
        <audio
          ref={audioRef}
          controls={listening}
          className="simple-audio"
          aria-label="Patio live audio"
        />
        <p className="simple-meta">
          {packetCount} packets from observer node B
        </p>
        {playbackError ? <p className="simple-error">{playbackError}</p> : null}
      </div>

      <aside className="broadcast-browser" aria-label="Ethereum broadcasts">
        <div className="broadcast-browser__header">
          <h2>Broadcasts</h2>
          <span>{broadcasts.length}</span>
        </div>
        {broadcasts.length === 0 ? (
          <p className="empty-broadcasts">
            {observerError ?? "No Ethereum broadcasts yet."}
          </p>
        ) : (
          <div className="broadcast-list">
            {broadcasts.map((broadcast) => (
              <button
                key={broadcast.id}
                className={broadcast.id === selectedId ? "is-selected" : ""}
                type="button"
                onClick={() => setSelectedId(broadcast.id)}
              >
                <span className={`broadcast-dot is-${broadcast.status}`} />
                <span>
                  <strong>{shortAddress(broadcast.operator)}</strong>
                  <small>
                    {statusLabel(broadcast.status)} ·{" "}
                    {broadcast.recoveredPackets} packets
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </section>
  );
}
