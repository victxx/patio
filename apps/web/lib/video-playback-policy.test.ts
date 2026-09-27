import { expect, it } from "vitest";
import { stalledVideoRecoveryPosition } from "./video-playback-policy";

it("recovers isolated short received groups after a sustained stall", () => {
  const ranges = [
    { start: 9, end: 9.78 },
    { start: 46, end: 47.653 },
  ];
  expect(stalledVideoRecoveryPosition(ranges, 0, 6000)).toBeCloseTo(9.5148);
  expect(stalledVideoRecoveryPosition(ranges, 0, 4000)).toBeNull();
});

it("leaves an unplayable old group only after a stall and with fresh buffered video", () => {
  const ranges = [
    { start: 0, end: 2.87 },
    { start: 8.94, end: 18 },
  ];
  expect(stalledVideoRecoveryPosition(ranges, 0, 3600)).toBe(9.94);
  expect(stalledVideoRecoveryPosition(ranges, 0, 1000)).toBeNull();
  expect(
    stalledVideoRecoveryPosition([{ start: 0, end: 2.87 }], 0, 5000),
  ).toBeNull();
});
it("retains a two-second cushion instead of seeking to the last frame", () => {
  expect(stalledVideoRecoveryPosition([{ start: 0, end: 10 }], 0, 3600)).toBe(
    8,
  );
  expect(
    stalledVideoRecoveryPosition([{ start: 0, end: 10 }], 8, 3600),
  ).toBeNull();
});
