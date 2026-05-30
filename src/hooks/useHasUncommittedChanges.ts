// Repo-wide dirtiness probe for the synthetic Unstaged row in the
// diff explorer rail. The Rust side checks tracked changes against
// HEAD (or the empty tree before the first commit) plus untracked files,
// matching the scope of `git_status_unstaged` that produces the row body.
//
// Refresh strategy mirrors useGitBranch:
//   - mount
//   - any plan-changed event (post-commit, post-stash, etc. — anything
//     that touches a watched .md file usually coincides with a
//     working-tree shift the user wants reflected)
//
// Returns `null` until the first fetch resolves so callers (notably
// the seed-selection effect in App.tsx) can distinguish "loading" from
// "definitely clean" and avoid auto-selecting the wrong row.

import { useEffect, useRef, useState } from "react";
import {
  getHasUncommittedChanges,
  onPlanChanged,
  onWorkspaceTrustChanged,
} from "../tauri/api";

const REFRESH_DEBOUNCE_MS = 250;

export function useHasUncommittedChanges(
  enabled = true,
  repoHandle: string | null = null,
): boolean | null {
  const repoKey = repoHandle ?? "docs";
  const [state, setState] = useState<{
    repoKey: string;
    dirty: boolean | null;
  }>({ repoKey, dirty: null });
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setState({ repoKey, dirty: null });
      return;
    }
    setState({ repoKey, dirty: null });
    cancelledRef.current = false;

    const refresh = () => {
      void getHasUncommittedChanges(repoHandle)
        .then((d) => {
          if (!cancelledRef.current) setState({ repoKey, dirty: d });
        })
        .catch(() => {
          if (!cancelledRef.current) setState({ repoKey, dirty: false });
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

    let unlisten: (() => void) | null = null;
    let unlistenTrust: (() => void) | null = null;
    void onPlanChanged(debouncedRefresh).then((un) => {
      if (cancelledRef.current) un();
      else unlisten = un;
    });
    void onWorkspaceTrustChanged(debouncedRefresh).then((un) => {
      if (cancelledRef.current) un();
      else unlistenTrust = un;
    });

    return () => {
      cancelledRef.current = true;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      unlisten?.();
      unlistenTrust?.();
    };
  }, [enabled, repoHandle, repoKey]);

  if (!enabled || state.repoKey !== repoKey) return null;
  return state.dirty;
}
