import { useEffect, useState } from "react";

/**
 * Returns `value` delayed by `delayMs`. Subsequent updates within the
 * window reset the timer, so `parseMarkdown(useDebounced(rawMd, 200))`
 * runs once after the user pauses typing rather than on every keystroke.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
