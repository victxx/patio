import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioPreflight,
  localAudioMeter,
  stopOnAudioEnded,
} from "./audio-preflight";

class Track extends EventTarget {
  readyState = "live";
  enabled = true;
  muted = false;
  stop = vi.fn(() => {
    this.readyState = "ended";
  }); // stop deliberately emits no ended
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
function fixture() {
  const track = new Track();
  const stream = {
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const cleanup = vi.fn();
  const input = {
    compatible: () => true,
    open: vi.fn(() => Promise.resolve(stream)),
    meter: vi.fn(
      (
        _stream: MediaStream,
        sample: (level: number, state: "active") => void,
      ) => {
        sample(0, "active");
        return cleanup;
      },
    ),
  };
  const changed = vi.fn();
  const mic = new AudioPreflight(changed, input);
  return { track, stream, input, cleanup, mic, changed };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("D2 local microphone ownership", () => {
  it("constructs passively; silent live audio is ready and meter cleanup does not stop a transferred stream", async () => {
    const f = fixture();
    expect(f.input.open).not.toHaveBeenCalled();
    await f.mic.check();
    expect(f.mic.state).toMatchObject({ status: "ready", level: 0 });
    await f.mic.check();
    expect(f.input.open).toHaveBeenCalledTimes(1);
    expect(f.mic.takeForCapture()).toBe(f.stream);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    f.mic.turnOff();
    f.mic.dispose();
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(() => f.mic.takeForCapture()).toThrow();
    f.track.stop(); // existing recorder owns this responsibility
  });
  it.each([
    "NotAllowedError",
    "NotFoundError",
    "NotReadableError",
    "OverconstrainedError",
  ])("reports %s and cannot become ready", async (name) => {
    const f = fixture();
    f.input.open.mockRejectedValueOnce(
      new DOMException("private device detail", name),
    );
    await f.mic.check();
    expect(f.mic.state.status).toBe("unavailable");
    expect(f.mic.state.message).toContain(name);
    expect(f.mic.state.message).not.toContain("private device detail");
    expect(() => f.mic.assertReady()).toThrow();
  });
  it.each(["cancel", "unmount"])(
    "%s ignores a late grant, releases tracks and prevents concurrent requests",
    async (action) => {
      const f = fixture();
      let resolve!: (stream: MediaStream) => void;
      f.input.open.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = f.mic.check();
      if (action === "cancel") f.mic.turnOff();
      else f.mic.dispose();
      await f.mic.check();
      expect(f.input.open).toHaveBeenCalledTimes(1);
      expect(() => f.mic.assertReady()).toThrow();
      resolve(f.stream);
      await pending;
      expect(f.track.stop).toHaveBeenCalledTimes(1);
      expect(f.input.meter).not.toHaveBeenCalled();
      expect(f.mic.state.status).not.toBe("ready");
    },
  );
  it("mute/unmute are not device loss; ended invalidates; stop without an event is revalidated", async () => {
    const f = fixture();
    await f.mic.check();
    f.track.muted = true;
    f.track.dispatchEvent(new Event("mute"));
    expect(f.mic.state.muted).toBe(true);
    expect(f.mic.assertReady()).toBe(f.stream);
    f.track.muted = false;
    f.track.dispatchEvent(new Event("unmute"));
    expect(f.mic.state.muted).toBe(false);
    f.track.end();
    expect(f.mic.state.status).toBe("interrupted");
    expect(() => f.mic.assertReady()).toThrow();
    const g = fixture();
    await g.mic.check();
    g.track.stop();
    expect(() => g.mic.assertReady()).toThrow();
    expect(g.mic.state.status).toBe("interrupted");
  });
  it("meter failure does not invent device loss; turning off updates state without ended", async () => {
    const f = fixture();
    f.input.meter.mockImplementation(() => {
      throw new Error("meter unavailable");
    });
    await f.mic.check();
    expect(f.mic.state.meter).toBe("unavailable");
    expect(f.mic.assertReady()).toBe(f.stream);
    f.mic.turnOff();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.mic.state.status).toBe("off");
  });
  it("uses existing audio-only constraints and MIME support, never constructs a recorder during check", async () => {
    const f = fixture();
    const open = vi.fn(() => Promise.resolve(f.stream));
    const recorder = vi.fn();
    Object.assign(recorder, { isTypeSupported: vi.fn(() => true) });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: open } });
    vi.stubGlobal("MediaRecorder", recorder);
    const mic = new AudioPreflight(vi.fn());
    await mic.check();
    expect(open).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true },
      video: false,
    });
    expect(recorder).not.toHaveBeenCalled();
    mic.dispose();
    vi.stubGlobal("isSecureContext", false);
    const blocked = new AudioPreflight(vi.fn());
    await blocked.check();
    expect(blocked.state.status).toBe("unsupported");
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("bounds analyser samples to 10Hz, reuses one buffer, never connects to a speaker or stores media", () => {
    vi.useFakeTimers();
    const seen = new Set<Uint8Array>();
    const sample = vi.fn();
    const analyser = {
      fftSize: 0,
      getByteTimeDomainData: (data: Uint8Array) => {
        seen.add(data);
        data.fill(128);
      },
      disconnect: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const destination = {};
    const close = vi.fn(() => Promise.resolve());
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = destination;
        createMediaStreamSource = () => source;
        createAnalyser = () => analyser;
        resume = () => Promise.resolve();
        close = close;
      },
    );
    const f = fixture();
    const stop = localAudioMeter(f.stream, sample);
    vi.advanceTimersByTime(1000);
    expect(sample).toHaveBeenCalledTimes(11);
    expect(seen.size).toBe(1);
    expect([...seen][0]?.length).toBe(256);
    expect(source.connect).toHaveBeenCalledExactlyOnceWith(analyser);
    expect(source.connect).not.toHaveBeenCalledWith(destination);
    stop();
    vi.advanceTimersByTime(1000);
    expect(sample).toHaveBeenCalledTimes(11);
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.track.stop).not.toHaveBeenCalled();
  });
  it("after handoff an ended track requests existing controlled stop once; mute never stops", async () => {
    const f = fixture();
    await f.mic.check();
    const stop = vi.fn();
    const detach = stopOnAudioEnded(f.mic.takeForCapture(), stop);
    f.track.dispatchEvent(new Event("mute"));
    expect(stop).not.toHaveBeenCalled();
    f.track.end();
    f.track.end();
    expect(stop).toHaveBeenCalledTimes(1);
    detach();
    f.mic.captureReleased();
    expect(f.mic.state.status).toBe("off");
  });
});
