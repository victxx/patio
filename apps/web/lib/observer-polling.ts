/** One request in flight; start-to-start cadence, not interval tick rounding.
 * A 1.1s response must not turn a 1s cadence into one read every 2s. Errors
 * back off instead of increasing pressure. Disposing never schedules again.
 */
export function startObserverPolling(
  poll: () => Promise<boolean | void>,
  intervalMs: number,
): () => void {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const started = performance.now();
    try {
      failures = (await poll()) === false ? Math.min(failures + 1, 3) : 0;
    } catch {
      failures = Math.min(failures + 1, 3);
    }
    if (!stopped) {
      const delay = failures
        ? intervalMs * 2 ** failures
        : Math.max(25, intervalMs - (performance.now() - started));
      timer = setTimeout(() => void run(), delay);
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
