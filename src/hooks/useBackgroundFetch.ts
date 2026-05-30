// Periodic background `git fetch` per Git-enabled window.
//
// The Rust side does the actual work; this hook just times calls.
// The next `useGitStatus` refresh (triggered by the
// `git-fetch-complete` event) picks up the new ahead/behind counts.
// Setting interval to 0 disables.

import { useEffect, useRef } from "react";
import { gitFetch } from "../tauri/api";

export function useBackgroundFetch(intervalSecs: number): void {
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!intervalSecs || intervalSecs <= 0) return;

    const tick = () => {
      if (cancelledRef.current) return;
      if (document.hidden) return;
      void gitFetch().catch(() => {
        /* Background fetch failures stay silent. */
      });
    };

    let timer: number | null = null;
    const startTimer = () => {
      if (timer != null || document.hidden) return;
      timer = window.setInterval(tick, Math.max(60, intervalSecs) * 1000);
    };
    const stopTimer = () => {
      if (timer == null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stopTimer();
      else startTimer();
    };

    // Don't fire on mount. Wait one full interval before the first
    // background fetch, like a real cron, so window activation stays
    // cheap.
    startTimer();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelledRef.current = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalSecs]);
}
