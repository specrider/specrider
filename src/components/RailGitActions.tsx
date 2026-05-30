// Pull / Push / Fetch button cluster for the Commits rail toolbar.
// Lives where the actions belong — directly above the commit list,
// where the user is already looking at "what's local vs remote".
//
// The status-bar git cluster is now display-only (branch + ahead /
// behind / dirty as passive state); these are the actionable
// counterparts. Same backend calls, same toast surface.

import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useGitStatusContext } from "../hooks/gitStatusContext";
import { useToasts } from "../hooks/useToasts";
import type { ResolvedSettings } from "../settings/types";
import {
  type GitStatus,
  getGitStatus,
  gitFetch,
  gitPull,
  gitPush,
  type PulledCommit,
  parseGitError,
} from "../tauri/api";
import { PullSummaryPopover } from "./PullSummaryPopover";

const directPushBranches = new Set(["main", "master", "trunk"]);

function isDirectPushBranch(status: GitStatus | null): status is GitStatus {
  return !!status && !status.detached && directPushBranches.has(status.branch);
}

interface Props {
  settings: ResolvedSettings;
  repoHandle?: string | null;
  reviewBranch?: string | null;
  statusRefreshKey?: string | null;
  readOnly?: boolean;
  /** Re-run the local commit-graph fetch. Wired to the Fetch button
   *  alongside the network fetch — local re-render + remote refresh
   *  are the same gesture from the user's perspective ("show me
   *  what's new"). */
  onRefresh: () => void;
}

