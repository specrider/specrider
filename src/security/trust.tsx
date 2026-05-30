import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DefaultTrustPolicy } from "../settings/types";
import {
  getWorkspaceTrust,
  type LinkedRepoTrustEntry,
  type LinkedRepoTrustTarget,
  onWorkspaceConfigChanged,
  onWorkspaceTrustChanged,
  setWorkspaceTrust,
  type TrustDecision,
} from "../tauri/api";

/** Reduced state the renderer cares about:
 *   - "loading": initial fetch hasn't returned for this plansRoot.
 *   - "ask": no decision recorded; the prompt should show.
 *   - "trusted" / "untrusted": persisted answer.
 *
 *  "ask" is distinct from "untrusted" — the latter is a remembered
 *  "no" and stays sticky across sessions. */
export type TrustStatus = "loading" | "ask" | "trusted" | "untrusted";

interface TrustContextValue {
  status: TrustStatus;
  rootDecision: TrustDecision | null;
  linkedRepos: LinkedRepoTrustEntry[];
  pendingLinkedRepos: LinkedRepoTrustTarget[];
  /** `true` once the very first fetch (or auto-apply) for the current
   *  plansRoot resolves. Components that gate their first paint on a
   *  trust answer (Reader) wait for this. */
  resolved: boolean;
  /** Persist a new decision (or clear it by passing `null`). */
  set: (
    next: TrustDecision | null,
    options?: {
      applyRoot?: boolean;
      applyPendingLinkedRepos?: boolean;
    },
  ) => Promise<void>;
}

const TrustContext = createContext<TrustContextValue | null>(null);

interface ProviderProps {
  /** Active plans-root for this window. `null` while no folder is
   *  open — the provider parks in a non-loading state and won't
   *  prompt or persist anything. */
  plansRoot: string | null;
  /** Global default policy. When set to alwaysTrust / alwaysUntrust,
   *  a never-seen root gets that decision applied silently the first
   *  time we observe `decision === null`, skipping the prompt. */
  defaultPolicy: DefaultTrustPolicy;
  /** Changes when the workspace config's linked repo handles change.
   *  The provider also listens for Rust events, but this gives the
   *  trust state a pull-based refresh path when the app already knows
   *  the config snapshot changed. */
  workspaceConfigKey?: string;
  children: ReactNode;
}

