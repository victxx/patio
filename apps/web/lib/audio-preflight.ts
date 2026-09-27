import { PATIO_DEFAULTS, PATIO_MEDIA_TYPE } from "@patio/config";

// Shared with the existing recorder. No device selection, codec or bitrate change.
export const PATIO_AUDIO_CONSTRAINTS = Object.freeze({
  channelCount: 1,
  echoCancellation: true,
});
export const patioAudioOptions = () => ({
  mimeType: PATIO_MEDIA_TYPE,
  audioBitsPerSecond: PATIO_DEFAULTS.audioBitsPerSecond,
});
export type MicrophoneState = {
  status:
    | "unchecked"
    | "waiting"
    | "ready"
    | "interrupted"
    | "unavailable"
    | "unsupported"
    | "cancelled"
    | "off"
    | "transferred";
  pending: boolean;
  muted: boolean;
  level: number;
  meter: "off" | "active" | "suspended" | "unavailable";
  message: string;
};
export const initialMicrophoneState: MicrophoneState = {
  status: "unchecked",
  pending: false,
  muted: false,
  level: 0,
  meter: "off",
  message: "Microphone not checked",
};

export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const explanations: Record<string, string> = {
    NotAllowedError:
      "Microphone permission denied. Check this site's microphone permission and try explicitly again.",
    NotFoundError:
      "No microphone is available. Connect a microphone and check again.",
    NotReadableError:
      "Microphone is inaccessible or busy in another application.",
    OverconstrainedError:
      "The microphone cannot satisfy Patio's existing audio settings.",
    AbortError: "Microphone access was interrupted.",
    SecurityError: "Microphone access is disabled in this browser context.",
    InvalidStateError: "The page or microphone is no longer active.",
    NotSupportedError:
      "This browser cannot record Patio's existing audio format.",
  };
  return `${name}: ${explanations[name] ?? "Audio capture failed. Keep any funded session open; this does not refund or replace it."}`;
}
export function hasLiveAudio(
  stream: MediaStream | null,
): stream is MediaStream {
  return Boolean(
    stream &&
    stream.getAudioTracks().some((t) => t.readyState === "live" && t.enabled),
  );
}
type Input = {
  compatible(): boolean;
  open(): Promise<MediaStream>;
  meter(
    stream: MediaStream,
    sample: (level: number, state: MicrophoneState["meter"]) => void,
  ): () => void;
};

/** One bounded, non-recording analyser. Never connected to context.destination. */
export function localAudioMeter(
  stream: MediaStream,
  sample: (level: number, state: MicrophoneState["meter"]) => void,
): () => void {
  const context = new AudioContext();
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    source?.disconnect();
    analyser?.disconnect();
    void context.close().catch(() => undefined);
  };
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(256); // overwritten, never retained/exported
    const tick = () => {
      if (closed) return;
      try {
        if (context.state === "running") {
          analyser!.getByteTimeDomainData(data);
          let squared = 0;
          for (const value of data) squared += ((value - 128) / 128) ** 2;
          sample(Math.min(1, Math.sqrt(squared / data.length)), "active");
        } else sample(0, "suspended");
        timer = setTimeout(tick, 100);
      } catch {
        sample(0, "unavailable");
        stop();
      }
    };
    void context.resume().catch(() => {
      if (!closed) sample(0, "suspended");
    });
    tick();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

