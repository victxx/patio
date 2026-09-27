import { describe, expect, it, vi } from "vitest";
import {
  AudioPlayRequests,
  audioListenerPresentation as present,
  naturalAudioProgress,
} from "./audio-listener-presentation";
const base = {
  session: true,
  compatible: true,
  observerReady: true,
  received: false,
  playable: false,
  requested: false,
  userPaused: false,
  progressing: false,
  started: false,
  ended: false,
  transportEnded: false,
  blocked: false,
  contextSuspended: false,
  error: null,
  connectionError: false,
};
describe("D3 audio presentation is evidence, not transport or playback commands", () => {
  it("reports interrupted reception without inventing canonical end or discarding buffered playback", () => {
    expect(
      present({ ...base, requested: true, receptionStalled: true }).message,
    ).toBe("Broadcast interrupted");
    expect(
      present({
        ...base,
        requested: true,
        receptionStalled: true,
        progressing: true,
      }).message,
    ).toBe("Playing");
    expect(
      present({
        ...base,
        requested: true,
        receptionStalled: true,
        userPaused: true,
      }).message,
    ).toBe("Paused by you");
    expect(
      present({ ...base, requested: true, receptionStalled: false }).message,
    ).toBe("Waiting for more audio");
  });
  it("allows early explicit Play; neither endpoint nor packet/append means Playing", () => {
    expect(present({ ...base, waitingForPacket: true }).action).toBe("none");
    expect(present(base)).toMatchObject({
      message: "Waiting for broadcast",
      action: "play",
    });
    expect(present({ ...base, requested: true }).message).toBe(
      "Waiting for more audio",
    );
    expect(present({ ...base, received: true, playable: true }).message).toBe(
      "Ready to listen",
    );
    expect(
      present({ ...base, received: true, playable: true, requested: true })
        .message,
    ).toBe("Preparing audio");
    expect(present({ ...base, progressing: true }).message).toBe("Playing");
  });
  it("RPC failure is secondary while buffered audio progresses; missing observer disables early Play", () => {
    expect(
      present({ ...base, progressing: true, connectionError: true }),
    ).toMatchObject({ message: "Playing", action: "pause" });
    expect(
      present({ ...base, observerReady: false, connectionError: true }).action,
    ).toBe("none");
  });
  it("mute/volume have no authority over receive state; pause is explicit and survives reception/end", () => {
    expect(
      present({ ...base, userPaused: true, received: true, playable: true })
        .message,
    ).toBe("Paused by you");
    expect(
      present({
        ...base,
        userPaused: true,
        playable: true,
        transportEnded: true,
      }),
    ).toMatchObject({
      message: "Broadcast ended — audio paused",
      action: "play",
    });
  });
  it("distinguishes permission, startup/rebuffer, terminal error and a real ended", () => {
    expect(present({ ...base, blocked: true }).action).toBe("enable");
    expect(present({ ...base, contextSuspended: true }).action).toBe("enable");
    expect(
      present({ ...base, blocked: true, blockReason: "interrupted" }).message,
    ).toBe("Playback interrupted");
    expect(present({ ...base, contextSuspended: true }).detail).toContain(
      "context is suspended",
    );
    expect(
      present({ ...base, requested: true, playable: true, started: true })
        .message,
    ).toBe("Waiting for more audio");
    expect(
      present({
        ...base,
        transportEnded: true,
        playable: true,
        progressing: true,
      }).message,
    ).toContain("playing remaining");
    expect(
      present({ ...base, transportEnded: true, playable: true }).message,
    ).toContain("available locally");
    expect(present({ ...base, transportEnded: true })).toMatchObject({
      message: "Broadcast ended — no playable audio received",
      action: "none",
    });
    expect(
      present({ ...base, started: true, transportEnded: true, ended: true })
        .message,
    ).toBe("Playback finished");
    expect(
      present({ ...base, transportEnded: true, ended: true }),
    ).toMatchObject({
      message: "Broadcast ended — audio did not play",
      tone: "warning",
    });
    expect(
      present({ ...base, transportEnded: true, ended: true, error: "decode" })
        .message,
    ).toBe("Playback error");
  });
  it("a pending close has no presentation authority; loss of canonical end does not retain a terminal label", () => {
    const before = present({ ...base, playable: true, progressing: true });
    expect(before.message).toBe("Playing");
    expect(
      present({
        ...base,
        playable: true,
        progressing: true,
        transportEnded: true,
      }).message,
    ).toContain("remaining");
    expect(
      present({
        ...base,
        playable: true,
        progressing: true,
        connectionError: true,
      }).message,
    ).toBe("Playing");
  });
  it("natural progress excludes paused, seeking, repeated or jumping currentTime", () => {
    const previous = { atMs: 0, currentTime: 0 };
    const current = {
      atMs: 300,
      currentTime: 0.3,
      paused: false,
      seeking: false,
    };
    expect(naturalAudioProgress(previous, current)).toBe(true);
    for (const patch of [
      { paused: true },
      { seeking: true },
      { currentTime: 0 },
      { currentTime: 20 },
    ])
      expect(naturalAudioProgress(previous, { ...current, ...patch })).toBe(
        false,
      );
  });
});
describe("D3 bounded play requests — only HTML media capability injected", () => {
  it("serializes requests; permission rejection requires a new explicit authorization", async () => {
    const gate = new AudioPlayRequests();
    const rejected = vi.fn();
    const play = vi.fn(() =>
      Promise.reject(new DOMException("denied", "NotAllowedError")),
    );
    gate.allow();
    gate.attempt({ play }, rejected);
    gate.attempt({ play }, rejected);
    await gate.pending;
    expect(play).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledWith("permission");
    gate.attempt({ play }, rejected);
    expect(play).toHaveBeenCalledTimes(1);
    gate.allow();
    gate.attempt({ play }, rejected);
    await gate.pending;
    expect(play).toHaveBeenCalledTimes(2);
  });
  it("pause during a pending play ignores late errors and never issues another play", async () => {
    const gate = new AudioPlayRequests();
    let reject!: (error: unknown) => void;
    const play = vi.fn(
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    );
    const pause = vi.fn();
    const failed = vi.fn();
    gate.allow();
    gate.attempt({ play }, failed);
    gate.cancel({ pause });
    reject(new DOMException("paused", "AbortError"));
    await gate.pending;
    expect(failed).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });
  it("reset/unmount isolates old promises from a new session", async () => {
    const gate = new AudioPlayRequests();
    let reject!: (error: unknown) => void;
    const failed = vi.fn();
    gate.attempt(
      {
        play: () =>
          new Promise<void>((_, no) => {
            reject = no;
          }),
      },
      failed,
    );
    const old = gate.pending;
    gate.reset();
    gate.allow();
    gate.attempt({ play: () => Promise.resolve() }, failed);
    reject(new Error("old session"));
    await old;
    await gate.pending;
    expect(gate.blocked).toBe(false);
    expect(failed).not.toHaveBeenCalled();
  });
});
