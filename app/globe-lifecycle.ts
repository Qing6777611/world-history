/** Own resources as soon as they are acquired, including during partial startup. */
export function createGlobeLifetime(onError: (error: unknown) => void = console.error) {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  let disposed = false;
  const release = (cleanup: () => void) => {
    try { cleanup(); } catch (error) { onError(error); }
  };
  return {
    signal: controller.signal,
    add(cleanup: () => void) {
      if (disposed) release(cleanup);
      else cleanups.push(cleanup);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      while (cleanups.length) release(cleanups.pop()!);
    },
  };
}
