// Status-bar git cluster — display-only "you are here".
//
// Branch chip, ahead/behind/dirty as passive indicators, plus the
// detached-HEAD and "no upstream" warning states. Action buttons
// (Pull, Push, Fetch, Commit) live in the Commits rail toolbar
// where they belong, since that's where the user is already
// looking at "what's local vs remote".
//
// The branch chip stays interactive — it opens BranchPicker — and
// the dirty dot stays clickable as a shortcut to the diff pane's
// Uncommitted row. Everything else is read-only.

import { useRef, useState } from "react";
import { useGitStatusContext } from "../hooks/gitStatusContext";
import type { ResolvedSettings } from "../settings/types";
import type { GitStatus } from "../tauri/api";
import { BranchPicker } from "./BranchPicker";
import { Icon } from "./icons";

interface Props {
  settings: ResolvedSettings;
  /** Open the diff explorer pane scrolled to the Uncommitted row.
   *  Commit work itself lives inside the diff pane (SourceTree-style
   *  staging and message field). */
  onOpenUncommitted: () => void;
}

function describeStatus(s: GitStatus): string {
  if (!s.inRepo) return "Not in a git repository";
  const parts: string[] = [];
  if (s.detached) {
    parts.push(`Detached HEAD${s.shortSha ? ` @ ${s.shortSha}` : ""}`);
  } else {
    parts.push(`On branch ${s.branch}`);
  }
  if (s.upstream) {
    if (s.ahead === 0 && s.behind === 0) {
      parts.push(`up-to-date with ${s.upstream}`);
    } else {
      const bits: string[] = [];
      if (s.ahead > 0) bits.push(`${s.ahead} ahead`);
      if (s.behind > 0) bits.push(`${s.behind} behind`);
      parts.push(`${bits.join(", ")} ${s.upstream}`);
    }
  } else if (!s.detached) {
    parts.push("no upstream configured");
  }
  if (s.dirty) {
    parts.push(
      `${s.changes.length} uncommitted change${s.changes.length === 1 ? "" : "s"}`,
    );
  } else {
    parts.push("working tree clean");
  }
  if (s.conflicts.length > 0) {
    parts.push(
      `${s.conflicts.length} merge conflict${s.conflicts.length === 1 ? "" : "s"}`,
    );
  }
  if (s.inProgress !== "none") {
    parts.push(`${s.inProgress} in progress`);
  }
  return parts.join(" · ");
}

export function GitCluster({ settings, onOpenUncommitted }: Props) {
  const { status, refresh } = useGitStatusContext();
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (!settings.gitShowStatusCluster) return null;
  if (!status) return null;
  if (!status.inRepo) return null;

  const tooltip = describeStatus(status);
  const hasConflicts = status.conflicts.length > 0;

  return (
    <>
      <span
        className={[
          "sb-git-cluster",
          status.detached && "detached",
          hasConflicts && "has-conflicts",
        ]
          .filter(Boolean)
          .join(" ")}
        title={tooltip}
      >
        <button
          type="button"
          ref={triggerRef}
          className="sb-item sb-branch sb-branch-button"
          onClick={() => setPickerOpen((o) => !o)}
          aria-label={`Branch ${status.branch}. Click to switch.`}
        >
          <Icon.Branch />
          <span className="sb-branch-name">
            {status.detached
              ? status.shortSha
                ? `HEAD @ ${status.shortSha}`
                : "HEAD"
              : status.branch}
          </span>
        </button>
        {status.detached && (
          <span
            className="sb-git-warn"
            title="Detached HEAD — checkout a branch to commit safely."
          >
            ⚠ detached
          </span>
        )}
        {hasConflicts && (
          <span
            className="sb-git-warn sb-git-conflict"
            title={`${status.conflicts.length} merge conflict${
              status.conflicts.length === 1 ? "" : "s"
            }. Resolve before continuing.`}
          >
            ⚠ {status.conflicts.length} conflict
            {status.conflicts.length === 1 ? "" : "s"}
          </span>
        )}
        {!status.upstream && !status.detached && (
          <span
            className="sb-git-warn"
            title="No upstream configured. Run `git push -u origin <branch>` to set one."
          >
            no upstream
          </span>
        )}
        {status.dirty && (
          <button
            type="button"
            className="sb-git-dirty"
            onClick={onOpenUncommitted}
            title={`${status.changes.length} uncommitted change${
              status.changes.length === 1 ? "" : "s"
            }. Click to review and commit.`}
            aria-label="Open uncommitted changes"
          >
            <span className="sb-git-dot" />
            {status.changes.length}
          </button>
        )}
        {status.behind > 0 && (
          <span
            className="sb-git-incoming"
            title={`${status.behind} incoming commit${
              status.behind === 1 ? "" : "s"
            } from ${status.upstream ?? "upstream"}. Pull from the Commits panel.`}
          >
            ↓{status.behind}
          </span>
        )}
        {status.ahead > 0 && (
          <span
            className="sb-git-outgoing"
            title={`${status.ahead} local commit${
              status.ahead === 1 ? "" : "s"
            } to push to ${status.upstream ?? "upstream"}. Push from the Commits panel.`}
          >
            ↑{status.ahead}
          </span>
        )}
      </span>
      {pickerOpen && (
        <BranchPicker
          status={status}
          settings={settings}
          onClose={() => setPickerOpen(false)}
          onChanged={refresh}
          triggerRef={triggerRef}
        />
      )}
    </>
  );
}
