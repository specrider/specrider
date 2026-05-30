import { useEffect, useState } from "react";
import {
  type BlameSet,
  blamePlan,
  type ChangedPlan,
  type ChangeSet,
  diffPlan,
  listChangedPlans,
  onPlanChanged,
  onPlansRootChanged,
} from "../tauri/api";

const EMPTY: ChangeSet = {
  added: [],
  modified: [],
  deletedAfter: [],
  hunks: [],
};

export type ChangeKind = "added" | "modified" | "deleted-near" | null;

/** Classifies a line range against the diff. "modified" wins over
 *  "added" wins over "deleted-near". */
export function changeKindForRange(
  diff: ChangeSet,
  startLine: number,
  endLineExclusive: number,
): { kind: ChangeKind; count: number } {
  let modifiedHits = 0;
  let addedHits = 0;
  let deletedHits = 0;
  const within = (ln: number) => ln >= startLine && ln < endLineExclusive;
  for (const ln of diff.modified) if (within(ln)) modifiedHits++;
  for (const ln of diff.added) if (within(ln)) addedHits++;
  for (const ln of diff.deletedAfter) if (within(ln)) deletedHits++;
  const count = modifiedHits + addedHits + deletedHits;
  if (count === 0) return { kind: null, count: 0 };
  if (modifiedHits > 0) return { kind: "modified", count };
  if (addedHits > 0) return { kind: "added", count };
  return { kind: "deleted-near", count };
}

export function changeKindForLine(diff: ChangeSet, line: number): ChangeKind {
  if (diff.modified.includes(line)) return "modified";
  if (diff.added.includes(line)) return "added";
  if (diff.deletedAfter.includes(line)) return "deleted-near";
  return null;
}

export function firstChangedLineInRange(
  diff: ChangeSet,
  startLine: number,
  endLineExclusive: number,
): number | null {
  let best: number | null = null;
  const consider = (ln: number) => {
    if (ln >= startLine && ln < endLineExclusive) {
      if (best === null || ln < best) best = ln;
    }
  };
  diff.added.forEach(consider);
  diff.modified.forEach(consider);
  diff.deletedAfter.forEach(consider);
  return best;
}

/** Wraps `diff_plan` for the active plan. Refreshes on `plan-changed`
 *  events for the matching path and on plans-root changes. */
export function useDiff(planRel: string | null): ChangeSet {
  const [diff, setDiff] = useState<ChangeSet>(EMPTY);

  useEffect(() => {
    if (!planRel) {
      setDiff(EMPTY);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      diffPlan(planRel)
        .then((cs) => {
          if (!cancelled) setDiff(cs);
        })
        .catch((e) => {
          console.error("diffPlan failed:", e);
        });
    };
    refresh();
    let unlistenPlan: (() => void) | undefined;
    let unlistenRoot: (() => void) | undefined;
    onPlanChanged((event) => {
      if (event.path === planRel) refresh();
    }).then((u) => {
      unlistenPlan = u;
    });
    onPlansRootChanged(() => {
      refresh();
    }).then((u) => {
      unlistenRoot = u;
    });
    return () => {
      cancelled = true;
      unlistenPlan?.();
      unlistenRoot?.();
    };
  }, [planRel]);

  return diff;
}

const EMPTY_BLAME: BlameSet = { lines: [], commits: {} };

/** Wraps `blame_plan`. Only fetches when `enabled` is true so the
 *  heavier `git blame` shell-out doesn't run for users who haven't
 *  opted in. Refreshes on `plan-changed` for the matching path. */
export function useBlame(planRel: string | null, enabled: boolean): BlameSet {
  const [blame, setBlame] = useState<BlameSet>(EMPTY_BLAME);

  useEffect(() => {
    if (!enabled || !planRel) {
      setBlame(EMPTY_BLAME);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      blamePlan(planRel)
        .then((b) => {
          if (!cancelled) setBlame(b);
        })
        .catch((e) => console.error("blamePlan failed:", e));
    };
    refresh();
    let unlistenPlan: (() => void) | undefined;
    let unlistenRoot: (() => void) | undefined;
    onPlanChanged((event) => {
      if (event.path === planRel) refresh();
    }).then((u) => {
      unlistenPlan = u;
    });
    onPlansRootChanged(() => {
      refresh();
    }).then((u) => {
      unlistenRoot = u;
    });
    return () => {
      cancelled = true;
      unlistenPlan?.();
      unlistenRoot?.();
    };
  }, [planRel, enabled]);

  return blame;
}

/** Wraps `list_changed_plans`. Refreshes on every `plan-changed` event
 *  (cheap — single git invocation) and when the plans root flips.
 *  Trailing-debounced so a burst of events (e.g. a folder rename
 *  fanning into many file events) coalesces into one git invocation. */
export function useChangedPlans(): Map<string, ChangedPlan> {
  const [map, setMap] = useState<Map<string, ChangedPlan>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const refresh = () => {
      listChangedPlans()
        .then((rows) => {
          if (cancelled) return;
          const next = new Map<string, ChangedPlan>();
          for (const r of rows) next.set(r.rel, r);
          setMap(next);
        })
        .catch((e) => console.error("listChangedPlans failed:", e));
    };
    const debouncedRefresh = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 80);
    };
    refresh();
    let unlistenPlan: (() => void) | undefined;
    let unlistenRoot: (() => void) | undefined;
    onPlanChanged(() => debouncedRefresh()).then((u) => {
      unlistenPlan = u;
    });
    onPlansRootChanged(() => refresh()).then((u) => {
      unlistenRoot = u;
    });
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      unlistenPlan?.();
      unlistenRoot?.();
    };
  }, []);

  return map;
}
