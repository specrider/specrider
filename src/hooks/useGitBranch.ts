// Returns the current branch info for the window's plansRoot. Refreshes
// on:
//   - mount
//   - plansRoot change (re-fetched indirectly via plan-changed too)
//   - any plan-changed event (covers post-commit, post-checkout, etc.
//     since both touch files under the repo)
//
// Cheap shellout, no caching needed on the JS side.

import { useEffect, useRef, useState } from "react";
import { type BranchInfo, getGitBranch, onPlanChanged } from "../tauri/api";

const REFRESH_DEBOUNCE_MS = 250;

export function useGitBranch(): BranchInfo | null {
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const refresh = () => {
      void getGitBranch()
        .then((info) => {
          if (!cancelledRef.current) setBranch(info);
        })
        .catch(() => {
          if (!cancelledRef.current) setBranch(null);
        });
    };

    const debouncedRefresh = () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    refresh();

    let unlistenPlanChanged: (() => void) | null = null;
    void onPlanChanged(debouncedRefresh).then((un) => {
      if (cancelledRef.current) {
        un();
      } else {
        unlistenPlanChanged = un;
      }
    });

    return () => {
      cancelledRef.current = true;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      unlistenPlanChanged?.();
    };
  }, []);

  return branch;
}
