// Fetches the full-repo commit graph + refs in a single coordinated
// pulse, computes the lane layout, and exposes everything the rail
// needs to render lanes + branch labels + plan-relevance highlighting.
//
// Refreshes on `plan-changed` events, with an explicit `refresh()`
// escape hatch for ref-only changes that don't trigger a file watcher
// pulse, e.g. branch creation in the terminal.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assignLanes, type GraphLayout } from "../lib/commitGraphLanes";
import { formatRelativeTime } from "../lib/time";
import {
  type GraphCommit,
  getCommitGraph,
  getGitRefs,
  onPlanChanged,
  onWorkspaceTrustChanged,
  type PlanRelevance,
  type RefEntry,
} from "../tauri/api";

const REFRESH_DEBOUNCE_MS = 250;
const LOADING_INDICATOR_DELAY_MS = 180;
const EMPTY_COMMITS: GraphCommit[] = [];
const EMPTY_RELEVANCE: PlanRelevance[] = [];
const EMPTY_REFS: RefEntry[] = [];

export interface CommitGraphState {
  commits: GraphCommit[];
  layout: GraphLayout;
  /** Full SHA → derived row strings that only need periodic refresh. */
  derivedBySha: Map<string, CommitDerived>;
  /** Full SHA → strongest plan-relevance source. Drives row
   *  highlighting in the rail. */
  relevanceBySha: Map<string, PlanRelevance>;
  /** Full SHA → refs that point at this commit. Empty array when no
   *  ref tip lives there. Used by the rail to render branch labels
   *  next to tip commits. */
  refsByCommit: Map<string, RefEntry[]>;
  /** Full SHA → display-ready refs with local/remote duplicates removed
   *  and a stable visual sort applied. */
  displayRefsByCommit: Map<string, RefEntry[]>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Force re-fetch — covers ref-only changes that don't trigger the
   *  file watcher (branch checkout / create / delete with no working
   *  tree change). */
  refresh: () => void;
}

export interface CommitDerived {
  rel: string;
  initials: string;
}

