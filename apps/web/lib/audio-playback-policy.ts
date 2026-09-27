export const AUDIO_STARTUP_TARGET_BUFFER_SECONDS = 6;
export const AUDIO_STARTUP_MAX_WAIT_MS = 6_500;

export interface AudioBufferedRange {
  start: number;
  end: number;
}

export interface BufferedRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

export function snapshotBufferedRanges(
  ranges: BufferedRangesLike,
): AudioBufferedRange[] {
  const result: AudioBufferedRange[] = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      result.push({ start, end });
    }
  }
  return result;
}

/**
 * Audio starts once a useful continuous cushion exists. A bounded timeout may
 * force startup with the best range available, but normal appends never cause
 * another live-edge seek.
 */
export function chooseAudioStartupPosition(
  ranges: readonly AudioBufferedRange[],
  options: {
    force: boolean;
    targetBufferSeconds?: number;
  },
): { targetTime: number; bufferedSeconds: number } | null {
  if (ranges.length === 0) return null;
  const targetBufferSeconds =
    options.targetBufferSeconds ?? AUDIO_STARTUP_TARGET_BUFFER_SECONDS;
  const best = ranges.reduce((selected, candidate) =>
    candidate.end - candidate.start > selected.end - selected.start
      ? candidate
      : selected,
  );
  const bufferedSeconds = best.end - best.start;
  if (!options.force && bufferedSeconds < targetBufferSeconds) return null;
  return {
    targetTime: Math.max(best.start, best.end - targetBufferSeconds),
    bufferedSeconds: Math.min(bufferedSeconds, targetBufferSeconds),
  };
}

/**
 * Recover outside buffered ranges, or at an exhausted range end after an
 * actual waiting event. Browsers stall AT the end, not beyond it. Never chase
 * the live edge or skip a range that still has playable audio.
 */
export function audioDiscontinuityRecoveryPosition(
  ranges: readonly AudioBufferedRange[],
  currentTime: number,
  toleranceSeconds = 0.05,
  waiting = false,
): number | null {
  if (
    ranges.some(
      (range) =>
        currentTime >= range.start - toleranceSeconds &&
        currentTime <= range.end + toleranceSeconds &&
        !(waiting && currentTime >= range.end - toleranceSeconds),
    )
  ) {
    return null;
  }
  const next = ranges.find((range) => range.start > currentTime);
  return next ? next.start : null;
}
