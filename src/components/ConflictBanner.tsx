// Persistent merge-conflict banner, pinned to the top of the reader
// pane whenever git_status reports `UU` / `AA` / `DD` paths. Lists the
// conflicted files and offers an `[Ask agent to resolve]` shortcut
// that injects a prompt into the active terminal session.

import { useState } from "react";
import { useToasts } from "../hooks/useToasts";
import {
  type ConflictedFile,
  type GitStatus,
  gitAbortMerge,
  listTerminalSessions,
  parseGitError,
  terminalWrite,
} from "../tauri/api";

interface Props {
  status: GitStatus;
  onChanged: () => void;
  onOpenPlan?: (rel: string) => void;
}

function sanitizePromptField(text: string): string {
  return Array.from(text)
    .map((c) => {
      if (c === "\n" || c === "\r" || c === "\t") return " ";
      const code = c.charCodeAt(0);
      return code < 32 || code === 127 ? "" : c;
    })
    .join("")
    .trim();
}

function buildConflictPrompt(conflicts: ConflictedFile[]): string {
  const paths = conflicts
    .map((c) => sanitizePromptField(c.relToPlans ?? c.path))
    .filter(Boolean)
    .join(", ");

  const target = paths || "the conflicted files";
  return `Resolve the merge conflicts in ${target}. They are in the plans-root. After resolving, run \`git add\` on each file but don't commit yet — I'll review and commit from SpecRider.`;
}

export function ConflictBanner({ status, onChanged, onOpenPlan }: Props) {
  const [busy, setBusy] = useState(false);
  const { push: pushToast } = useToasts();

  if (status.conflicts.length === 0 && status.inProgress === "none") {
    return null;
  }

  const onAbort = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await gitAbortMerge();
      onChanged();
      pushToast(`Aborted ${status.inProgress}.`, { tone: "info" });
    } catch (err) {
      const e = parseGitError(err);
      pushToast(`Abort failed: ${e.message}`, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const onAskAgent = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const sessions = await listTerminalSessions();
      // Match the agent-terminal plan's convention: scope to current window.
      const session = sessions[0];
      if (!session) {
        pushToast("No agent session open. Open the terminal pane first.", {
          tone: "warn",
        });
        return;
      }
      await terminalWrite(session.id, buildConflictPrompt(status.conflicts));
      pushToast("Sent conflict prompt to the agent.", { tone: "info" });
    } catch (err) {
      pushToast(`Could not reach agent: ${String(err)}`, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (status.conflicts.length === 0) {
    return null;
  }

  return (
    <div className="conflict-banner" role="alert">
      <div className="conflict-banner-head">
        <strong>
          ⚠ Merge conflict in {status.conflicts.length} file
          {status.conflicts.length === 1 ? "" : "s"}.
        </strong>{" "}
        Resolve before continuing.
      </div>
      <ul className="conflict-banner-list">
        {status.conflicts.map((c: ConflictedFile) => (
          <li key={c.path}>
            <button
              type="button"
              onClick={() => c.relToPlans && onOpenPlan?.(c.relToPlans)}
              disabled={!c.relToPlans || !onOpenPlan}
              title={c.path}
            >
              {c.relToPlans ?? c.path}
            </button>
          </li>
        ))}
      </ul>
      <div className="conflict-banner-actions">
        <button type="button" onClick={() => void onAskAgent()} disabled={busy}>
          Ask agent to resolve
        </button>
        <button
          type="button"
          onClick={() => void onAbort()}
          disabled={busy}
          className="conflict-banner-abort"
        >
          Abort {status.inProgress === "none" ? "merge" : status.inProgress}
        </button>
      </div>
    </div>
  );
}
