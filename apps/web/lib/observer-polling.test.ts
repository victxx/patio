import { afterEach, describe, expect, it, vi } from "vitest";
import { startObserverPolling } from "./observer-polling";

afterEach(() => vi.useRealTimers());
describe("bounded observer scheduling", () => {
  it("does not lose a whole polling tick to a slightly slow response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const starts: number[] = [];
    let active = 0;
    let peak = 0;
    const stop = startObserverPolling(async () => {
      starts.push(performance.now());
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 1100));
      --active;
    }, 1000);
    await vi.advanceTimersByTimeAsync(3500);
    stop();
    expect(starts).toEqual([0, 1125, 2250, 3375]);
    expect(peak).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(starts).toHaveLength(4);
  });
  it("caps normal reads at the configured cadence and backs off errors", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const poll = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValue(true);
    const stop = startObserverPolling(poll, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(4);
    stop();
  });
});