export function WorkspaceTrustProvider({
  plansRoot,
  defaultPolicy,
  workspaceConfigKey = "",
  children,
}: ProviderProps) {
  const [decision, setDecision] = useState<TrustDecision | null>(null);
  const [linkedRepos, setLinkedRepos] = useState<LinkedRepoTrustEntry[]>([]);
  const [pendingLinkedRepos, setPendingLinkedRepos] = useState<
    LinkedRepoTrustTarget[]
  >([]);
  const [resolved, setResolved] = useState(false);
  // Cross-effect coordination so a stale fetch can't overwrite a fresh
  // plansRoot's state — every effect captures the request id active
  // when it ran and bails if it's been superseded.
  const requestIdRef = useRef(0);
  const lastWorkspaceRefreshRef = useRef({ plansRoot, workspaceConfigKey });

  // Reset on plansRoot change so the gate (Reader on `resolved`) waits
  // for the new root's decision before rendering remote content.
  useEffect(() => {
    requestIdRef.current += 1;
    setResolved(false);
    setDecision(null);
    setLinkedRepos([]);
    setPendingLinkedRepos([]);
    if (!plansRoot) {
      // No workspace yet — nothing to gate. Treat as resolved so the
      // empty-state UI isn't blocked behind a never-resolving fetch.
      setResolved(true);
      return;
    }
    const myId = requestIdRef.current;
    getWorkspaceTrust()
      .then((state) => {
        if (requestIdRef.current !== myId) return;
        setDecision(state.decision);
        setLinkedRepos(state.linkedRepos ?? []);
        setPendingLinkedRepos(state.pendingLinkedRepos ?? []);
        setResolved(true);
      })
      .catch((e) => {
        console.error("getWorkspaceTrust failed:", e);
        if (requestIdRef.current !== myId) return;
        // Fail closed — treat as no-decision so the prompt can recover.
        setDecision(null);
        setLinkedRepos([]);
        setPendingLinkedRepos([]);
        setResolved(true);
      });
  }, [plansRoot]);

  useEffect(() => {
    const previous = lastWorkspaceRefreshRef.current;
    lastWorkspaceRefreshRef.current = { plansRoot, workspaceConfigKey };
    if (!plansRoot) return;
    if (previous.plansRoot !== plansRoot) return;
    if (previous.workspaceConfigKey === workspaceConfigKey) return;

    const myId = ++requestIdRef.current;
    getWorkspaceTrust()
      .then((state) => {
        if (requestIdRef.current !== myId) return;
        setDecision(state.decision);
        setLinkedRepos(state.linkedRepos ?? []);
        setPendingLinkedRepos(state.pendingLinkedRepos ?? []);
        setResolved(true);
      })
      .catch((e) => {
        console.error("workspace config trust refresh failed:", e);
      });
  }, [plansRoot, workspaceConfigKey]);

  // Push-driven updates from the Rust side (set_workspace_trust emits
  // back to the same window). Lets a flip from the title-bar shield or
  // the placeholder context menu propagate to the renderer without a
  // refetch.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onWorkspaceTrustChanged((state) => {
      setDecision(state.decision);
      setLinkedRepos(state.linkedRepos ?? []);
      setPendingLinkedRepos(state.pendingLinkedRepos ?? []);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!plansRoot) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onWorkspaceConfigChanged(() => {
      const myId = ++requestIdRef.current;
      getWorkspaceTrust()
        .then((state) => {
          if (cancelled || requestIdRef.current !== myId) return;
          setDecision(state.decision);
          setLinkedRepos(state.linkedRepos ?? []);
          setPendingLinkedRepos(state.pendingLinkedRepos ?? []);
          setResolved(true);
        })
        .catch((e) => {
          console.error("workspace config trust refresh failed:", e);
        });
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [plansRoot]);

  // Auto-apply the global default policy when this is a brand-new root
  // (no decision recorded) and the user has opted out of the prompt.
  // Skipped for `alwaysAsk` so the modal can run.
  useEffect(() => {
    if (!plansRoot) return;
    if (!resolved) return;
    const applyRoot = decision === null;
    const applyPendingLinkedRepos = pendingLinkedRepos.length > 0;
    if (!applyRoot && !applyPendingLinkedRepos) return;
    if (defaultPolicy === "alwaysAsk") return;
    const next: TrustDecision =
      defaultPolicy === "alwaysTrust" ? "trusted" : "untrusted";
    setWorkspaceTrust(next, { applyRoot, applyPendingLinkedRepos }).catch((e) =>
      console.error("auto-apply trust policy failed:", e),
    );
    // Optimistic local update; the trust-changed event would also do
    // it, but applying immediately removes a beat of "ask" flicker.
    if (applyRoot) setDecision(next);
    if (applyPendingLinkedRepos) {
      setLinkedRepos((repos) =>
        repos.map((repo) => ({ ...repo, decision: next })),
      );
      setPendingLinkedRepos([]);
    }
  }, [plansRoot, resolved, decision, pendingLinkedRepos, defaultPolicy]);

  const set = useCallback(
    async (
      next: TrustDecision | null,
      options: {
        applyRoot?: boolean;
        applyPendingLinkedRepos?: boolean;
      } = {},
    ) => {
      const applyRoot = options.applyRoot ?? true;
      const applyPendingLinkedRepos = options.applyPendingLinkedRepos ?? false;
      // Optimistic — flip locally so the renderer reacts on the next
      // frame, then persist. The trust-changed event roundtrips back but
      // the effect only sees a no-op since we already applied it.
      if (applyRoot) setDecision(next);
      if (applyPendingLinkedRepos) {
        setLinkedRepos((repos) =>
          repos.map((repo) => ({ ...repo, decision: next })),
        );
        if (next !== null) {
          setPendingLinkedRepos([]);
        } else {
          setPendingLinkedRepos(
            linkedRepos.map(({ handle, path, configuredPath }) => ({
              handle,
              path,
              configuredPath,
            })),
          );
        }
      }
      try {
        await setWorkspaceTrust(next, {
          applyRoot,
          applyPendingLinkedRepos,
        });
      } catch (e) {
        console.error("setWorkspaceTrust failed:", e);
        // Recover from canonical state on failure.
        try {
          const fresh = await getWorkspaceTrust();
          setDecision(fresh.decision);
          setLinkedRepos(fresh.linkedRepos ?? []);
          setPendingLinkedRepos(fresh.pendingLinkedRepos ?? []);
        } catch {
          /* ignore secondary failure */
        }
      }
    },
    [linkedRepos],
  );

  const status: TrustStatus = useMemo(() => {
    if (!resolved) return "loading";
    if (pendingLinkedRepos.length > 0) return "ask";
    if (decision === "trusted") return "trusted";
    if (decision === "untrusted") return "untrusted";
    return "ask";
  }, [resolved, decision, pendingLinkedRepos]);

  const value = useMemo(
    () => ({
      status,
      rootDecision: decision,
      linkedRepos,
      pendingLinkedRepos,
      resolved,
      set,
    }),
    [status, decision, linkedRepos, pendingLinkedRepos, resolved, set],
  );

  return (
    <TrustContext.Provider value={value}>{children}</TrustContext.Provider>
  );
}

export function useWorkspaceTrust(): TrustContextValue {
  const ctx = useContext(TrustContext);
  if (!ctx) {
    throw new Error(
      "useWorkspaceTrust must be used inside <WorkspaceTrustProvider>",
    );
  }
  return ctx;
}

/** Convenience: are remote images / external network fetches allowed
 *  in the current state? "loading" and "ask" are treated as untrusted
 *  so we never leak network traffic before the user has decided. */
export function remoteAllowed(status: TrustStatus): boolean {
  return status === "trusted";
}
