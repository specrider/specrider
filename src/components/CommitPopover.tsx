import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { useDraggable } from "../hooks/useDraggable";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { formatRelativeTime } from "../lib/time";
import { type CommitMeta, commitMeta } from "../tauri/api";

interface Props {
  sha: string;
  onClose: () => void;
  /** Optional anchor — when present the popover floats fixed near the
   *  click. Otherwise it centers on screen. */
  anchor?: { left: number; top: number } | null;
}

export function CommitPopover({ sha, onClose, anchor }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [meta, setMeta] = useState<CommitMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    commitMeta(sha)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sha]);

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

  const { pos, handleRef } = useDraggable(anchor ?? null, {
    size: { width: 460, height: 320 },
  });

  useFocusTrap(ref);

  const onCopySha = async () => {
    try {
      await navigator.clipboard.writeText(meta?.sha || sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error("clipboard write failed:", e);
    }
  };

  const onOpenGithub = () => {
    if (!meta?.githubUrl) return;
    openUrl(meta.githubUrl).catch((e) => console.error("openUrl:", e));
  };

  return (
    <div
      className="commit-popover"
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="commit-popover-title"
    >
      <div className="commit-popover-head" ref={handleRef}>
        <span className="commit-popover-sha" id="commit-popover-title">
          {meta?.sha || sha}
        </span>
        <button
          type="button"
          className="commit-popover-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="commit-popover-body">
        {error && <div className="commit-popover-error">{error}</div>}
        {!meta && !error && (
          <div className="commit-popover-loading">Loading…</div>
        )}
        {meta && (
          <>
            <div className="commit-popover-subject">{meta.subject}</div>
            <div className="commit-popover-byline">
              {meta.author} · {formatRelativeTime(meta.authorTime)}
            </div>
            {meta.body && (
              <pre className="commit-popover-bodytext">{meta.body}</pre>
            )}
            {meta.files.length > 0 && (
              <div className="commit-popover-files">
                <div className="commit-popover-section-title">
                  {meta.files.length}{" "}
                  {meta.files.length === 1 ? "file" : "files"}
                </div>
                <ul>
                  {meta.files.slice(0, 12).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                  {meta.files.length > 12 && (
                    <li className="commit-popover-files-more">
                      +{meta.files.length - 12} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      <div className="commit-popover-actions">
        <button type="button" onClick={onCopySha}>
          {copied ? "Copied" : "Copy SHA"}
        </button>
        {meta?.githubUrl && (
          <button type="button" onClick={onOpenGithub}>
            Open on GitHub
          </button>
        )}
      </div>
    </div>
  );
}
