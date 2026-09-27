import { describe, expect, it } from "vitest";

import {
  audioDiscontinuityRecoveryPosition,
  chooseAudioStartupPosition,
} from "./audio-playback-policy";

describe("audio playback policy", () => {
  it("waits for roughly two reported audio chunks before an early start", () => {
    expect(
      chooseAudioStartupPosition([{ start: 0, end: 2.94 }], { force: false }),
    ).toBeNull();
    expect(
      chooseAudioStartupPosition([{ start: 0, end: 6 }], { force: false }),
    ).toEqual({ targetTime: 0, bufferedSeconds: 6 });
  });

  it("positions a recorded 15-packet backlog once with six seconds of cushion", () => {
    const decision = chooseAudioStartupPosition([{ start: 0, end: 45.48 }], {
      force: false,
    });
    expect(decision).toEqual({ targetTime: 39.48, bufferedSeconds: 6 });
  });

  it("does not seek when a normal three-second append extends a continuous range", () => {
    expect(
      audioDiscontinuityRecoveryPosition([{ start: 0, end: 48.54 }], 45.48),
    ).toBeNull();
    expect(
      audioDiscontinuityRecoveryPosition([{ start: 0, end: 60.72 }], 57.630667),
    ).toBeNull();
  });

  it("recovers only across a real discontinuity", () => {
    const ranges = [
      { start: 0, end: 3 },
      { start: 5, end: 8 },
    ];
    expect(audioDiscontinuityRecoveryPosition(ranges, 2.5)).toBeNull();
    expect(audioDiscontinuityRecoveryPosition(ranges, 4)).toBe(5);
  });

  it("escapes a stalled range end without skipping audio that is still playing", () => {
    const ranges = [
      { start: 0, end: 3 },
      { start: 5, end: 8 },
    ];
    expect(audioDiscontinuityRecoveryPosition(ranges, 3, 0.05, true)).toBe(5);
    expect(audioDiscontinuityRecoveryPosition(ranges, 2.97, 0.05, true)).toBe(
      5,
    );
    expect(
      audioDiscontinuityRecoveryPosition(ranges, 2.5, 0.05, true),
    ).toBeNull();
    expect(audioDiscontinuityRecoveryPosition(ranges, 3)).toBeNull();
    expect(
      audioDiscontinuityRecoveryPosition([{ start: 0, end: 3 }], 3, 0.05, true),
    ).toBeNull();
  });

  it("bounds startup with the best available continuous range", () => {
    expect(
      chooseAudioStartupPosition([{ start: 1, end: 3.5 }], { force: true }),
    ).toEqual({ targetTime: 1, bufferedSeconds: 2.5 });
  });
});
