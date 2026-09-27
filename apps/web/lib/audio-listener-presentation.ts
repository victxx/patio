/** Presentation only: not a transport lifecycle or a source of canonical evidence. */
export function audioListenerPresentation(input: {
  session: boolean;
  compatible: boolean;
  observerReady: boolean;
  waitingForPacket?: boolean;
  received: boolean;
  playable: boolean;
  requested: boolean;
  userPaused: boolean;
  progressing: boolean;
  started: boolean;
  ended: boolean;
  transportEnded: boolean;
  blocked: boolean;
  blockReason?: "permission" | "interrupted" | "unsupported" | null;
  contextSuspended: boolean;
  error: string | null;
  connectionError: boolean;
  receptionStalled?: boolean;
}) {
  const view = (
    message: string,
    detail: string,
    action: "play" | "pause" | "enable" | "none",
    tone = "waiting",
  ) => ({ message, detail, action, tone });
  if (input.error) return view("Playback error", input.error, "none", "error");
  if (!input.session)
    return view(
      "Waiting for broadcast",
      "Open a valid session link. No sound starts automatically.",
      "none",
    );
  if (!input.compatible)
    return view(
      "Playback unavailable",
      "This browser needs support for Patio’s existing Opus/WebM MediaSource format.",
      "none",
      "error",
    );
  if (input.ended)
    return view(
      input.started
        ? "Playback finished"
        : "Broadcast ended — audio did not play",
      input.started
        ? "The received audio has finished."
        : "Not enough playable audio arrived in this listener.",
      "none",
      input.started ? "complete" : "warning",
    );
  if (input.waitingForPacket && !input.transportEnded)
    return view(
      "Waiting for broadcast",
      "This link needs a compatible media packet before playback can be enabled.",
      "none",
    );
  if (input.transportEnded && !input.playable)
    return view(
      "Broadcast ended — no playable audio received",
      "Reception has ended. There is no local recording to replay.",
      "none",
      "complete",
    );
  if (input.userPaused)
    return view(
      input.transportEnded ? "Broadcast ended — audio paused" : "Paused by you",
      "Resume the available audio when ready. Local buffering is bounded, not permanent storage.",
      "play",
    );
  if (input.blocked || input.contextSuspended)
    return view(
      input.blockReason === "interrupted" && !input.contextSuspended
        ? "Playback interrupted"
        : "Playback needs your permission",
      input.contextSuspended
        ? "The audio context is suspended. Enable audio to resume it without resetting the buffer."
        : input.blockReason === "interrupted"
          ? "The play request was interrupted. Enable audio to try again without discarding its buffer."
          : "The browser blocked play. Enable audio here; this does not restart the broadcast or discard its buffer.",
      "enable",
      "warning",
    );
  if (input.progressing)
    return view(
      input.transportEnded
        ? "Broadcast ended — playing remaining audio"
        : "Playing",
      input.connectionError
        ? "Connection unavailable; buffered audio can continue. Reception will use the existing retry policy."
        : "Browser timeline is advancing. Muting or silence does not imply a network failure.",
      "pause",
      "playing",
    );
  if (input.transportEnded && !input.requested)
    return view(
      "Broadcast ended — audio available locally",
      "Play the received remainder; it is not a complete or permanent recording.",
      "play",
    );
  if (!input.observerReady && !input.playable)
    return view(
      "Connection unavailable",
      "Waiting for the configured observer to validate this session. No provider switch.",
      "none",
      "warning",
    );
  if (input.requested)
    return view(
      input.receptionStalled
        ? "Broadcast interrupted"
        : input.playable && !input.started
          ? "Preparing audio"
          : "Waiting for more audio",
      input.receptionStalled
        ? "No new audio. Waiting to reconnect."
        : input.connectionError
          ? "Connection unavailable. Existing audio is retained; waiting for reception."
          : input.received && !input.playable
            ? "Waiting for the existing audio sync point; earlier content cannot be recovered."
            : "Listening requested. Startup follows the existing bounded buffer policy.",
      "pause",
    );
  return view(
    input.received ? "Ready to listen" : "Waiting for broadcast",
    "Press Play now to wait for audio. No capture, wallet or broadcaster action is required.",
    "play",
  );
}

/** A seek, append, paused element or implausible time jump is not natural progress. */
export function naturalAudioProgress(
  previous: { atMs: number; currentTime: number },
  current: {
    atMs: number;
    currentTime: number;
    paused: boolean;
    seeking: boolean;
  },
) {
  const elapsed = (current.atMs - previous.atMs) / 1000;
  const delta = current.currentTime - previous.currentTime;
  return (
    !current.paused &&
    !current.seeking &&
    elapsed >= 0.2 &&
    delta > 0 &&
    delta <= elapsed * 1.5 + 0.1
  );
}

/** Serializes play promises only. Cannot read RPC, sign, fund, send or clean up. */
export class AudioPlayRequests {
  generation = 0;
  blocked = false;
  pending: Promise<void> | null = null;
  allow() {
    this.blocked = false;
    return ++this.generation;
  }
  cancel(element: Pick<HTMLMediaElement, "pause"> | null) {
    ++this.generation;
    this.blocked = false;
    element?.pause();
  }
  reset() {
    this.cancel(null);
    this.pending = null;
  }
  attempt(
    element: Pick<HTMLMediaElement, "play">,
    rejected: (reason: "permission" | "interrupted" | "unsupported") => void,
  ) {
    if (this.pending || this.blocked) return;
    const generation = this.generation;
    const promise = element
      .play()
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.blocked = true;
        const name = error instanceof Error ? error.name : "UnknownError";
        rejected(
          name === "NotAllowedError"
            ? "permission"
            : name === "NotSupportedError"
              ? "unsupported"
              : "interrupted",
        );
      })
      .finally(() => {
        if (this.pending === promise) this.pending = null;
      });
    this.pending = promise;
  }
}
