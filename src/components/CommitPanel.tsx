// Commit panel — embedded inside the Diff Explorer pane when the
// selected row is "Uncommitted changes". Replaces the standalone
// CommitDialog modal: now the diff pane is the single home for
// commit work — see the file list, see the diffs, type the message,
// commit. SourceTree-style staging via per-row checkboxes lives on
// the file list above.

import { useEffect, useRef, useState } from "react";
import { useToasts } from "../hooks/useToasts";
import { type FileChange, gitCommit, parseGitError } from "../tauri/api";

interface Props {
  files: FileChange[];
  selectedForCommit: ReadonlySet<string>;
  onCommitted: () => void;
}

export function CommitPanel({ files, selectedForCommit, onCommitted }: Props) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { push: pushToast } = useToasts();

  // Reset error when the user starts typing again.
  useEffect(() => {
    if (error && message) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, error]);

  const includedCount = Array.from(selectedForCommit).filter((p) =>
    files.some((f) => f.path === p),
  ).length;

  const onCommit = async () => {
    if (!message.trim() || includedCount === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const paths = files
        .map((f) => f.path)
        .filter((p) => selectedForCommit.has(p));
      const result = await gitCommit(message, paths);
      onCommitted();
      const firstLine = message.split("\n", 1)[0].slice(0, 60);
      pushToast(`Committed ${result.shortSha}: ${firstLine}`, {
        tone: "success",
      });
      setMessage("");
    } catch (err) {
      const e = parseGitError(err);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void onCommit();
    }
  };

  if (files.length === 0) {
    return (
      <div className="commit-panel empty">
        Working tree clean. Nothing to commit.
      </div>
    );
  }

  return (
    <div className="commit-panel">
      <textarea
        ref={taRef}
        className="commit-panel-message"
        placeholder="Commit message (⌘⏎ to commit)"
        aria-label="Commit message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={busy}
      />
      <div className="commit-panel-actions">
        <span className="commit-panel-meta">
          {includedCount} of {files.length} file
          {files.length === 1 ? "" : "s"} staged
        </span>
        {error && <span className="commit-panel-error">{error}</span>}
        <span className="commit-panel-spacer" />
        <button
          type="button"
          className="commit-panel-button"
          disabled={busy || !message.trim() || includedCount === 0}
          onClick={() => void onCommit()}
        >
          {busy ? "Committing…" : "Commit"}
        </button>
      </div>
    </div>
  );
}