/** Owns only pre-Start capture, not financial/transport state. Construction is passive. */
export class AudioPreflight {
  private stream: MediaStream | null = null;
  private generation = 0;
  private disposed = false;
  private stopMeter: (() => void) | undefined;
  private detach: (() => void) | undefined;
  state = { ...initialMicrophoneState };
  constructor(
    private readonly changed: (state: MicrophoneState) => void,
    private readonly input: Input = {
      compatible: () =>
        globalThis.isSecureContext &&
        typeof navigator.mediaDevices?.getUserMedia === "function" &&
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(patioAudioOptions().mimeType),
      open: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { ...PATIO_AUDIO_CONSTRAINTS },
          video: false,
        }),
      meter: localAudioMeter,
    },
  ) {}
  private update(patch: Partial<MicrophoneState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state);
  }
  private release(stopTracks: boolean) {
    this.detach?.();
    this.detach = undefined;
    this.stopMeter?.();
    this.stopMeter = undefined;
    if (stopTracks) this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
  async check() {
    if (
      this.disposed ||
      this.state.pending ||
      this.state.status === "transferred"
    )
      return;
    if (hasLiveAudio(this.stream)) {
      this.assertReady();
      return;
    }
    this.release(true);
    if (!this.input.compatible()) {
      this.update({
        status: "unsupported",
        message:
          "Secure context, microphone API and Patio audio recorder support are required.",
      });
      return;
    }
    const generation = ++this.generation;
    this.update({
      status: "waiting",
      pending: true,
      level: 0,
      message: "Waiting for microphone permission…",
    });
    try {
      const stream = await this.input.open();
      if (this.disposed || generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!hasLiveAudio(stream) || stream.getVideoTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new DOMException("No live audio-only track", "NotReadableError");
      }
      this.stream = stream;
      const track = stream.getAudioTracks()[0]!;
      const ended = () => {
        this.release(true);
        this.update({
          status: "interrupted",
          level: 0,
          meter: "off",
          message:
            "Microphone interrupted. Check it again; any prepared session is retained.",
        });
      };
      const mute = () => this.update({ muted: track.muted });
      track.addEventListener("ended", ended);
      track.addEventListener("mute", mute);
      track.addEventListener("unmute", mute);
      this.detach = () => {
        track.removeEventListener("ended", ended);
        track.removeEventListener("mute", mute);
        track.removeEventListener("unmute", mute);
      };
      this.update({
        status: "ready",
        muted: track.muted,
        message: "Microphone available",
      });
      try {
        this.stopMeter = this.input.meter(stream, (level, meter) => {
          if (
            !this.disposed &&
            generation === this.generation &&
            this.stream === stream
          ) {
            if (!hasLiveAudio(stream)) ended();
            else this.update({ level, meter });
          }
        });
      } catch {
        this.update({ meter: "unavailable", level: 0 });
      }
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.update({
          status: "unavailable",
          message: microphoneError(error),
          meter: "off",
        });
    } finally {
      this.update({ pending: false });
    }
  }
  assertReady() {
    if (
      this.disposed ||
      this.state.status !== "ready" ||
      !hasLiveAudio(this.stream)
    ) {
      if (this.state.status === "ready") {
        this.release(true);
        this.update({
          status: "interrupted",
          meter: "off",
          level: 0,
          message: "Microphone interrupted. Check it again.",
        });
      }
      throw new Error(
        "Check a live microphone before preparation or Start. Existing session retained.",
      );
    }
    return this.stream;
  }
  takeForCapture() {
    const stream = this.assertReady();
    ++this.generation;
    this.release(false); // ownership now belongs exclusively to the recorder
    this.update({
      status: "transferred",
      level: 0,
      meter: "off",
      message: "Microphone handed to broadcast capture",
    });
    return stream;
  }
  captureReleased() {
    if (this.state.status === "transferred")
      this.update({
        status: "off",
        message: "Microphone off. Session state is unchanged.",
      });
  }
  turnOff() {
    if (this.state.status === "transferred") return;
    ++this.generation;
    this.release(true);
    this.update({
      status: this.state.pending ? "cancelled" : "off",
      meter: "off",
      level: 0,
      muted: false,
      message: this.state.pending
        ? "Local wait cancelled. The browser dialog may remain open; resolve it before another check."
        : "Microphone off. Any prepared session is retained.",
    });
  }
  dispose() {
    this.turnOff();
    this.disposed = true;
  }
}

/** Called by the existing recorder owner, not the preflight. Mute is not ended. */
export function stopOnAudioEnded(stream: MediaStream, stop: () => void) {
  let stopped = false;
  const ended = () => {
    if (!stopped) {
      stopped = true;
      stop();
    }
  };
  const tracks = stream.getAudioTracks();
  tracks.forEach((t) => t.addEventListener("ended", ended));
  return () => tracks.forEach((t) => t.removeEventListener("ended", ended));
}
