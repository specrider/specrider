// Polled `git_status` snapshot for the active window's plansRoot.
// Refreshes on:
//   - mount
//   - background interval (configurable; defaults to 30s)
//   - any plan-changed event (covers post-commit, post-checkout, etc.)
//   - explicit `refresh()` calls after every UI-driven git command
//
// Returns null until the first fetch settles so callers can
// distinguish "loading" from "definitely-not-a-repo". `refresh` is
// stable (useCallback) and safe to wire into command handlers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GitStatus,
  getGitStatus,
  onGitFetchComplete,
  onPlanChanged,
} from "../tauri/api";

const REFRESH_DEBOUNCE_MS = 250;
const DEFAULT_INTERVAL_MS = 30_000;

export interface UseGitStatusResult {
  status: GitStatus | null;
  refresh: () => void;
}

export function useGitStatus(
  intervalMs = DEFAULT_INTERVAL_MS,
): UseGitStatusResult {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const debounceRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(() => {
    void getGitStatus()
      .then((s) => {
        if (!cancelledRef.current) setStatus(s);
      })
      .catch(() => {
        if (!cancelledRef.current) setStatus(null);
      });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;

    const debounced = () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    refresh();

    let unlistenPlanChanged: (() => void) | null = null;
    void onPlanChanged(debounced).then((un) => {
      if (cancelledRef.current) un();
      else unlistenPlanChanged = un;
    });

    let unlistenFetch: (() => void) | null = null;
    void onGitFetchComplete(debounced).then((un) => {
      if (cancelledRef.current) un();
      else unlistenFetch = un;
    });

    let interval: number | null = null;
    const startInterval = () => {
      if (interval != null || intervalMs <= 0 || document.hidden) return;
      interval = window.setInterval(refresh, Math.max(5000, intervalMs));
    };
    const stopInterval = () => {
      if (interval == null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const onVisibility = () => {
      if (document.hidden) stopInterval();
      else startInterval();
    };
    startInterval();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelledRef.current = true;
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
      unlistenPlanChanged?.();
      unlistenFetch?.();
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, refresh]);

  return useMemo(() => ({ status, refresh }), [status, refresh]);
}
