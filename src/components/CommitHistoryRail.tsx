// CommitHistoryRail - full-repo commit graph + plan-relevance overlay.
//
// onSelect fires with either { kind: "unstaged" } or
// { kind: "commit", sha }; the parent owns selection state.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGitStatusContext } from "../hooks/gitStatusContext";
import type { CommitDerived } from "../hooks/useCommitGraph";
import type { GraphLayout, LaneAssignment } from "../lib/commitGraphLanes";
import type { DiffReviewTab } from "../review/diffTabs";
import { LinkedRepoTrustCallout } from "../security/linkedRepoTrust";
import type { ResolvedSettings } from "../settings/types";
import {
  type GraphCommit,
  gitInit,
  type PlanRelevance,
  parseGitError,
  type RefEntry,
} from "../tauri/api";
import { CommitRow } from "./CommitRow";
import { Icon } from "./icons";
import { RailGitActions } from "./RailGitActions";

export type CommitSelection =
  | { kind: "unstaged" }
  | { kind: "commit"; sha: string };

interface Props {
  commits: GraphCommit[];
  layout: GraphLayout;
  derivedBySha: Map<string, CommitDerived>;
  relevanceBySha: Map<string, PlanRelevance>;
  refsByCommit: Map<string, RefEntry[]>;
  displayRefsByCommit: Map<string, RefEntry[]>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** True iff the working tree has uncommitted changes - drives whether
   *  the synthetic Unstaged row is rendered above the graph. */
  hasUnstaged: boolean;
  selected: CommitSelection | null;
  onSelect: (sel: CommitSelection) => void;
  onRefresh: () => void;
  readOnly?: boolean;
  repoHandle?: string | null;
  reviewBranch?: string | null;
  /** When false, the lane glyph column is dropped entirely so rows
   *  collapse to refs / subject / metadata only. Driven by the
   *  `showCommitGraph` user setting. */
  showLanes: boolean;
  /** Settings - passed through to the embedded RailGitActions
   *  (Pull / Push / Fetch button cluster). */
  settings: ResolvedSettings;
  tabs?: DiffReviewTab[];
  activeTabId?: string;
  onSelectTab?: (tabId: string) => void;
}

type GraphItem =
  | { kind: "divider"; key: string }
  | {
      kind: "commit";
      key: string;
      commit: GraphCommit;
      row: LaneAssignment;
      commitIndex: number;
    };

const COMMIT_ROW_PX = 24;
const UNPUSHED_DIVIDER_PX = 24;
const EMPTY_REFS: readonly RefEntry[] = [];
const EMPTY_DERIVED: CommitDerived = { rel: "", initials: "" };

function reviewTabLabel(tab: DiffReviewTab): string {
  if (tab.kind === "docs") return tab.label;
  return `${tab.repo}/${tab.branch}`;
}

function isSelected(sel: CommitSelection | null, sha: string): boolean {
  return sel?.kind === "commit" && sel.sha === sha;
}