function authorInitials(name: string): string {
  if (!name) return "-";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "-";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function refRank(r: RefEntry): number {
  if (r.isHead) return 0;
  if (r.isDefaultBranch) return 1;
  if (r.kind === "branch") return 2;
  if (r.kind === "remote") return 3;
  return 4;
}

export function useCommitGraph(args: {
  planRel: string | null;
  branches: string[];
  commitShas: string[];
  repoHandle?: string | null;
  reviewBranch?: string | null;
  reviewBase?: string | null;
  limit?: number;
  enabled?: boolean;
}): CommitGraphState {
  const {
    planRel,
    branches,
    commitShas,
    repoHandle = null,
    reviewBranch = null,
    reviewBase = null,
    limit,
    enabled = true,
  } = args;
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [relevance, setRelevance] = useState<PlanRelevance[]>([]);
  const [refs, setRefs] = useState<RefEntry[]>([]);
  const [resultKey, setResultKey] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const loadingTimerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const cancelledRef = useRef(false);
  const [_minuteTick, setMinuteTick] = useState(0);

  // Stringify deps so reference changes don't re-fire on every render
  // when the caller passes fresh-but-equivalent arrays.
  const branchesKey = branches.join("\x1f");
  const commitsKey = commitShas.join("\x1f");
  const repoKey = `${repoHandle ?? "docs"}\x1f${reviewBase ?? ""}\x1f${
    reviewBranch ?? ""
  }`;
  const queryKey = `${planRel ?? ""}\x1e${branchesKey}\x1e${commitsKey}\x1e${repoKey}\x1e${
    limit ?? ""
  }`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed deps avoid graph refetches from equivalent array props.
  const fetchAll = useCallback(() => {
    if (!enabled) return;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (loadingTimerRef.current != null) {
      window.clearTimeout(loadingTimerRef.current);
    }
    setLoading(false);
    setError(null);
    loadingTimerRef.current = window.setTimeout(() => {
      loadingTimerRef.current = null;
      if (!cancelledRef.current && requestIdRef.current === requestId) {
        setLoading(true);
      }
    }, LOADING_INDICATOR_DELAY_MS);
    Promise.all([
      getCommitGraph({
        planRel,
        branches,
        commitShas,
        repoHandle,
        reviewBranch,
        reviewBase,
        limit,
      }),
      getGitRefs(repoHandle),
    ])
      .then(([graph, refsList]) => {
        if (cancelledRef.current || requestIdRef.current !== requestId) return;
        if (loadingTimerRef.current != null) {
          window.clearTimeout(loadingTimerRef.current);
          loadingTimerRef.current = null;
        }
        setCommits(graph.commits);
        setRelevance(graph.planRelevance);
        setRefs(refsList);
        setResultKey(queryKey);
        setLoading(false);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (cancelledRef.current || requestIdRef.current !== requestId) return;
        if (loadingTimerRef.current != null) {
          window.clearTimeout(loadingTimerRef.current);
          loadingTimerRef.current = null;
        }
        setCommits([]);
        setRelevance([]);
        setRefs([]);
        setResultKey(queryKey);
        setLoading(false);
        setLoaded(true);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [enabled, planRel, branchesKey, commitsKey, repoKey, limit, queryKey]);

  useEffect(() => {
    if (!enabled) {
      if (loadingTimerRef.current != null) {
        window.clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      setLoading(false);
      return;
    }
    cancelledRef.current = false;
    fetchAll();

    const debounced = () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        fetchAll();
      }, REFRESH_DEBOUNCE_MS);
    };

    let unlisten: (() => void) | null = null;
    let unlistenTrust: (() => void) | null = null;
    void onPlanChanged(() => {
      // The watcher is plansRoot-scoped, and the file event is a
      // strong proxy for "something git-relevant happened" — refresh
      // wholesale rather than trying to scope by path. The graph
      // covers `--all`, so even unrelated branches need to be picked
      // up after a commit lands.
      debounced();
    }).then((un) => {
      if (cancelledRef.current) {
        un();
      } else {
        unlisten = un;
      }
    });
    void onWorkspaceTrustChanged(debounced).then((un) => {
      if (cancelledRef.current) {
        un();
      } else {
        unlistenTrust = un;
      }
    });

    return () => {
      cancelledRef.current = true;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      if (loadingTimerRef.current != null) {
        window.clearTimeout(loadingTimerRef.current);
      }
      timerRef.current = null;
      loadingTimerRef.current = null;
      unlisten?.();
      unlistenTrust?.();
    };
  }, [enabled, fetchAll]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setMinuteTick((tick) => tick + 1);
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const currentResult = enabled && resultKey === queryKey;
  const visibleCommits = currentResult ? commits : EMPTY_COMMITS;
  const visibleRelevance = currentResult ? relevance : EMPTY_RELEVANCE;
  const visibleRefs = currentResult ? refs : EMPTY_REFS;
  const visibleError = currentResult ? error : null;
  const visibleLoaded = currentResult ? loaded : false;

  const layout = useMemo(() => assignLanes(visibleCommits), [visibleCommits]);
  const derivedBySha = useMemo(() => {
    const m = new Map<string, CommitDerived>();
    for (const c of visibleCommits) {
      m.set(c.sha, {
        rel: formatRelativeTime(c.timeSecs),
        initials: authorInitials(c.authorName),
      });
    }
    return m;
  }, [visibleCommits]);
  const relevanceBySha = useMemo(() => {
    const m = new Map<string, PlanRelevance>();
    for (const r of visibleRelevance) m.set(r.sha, r);
    return m;
  }, [visibleRelevance]);
  const refsByCommit = useMemo(() => {
    const m = new Map<string, RefEntry[]>();
    for (const r of visibleRefs) {
      const list = m.get(r.targetSha);
      if (list) list.push(r);
      else m.set(r.targetSha, [r]);
    }
    return m;
  }, [visibleRefs]);
  const displayRefsByCommit = useMemo(() => {
    const m = new Map<string, RefEntry[]>();
    for (const [sha, allRefs] of refsByCommit.entries()) {
      const localBranchNames = new Set(
        allRefs.filter((r) => r.kind === "branch").map((r) => r.name),
      );
      m.set(
        sha,
        allRefs
          .filter(
            (r) =>
              !(
                r.kind === "remote" &&
                r.name.startsWith("origin/") &&
                localBranchNames.has(r.name.slice("origin/".length))
              ),
          )
          .sort((a, b) => refRank(a) - refRank(b)),
      );
    }
    return m;
  }, [refsByCommit]);

  return {
    commits: visibleCommits,
    layout,
    derivedBySha,
    relevanceBySha,
    refsByCommit,
    displayRefsByCommit,
    loading,
    loaded: visibleLoaded,
    error: visibleError,
    refresh: fetchAll,
  };
}
