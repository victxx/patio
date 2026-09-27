import type { AudioBufferedRange } from "./audio-playback-policy";

/** Recover a real stall, never chase the live edge during normal playback.
 * An incomplete first WebM group can remain reported as buffered even when
 * Chromium stays HAVE_METADATA. Prefer a later group with room for a
 * low-rate video frame plus two seconds of playable cushion.
 */
export function stalledVideoRecoveryPosition(
  ranges: readonly AudioBufferedRange[],
  currentTime: number,
  stalledMs: number,
): number | null {
  if (stalledMs < 3500) return null;
  const next = ranges.find(
    (r) => r.start > currentTime + 0.05 && r.end - r.start >= 3,
  );
  if (next) return next.start + 1;
  // Real pool loss can leave only isolated sub-three-second groups. Waiting
  // forever for a long range leaves an otherwise decodable video black.
  if (stalledMs >= 6000) {
    const short = ranges.find(
      (r) => r.start > currentTime + 0.05 && r.end - r.start >= 0.2,
    );
    if (short)
      return short.start + Math.min(1, (short.end - short.start) * 0.66);
  }
  const current = ranges.find(
    (r) => r.start <= currentTime && r.end - currentTime >= 4,
  );
  if (current) return current.end - 2;
  const initial = ranges.find(
    (r) => r.start <= currentTime + 0.05 && r.end - currentTime >= 0.5,
  );
  return stalledMs >= 6000 && initial
    ? currentTime + Math.min(1, (initial.end - currentTime) * 0.66)
    : null;
}
