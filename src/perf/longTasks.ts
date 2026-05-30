let installed = false;

export function installLongTaskObserver(): void {
  if (!import.meta.env.DEV || installed) return;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        console.warn("[perf] long task", {
          durationMs: Math.round(entry.duration),
          startMs: Math.round(entry.startTime),
          name: entry.name,
        });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    installed = true;
  } catch {
    /* longtask is not available in every WebView engine */
  }
}
