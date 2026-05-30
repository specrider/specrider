import { useCallback, useMemo } from "react";

type PerfMarkApi = {
  mark: (name: string) => void;
  measure: (name: string, startMark: string, endMark?: string) => void;
  clear: (name?: string) => void;
};

function enabled(): boolean {
  return (
    import.meta.env.DEV &&
    typeof performance !== "undefined" &&
    typeof performance.mark === "function" &&
    typeof performance.measure === "function"
  );
}

function markName(scope: string, name: string): string {
  return `${scope}:${name}`;
}

export function usePerfMark(scope: string): PerfMarkApi {
  const mark = useCallback(
    (name: string) => {
      if (!enabled()) return;
      performance.mark(markName(scope, name));
    },
    [scope],
  );

  const measure = useCallback(
    (name: string, startMark: string, endMark?: string) => {
      if (!enabled()) return;
      try {
        performance.measure(
          markName(scope, name),
          markName(scope, startMark),
          endMark ? markName(scope, endMark) : undefined,
        );
      } catch {
        // Ignore missing marks in dev instrumentation paths.
      }
    },
    [scope],
  );

  const clear = useCallback(
    (name?: string) => {
      if (!enabled()) return;
      if (name == null) {
        performance.clearMarks();
        performance.clearMeasures();
        return;
      }
      const scopedName = markName(scope, name);
      performance.clearMarks(scopedName);
      performance.clearMeasures(scopedName);
    },
    [scope],
  );

  return useMemo(() => ({ mark, measure, clear }), [mark, measure, clear]);
}