export function CommitHistoryRail(props: Props) {
  const {
    commits,
    layout,
    derivedBySha,
    relevanceBySha,
    refsByCommit,
    displayRefsByCommit,
    loading,
    loaded,
    error,
    hasUnstaged,
    selected,
    onSelect,
    onRefresh,
    readOnly = false,
    repoHandle = null,
    reviewBranch = null,
    showLanes,
    settings,
    tabs = [],
    activeTabId = "",
    onSelectTab = () => {},
  } = props;
  const graphRef = useRef<HTMLDivElement | null>(null);
  const unstagedSelected = selected?.kind === "unstaged";
  const laneCount = Math.max(1, layout.laneCount);
  const { status: gitStatus, refresh: refreshGitStatus } =
    useGitStatusContext();
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const tabColumns = tabs.length === 4 ? 2 : Math.min(3, tabs.length);

  const onInitGit = useCallback(async () => {
    setInitBusy(true);
    setInitError(null);
    try {
      await gitInit();
      refreshGitStatus();
      onRefresh();
    } catch (err) {
      setInitError(parseGitError(err).message);
    } finally {
      setInitBusy(false);
    }
  }, [onRefresh, refreshGitStatus]);

  const statusRefreshKey = useMemo(() => {
    for (const [sha, refs] of refsByCommit.entries()) {
      if (refs.some((r) => r.isHead)) return sha;
    }
    return commits[0]?.sha ?? null;
  }, [commits, refsByCommit]);

  // Set of unpushed commit SHAs - every commit reachable from HEAD
  // that's not reachable from the upstream tracking ref. We walk the
  // first-parent chain from HEAD until the upstream sha.
  const unpushedShas = useMemo(() => {
    const out = new Set<string>();
    if (
      readOnly ||
      !gitStatus?.inRepo ||
      !gitStatus.upstream ||
      gitStatus.ahead === 0
    ) {
      return out;
    }

    let upstreamSha: string | null = null;
    for (const [sha, refs] of refsByCommit.entries()) {
      if (
        refs.some((r) => r.kind === "remote" && r.name === gitStatus.upstream)
      ) {
        upstreamSha = sha;
        break;
      }
    }

    let headSha: string | null = null;
    for (const [sha, refs] of refsByCommit.entries()) {
      if (refs.some((r) => r.isHead)) {
        headSha = sha;
        break;
      }
    }

    if (!headSha || !upstreamSha) return out;
    const bySha = new Map(commits.map((c) => [c.sha, c]));
    let cursor: string | undefined = headSha;
    let safety = 0;
    while (cursor && cursor !== upstreamSha && safety < commits.length + 1) {
      out.add(cursor);
      const node = bySha.get(cursor);
      if (!node) break;
      cursor = node.parents[0];
      safety++;
    }
    return out;
  }, [commits, refsByCommit, gitStatus, readOnly]);

  const firstUnpushedIdx = useMemo(
    () => commits.findIndex((c) => unpushedShas.has(c.sha)),
    [commits, unpushedShas],
  );

  const graphItems = useMemo<GraphItem[]>(() => {
    const items: GraphItem[] = [];
    for (let idx = 0; idx < commits.length; idx++) {
      if (idx === firstUnpushedIdx) {
        items.push({ kind: "divider", key: `unpushed:${idx}` });
      }
      const row = layout.rows[idx];
      if (!row) continue;
      const commit = commits[idx];
      items.push({
        kind: "commit",
        key: commit.sha,
        commit,
        row,
        commitIndex: idx,
      });
    }
    return items;
  }, [commits, firstUnpushedIdx, layout.rows]);

  const rowVirtualizer = useVirtualizer({
    count: graphItems.length,
    getScrollElement: () => graphRef.current,
    estimateSize: (index) =>
      graphItems[index]?.kind === "divider"
        ? UNPUSHED_DIVIDER_PX
        : COMMIT_ROW_PX,
    getItemKey: (index) => graphItems[index]?.key ?? index,
    overscan: 8,
  });

  const showVirtualGraph = graphItems.length > 0 && !error;

  // Roving tabindex over commit rows. Single tab stop in the rail
  // (the active commit row); arrow keys move it. Skips dividers.
  const [activeShaIdx, setActiveShaIdx] = useState<number>(0);
  useEffect(() => {
    if (commits.length === 0) {
      setActiveShaIdx(0);
      return;
    }
    if (activeShaIdx >= commits.length) {
      setActiveShaIdx(commits.length - 1);
    }
  }, [commits.length, activeShaIdx]);

  const onCommitFocus = useCallback((idx: number) => {
    setActiveShaIdx(idx);
  }, []);

  const onGraphKeyDown = (e: React.KeyboardEvent) => {
    if (commits.length === 0) return;
    let nextIdx: number | null = null;
    if (e.key === "ArrowDown")
      nextIdx = Math.min(commits.length - 1, activeShaIdx + 1);
    else if (e.key === "ArrowUp") nextIdx = Math.max(0, activeShaIdx - 1);
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = commits.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const sha = commits[activeShaIdx]?.sha;
      if (sha) onSelect({ kind: "commit", sha });
      return;
    }
    if (nextIdx === null) return;
    e.preventDefault();
    setActiveShaIdx(nextIdx);
    // Scroll into view via the virtualizer; the focus useEffect below
    // moves DOM focus once the row is mounted.
    const itemIdx = graphItems.findIndex(
      (it) => it.kind === "commit" && it.commitIndex === nextIdx,
    );
    if (itemIdx >= 0) rowVirtualizer.scrollToIndex(itemIdx);
  };

  // Move DOM focus to the active commit row when activeShaIdx changes
  // — but only if the rail already contains focus, so we don't yank
  // focus from another pane just because the keyboard cursor moved.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph?.contains(document.activeElement)) return;
    const sha = commits[activeShaIdx]?.sha;
    if (!sha) return;
    // The virtualizer may not have rendered the row yet — schedule a
    // microtask retry, then give up if the row never mounts.
    let attempts = 0;
    const tryFocus = () => {
      const row = graph.querySelector<HTMLElement>(`[data-sha="${sha}"]`);
      if (row) {
        row.focus();
        return;
      }
      if (attempts++ < 5) requestAnimationFrame(tryFocus);
    };
    tryFocus();
  }, [activeShaIdx, commits]);

  return (
    <div className="commit-history-rail">
      <RailGitActions
        settings={settings}
        repoHandle={repoHandle}
        reviewBranch={reviewBranch}
        statusRefreshKey={statusRefreshKey}
        readOnly={readOnly}
        onRefresh={onRefresh}
      />

      {tabs.length > 1 && (
        <div
          className={`outline-filters commit-review-tabs commit-review-tabs-${tabColumns}`}
          role="tablist"
          aria-label="Review repository"
        >
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              role="tab"
              aria-selected={activeTabId === tab.id}
              tabIndex={activeTabId === tab.id ? 0 : -1}
              className={`of-chip ${activeTabId === tab.id ? "on" : ""}`}
              onClick={() => onSelectTab(tab.id)}
              title={reviewTabLabel(tab)}
            >
              <span className="commit-review-tab-label">
                {reviewTabLabel(tab)}
              </span>
            </button>
          ))}
        </div>
      )}

      {hasUnstaged ? (
        <button
          type="button"
          className={`ch-row ch-row-unstaged ${
            unstagedSelected ? "selected" : ""
          }`}
          onClick={() => onSelect({ kind: "unstaged" })}
          aria-current={unstagedSelected || undefined}
        >
          <span className="ch-badge ch-badge-unstaged">●</span>
          <span className="ch-subject">Uncommitted changes</span>
          <span className="ch-meta">working tree</span>
        </button>
      ) : (
        commits.length > 0 &&
        !error && <div className="ch-clean">No uncommitted changes</div>
      )}

      {(hasUnstaged || (commits.length > 0 && !error)) && (
        <div className="ch-graph-divider" aria-hidden="true" />
      )}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: graph keyboard navigation delegates to the focused virtual row. */}
      <div className="ch-graph" ref={graphRef} onKeyDown={onGraphKeyDown}>
        {loading && commits.length === 0 && (
          <div className="ch-empty">Loading...</div>
        )}

        {loaded &&
          !loading &&
          !error &&
          commits.length === 0 &&
          !hasUnstaged && (
            <div
              className={`ch-empty ${
                gitStatus?.inRepo === false ? "ch-empty-setup" : ""
              }`}
            >
              <div className="ch-empty-title">
                {gitStatus?.inRepo === false
                  ? "No Git repository yet"
                  : "No commits yet."}
              </div>
              {gitStatus?.inRepo === false ? (
                <>
                  <div className="ch-empty-copy">
                    Create a repo in this folder to start tracking changes.
                  </div>
                  <button
                    type="button"
                    className="ch-empty-action"
                    aria-label="Initialize Git repository"
                    onClick={onInitGit}
                    disabled={initBusy}
                  >
                    <Icon.Branch />
                    {initBusy ? "Initializing..." : "Initialize repo"}
                  </button>
                  {initError && (
                    <div className="ch-empty-hint ch-empty-error" role="alert">
                      {initError}
                    </div>
                  )}
                </>
              ) : (
                <div className="ch-empty-hint">
                  Add tracked branches under <code>branches:</code> in this
                  plan's frontmatter to highlight their commits in the graph.
                </div>
              )}
            </div>
          )}

        {error && (
          <div className="ch-empty ch-error" role="alert">
            <LinkedRepoTrustCallout error={error} onTrusted={onRefresh} />
          </div>
        )}

        {showVirtualGraph && (
          <div
            className="ch-graph-spacer"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualItem) => {
              const item = graphItems[virtualItem.index];
              if (!item) return null;
              return (
                <div
                  key={virtualItem.key}
                  className="ch-virtual-row"
                  style={{
                    height: virtualItem.size,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {item.kind === "divider" ? (
                    <div
                      className="ch-unpushed-divider"
                      title={`${unpushedShas.size} unpushed commits`}
                    >
                      <span>
                        ↑ Unpushed · {unpushedShas.size} commit
                        {unpushedShas.size === 1 ? "" : "s"}
                      </span>
                    </div>
                  ) : (
                    <CommitRow
                      commit={item.commit}
                      row={item.row}
                      refs={
                        displayRefsByCommit.get(item.commit.sha) ?? EMPTY_REFS
                      }
                      relevance={relevanceBySha.get(item.commit.sha) ?? null}
                      derived={
                        derivedBySha.get(item.commit.sha) ?? EMPTY_DERIVED
                      }
                      isSelected={isSelected(selected, item.commit.sha)}
                      isUnpushed={unpushedShas.has(item.commit.sha)}
                      onSelect={onSelect}
                      showLanes={showLanes}
                      laneCount={laneCount}
                      ariaPosInSet={item.commitIndex + 1}
                      ariaSetSize={commits.length}
                      tabIndex={item.commitIndex === activeShaIdx ? 0 : -1}
                      onFocus={() => onCommitFocus(item.commitIndex)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