export function RailGitActions({
  settings,
  repoHandle = null,
  reviewBranch = null,
  statusRefreshKey = null,
  readOnly = false,
  onRefresh,
}: Props) {
  const { status: docsStatus, refresh: refreshDocsStatus } =
    useGitStatusContext();
  const { push: pushToast } = useToasts();
  const [linkedStatus, setLinkedStatus] = useState<GitStatus | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [pullSummary, setPullSummary] = useState<{
    commits: PulledCommit[];
    upToDate: boolean;
  } | null>(null);

  const refreshLinkedStatus = useCallback(() => {
    if (!readOnly || !repoHandle) {
      setLinkedStatus(null);
      return;
    }
    void getGitStatus(repoHandle)
      .then(setLinkedStatus)
      .catch(() => setLinkedStatus(null));
  }, [readOnly, repoHandle]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: statusRefreshKey intentionally retriggers linked repo status after ref changes.
  useEffect(() => {
    refreshLinkedStatus();
  }, [refreshLinkedStatus, statusRefreshKey]);

  const status = readOnly ? linkedStatus : docsStatus;
  const refreshStatus = useCallback(() => {
    if (readOnly) {
      refreshLinkedStatus();
      return;
    }
    refreshDocsStatus();
  }, [readOnly, refreshDocsStatus, refreshLinkedStatus]);
  const expectedBranch = readOnly ? reviewBranch : null;
  const linkedBranchCheckedOut =
    readOnly &&
    !!reviewBranch &&
    !!status?.inRepo &&
    !status.detached &&
    status.branch === reviewBranch;
  const showWriteActions = !readOnly || linkedBranchCheckedOut;
  const writesDisabled =
    !!status && (status.conflicts.length > 0 || status.inProgress !== "none");

  const onPull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    try {
      const summary = await gitPull(
        settings.gitPullStrategy,
        readOnly ? repoHandle : null,
        expectedBranch,
      );
      setPullSummary(summary);
      refreshStatus();
      onRefresh();
    } catch (err) {
      const e = parseGitError(err);
      if (e.code === "non-ff") {
        pushToast("Pull blocked: your branch and upstream have diverged.", {
          tone: "warn",
        });
      } else if (e.code === "no-upstream") {
        pushToast("No upstream configured for this branch.", { tone: "warn" });
      } else if (e.code === "conflict") {
        pushToast("Pull stopped: merge conflicts to resolve.", {
          tone: "error",
        });
      } else if (e.code === "auth") {
        pushToast(
          "Git couldn't authenticate. Add your SSH key to ssh-agent (`ssh-add`), or pull from the agent terminal so it can prompt.",
          { tone: "error", durationMs: 8000 },
        );
      } else if (e.code === "branch-mismatch") {
        pushToast(`Pull blocked: ${e.message}`, { tone: "warn" });
      } else {
        pushToast(`Pull failed: ${e.message}`, { tone: "error" });
      }
    } finally {
      setPulling(false);
    }
  }, [
    pulling,
    settings.gitPullStrategy,
    readOnly,
    repoHandle,
    expectedBranch,
    refreshStatus,
    onRefresh,
    pushToast,
  ]);

  const onPush = useCallback(async () => {
    if (pushing) return;
    const branchName = status && !status.detached ? status.branch : null;
    setPushing(true);
    try {
      if (
        settings.gitAllowDirectPushToMain &&
        settings.gitConfirmDirectPushToMain &&
        isDirectPushBranch(status)
      ) {
        const confirmed = await ask(`Push directly to ${status.branch}?`, {
          title: `Push to ${status.branch}`,
          kind: "warning",
          okLabel: "Push",
          cancelLabel: "Cancel",
        });
        if (!confirmed) return;
      }

      await gitPush(
        settings.gitAllowDirectPushToMain,
        readOnly ? repoHandle : null,
        expectedBranch,
      );
      refreshStatus();
      onRefresh();
      pushToast(
        branchName ? `Pushed upstream to ${branchName}.` : "Pushed upstream.",
        { tone: "success" },
      );
    } catch (err) {
      const e = parseGitError(err);
      if (e.code === "main-protected") {
        pushToast(e.message, { tone: "warn" });
      } else if (e.code === "non-ff") {
        pushToast("Push rejected — pull first to integrate remote work.", {
          tone: "warn",
          action: { label: "Pull", run: () => void onPull() },
        });
      } else if (e.code === "no-upstream") {
        pushToast(
          "No upstream set. Run `git push -u origin <branch>` from terminal.",
          { tone: "warn" },
        );
      } else if (e.code === "auth") {
        pushToast(
          "Git couldn't authenticate. Add your SSH key to ssh-agent (`ssh-add`), or push from the agent terminal so it can prompt.",
          { tone: "error", durationMs: 8000 },
        );
      } else if (e.code === "branch-mismatch") {
        pushToast(`Push blocked: ${e.message}`, { tone: "warn" });
      } else {
        pushToast(`Push failed: ${e.message}`, { tone: "error" });
      }
    } finally {
      setPushing(false);
    }
  }, [
    pushing,
    settings.gitAllowDirectPushToMain,
    settings.gitConfirmDirectPushToMain,
    status,
    readOnly,
    repoHandle,
    expectedBranch,
    refreshStatus,
    onRefresh,
    pushToast,
    onPull,
  ]);

  const onFetch = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const ok = await gitFetch(repoHandle, true);
      if (ok) {
        refreshStatus();
        onRefresh();
        pushToast(
          readOnly ? "Fetched linked repo refs." : "Fetched from remote.",
          {
            tone: "success",
          },
        );
      } else {
        pushToast(
          "Fetch failed — check network or auth. Try from the agent terminal.",
          { tone: "warn" },
        );
      }
    } catch (err) {
      const e = parseGitError(err);
      if (e.code === "auth") {
        pushToast(
          "Fetch couldn't authenticate. Add your SSH key to ssh-agent (`ssh-add`), or fetch from the agent terminal.",
          { tone: "error", durationMs: 8000 },
        );
      } else {
        pushToast(`Fetch failed: ${e.message}`, { tone: "error" });
      }
    } finally {
      setFetching(false);
    }
  }, [fetching, repoHandle, refreshStatus, onRefresh, pushToast, readOnly]);

  if (readOnly && !showWriteActions) {
    const fetchTitle =
      reviewBranch && status?.inRepo && !status.detached
        ? `Pull / Push become available when ${reviewBranch} is checked out in this linked repo folder. Currently on ${status.branch}.`
        : "Fetch linked repo refs";
    return (
      <div
        className="ch-actions ch-actions-linked"
        role="toolbar"
        aria-label="Linked repo actions"
      >
        <button
          type="button"
          className="ch-action ch-action-fetch"
          onClick={onFetch}
          disabled={fetching}
          title={fetchTitle}
          aria-label="Fetch linked repo"
        >
          <span className="ch-action-glyph">{fetching ? "…" : "↻"}</span>
          <span className="ch-action-label">Fetch</span>
        </button>
      </div>
    );
  }

  if (!status?.inRepo) return null;

  const ahead = status.ahead;
  const behind = status.behind;

  return (
    <>
      <div
        className="ch-actions"
        role="toolbar"
        aria-label={readOnly ? "Linked repo remote actions" : "Remote actions"}
      >
        <button
          type="button"
          className="ch-action ch-action-pull"
          onClick={onPull}
          disabled={pulling || writesDisabled || behind === 0}
          title={
            behind === 0
              ? "Nothing to pull"
              : `Pull ${behind} incoming commit${behind === 1 ? "" : "s"}`
          }
          aria-label="Pull"
        >
          <span className="ch-action-glyph">
            {pulling ? "…" : "↓"}
            {behind > 0 && <span className="ch-action-badge">{behind}</span>}
          </span>
          <span className="ch-action-label">Pull</span>
        </button>
        <button
          type="button"
          className="ch-action ch-action-push"
          onClick={onPush}
          disabled={pushing || writesDisabled || ahead === 0}
          title={
            ahead === 0
              ? "Nothing to push"
              : `Push ${ahead} local commit${ahead === 1 ? "" : "s"}`
          }
          aria-label="Push"
        >
          <span className="ch-action-glyph">
            {pushing ? "…" : "↑"}
            {ahead > 0 && <span className="ch-action-badge">{ahead}</span>}
          </span>
          <span className="ch-action-label">Push</span>
        </button>
        <button
          type="button"
          className="ch-action ch-action-fetch"
          onClick={onFetch}
          disabled={fetching}
          title="Fetch from remote (read-only)"
          aria-label="Fetch"
        >
          <span className="ch-action-glyph">{fetching ? "…" : "↻"}</span>
          <span className="ch-action-label">Fetch</span>
        </button>
      </div>
      {pullSummary && (
        <PullSummaryPopover
          summary={pullSummary}
          onClose={() => setPullSummary(null)}
        />
      )}
    </>
  );
}
