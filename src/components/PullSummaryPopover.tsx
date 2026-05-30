// "Pulled N commits from origin/<branch>" panel — surfaced after
// every successful pull. The teaching-positive moment of the whole
// flow: we name the author, the subject, and the SHA so the user
// can see what just landed.

import { useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { formatRelativeTime } from "../lib/time";
import type { PulledCommit } from "../tauri/api";

interface Props {
  summary: { commits: PulledCommit[]; upToDate: boolean };
  onClose: () => void;
}

export function PullSummaryPopover({ summary, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  return (
    <div
      className="pull-summary-popover"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pull-summary-title"
    >
      <div className="pull-summary-head">
        <strong id="pull-summary-title">
          {summary.upToDate
            ? "Already up to date"
            : `Pulled ${summary.commits.length} commit${
                summary.commits.length === 1 ? "" : "s"
              }`}
        </strong>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {!summary.upToDate && (
        <ul className="pull-summary-list">
          {summary.commits.map((c) => (
            <li key={c.sha}>
              <span className="pull-summary-sha">{c.shortSha}</span>
              <span className="pull-summary-subject">{c.subject}</span>
              <span className="pull-summary-meta">
                {c.author} · {formatRelativeTime(c.timeSecs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
