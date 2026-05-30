// Branch picker popover. Lists local + remote branches, supports
// search + recent pinning + new-branch creation. Refuses to switch on
// a dirty tree (the Rust side enforces this; we surface the error
// inline).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useToasts } from "../hooks/useToasts";
import { formatRelativeTime } from "../lib/time";
import type { ResolvedSettings } from "../settings/types";
import {
  type BranchEntry,
  type GitStatus,
  getGitBranches,
  gitCheckout,
  gitCreateBranch,
  parseGitError,
} from "../tauri/api";

const RECENTS_KEY_PREFIX = "specrider.gitBranchRecents.v1.";

interface Props {
  status: GitStatus;
  settings: ResolvedSettings;
  onClose: () => void;
  onChanged: () => void;
  /** Trigger element to ignore in outside-click detection — otherwise
   *  clicking the trigger to toggle closed re-opens the picker on the
   *  trailing click handler. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

function loadRecents(repoKey: string): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY_PREFIX + repoKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s) => typeof s === "string").slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

function pushRecent(repoKey: string, branch: string) {
  try {
    const cur = loadRecents(repoKey);
    const next = [branch, ...cur.filter((b) => b !== branch)].slice(0, 5);
    localStorage.setItem(RECENTS_KEY_PREFIX + repoKey, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function BranchPicker({
  status,
  settings,
  onClose,
  onChanged,
  triggerRef,
}: Props) {
  const repoKey = `${status.branch}:${status.shortSha ?? ""}`;
  const [branches, setBranches] = useState<BranchEntry[] | null>(null);
  const [showRemote, setShowRemote] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(settings.gitBranchPrefix ?? "");
  const [base, setBase] = useState<string>(status.branch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const { push: pushToast } = useToasts();

  useFocusTrap(ref, { autoFocus: false });

  const refresh = useCallback(() => {
    void getGitBranches(showRemote)
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [showRemote]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      const target = e.target as Node;
      if (ref.current.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose, triggerRef]);

  const recents = useMemo(() => loadRecents(repoKey), [repoKey]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = (branches ?? []).filter(
      (b) => !q || b.name.toLowerCase().includes(q),
    );
    if (recents.length > 0) {
      const recentSet = new Set(recents);
      list = list.sort((a, b) => {
        const ar = recentSet.has(a.name) ? recents.indexOf(a.name) : 999;
        const br = recentSet.has(b.name) ? recents.indexOf(b.name) : 999;
        if (ar !== br) return ar - br;
        return b.lastCommitSecs - a.lastCommitSecs;
      });
    }
    return list;
  }, [branches, filter, recents]);

  const onSwitch = async (entry: BranchEntry) => {
    if (entry.isCurrent) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (entry.isRemote) {
        // Remote checkout strips remote/ prefix and tracks.
        const local = entry.name.split("/").slice(1).join("/") || entry.name;
        await gitCheckout(local, true);
        pushRecent(repoKey, local);
      } else {
        await gitCheckout(entry.name, false);
        pushRecent(repoKey, entry.name);
      }
      onChanged();
      onClose();
      pushToast(`Switched to ${entry.name}`, { tone: "success" });
    } catch (err) {
      const e = parseGitError(err);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Branch name required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await gitCreateBranch(trimmed, base || null);
      onChanged();
      onClose();
      pushRecent(repoKey, trimmed);
      pushToast(`Created branch ${trimmed}`, { tone: "success" });
    } catch (err) {
      const e = parseGitError(err);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const inProgress = status.inProgress !== "none";

  // Reset cursor when filtered list changes shape.
  useEffect(() => {
    setActiveIdx((cur) =>
      filtered.length === 0 ? 0 : Math.min(cur, filtered.length - 1),
    );
  }, [filtered.length]);

  // Keep the active row in view as the cursor moves through the list.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const picked = filtered[activeIdx];
      if (picked) void onSwitch(picked);
    }
  };

  return (
    <div
      className="branch-picker"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Switch branch"
    >
      <div className="branch-picker-head">
        <input
          type="text"
          className="branch-picker-search"
          placeholder="Find branch…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="Find branch"
        />
      </div>
      <div className="branch-picker-body">
        {error && <div className="branch-picker-error">{error}</div>}
        {inProgress && (
          <div className="branch-picker-warn">
            {status.inProgress} in progress — abort or finish before switching.
          </div>
        )}
        {branches === null ? (
          <div className="branch-picker-loading">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="branch-picker-empty">No branches match.</div>
        ) : (
          <>
            {(branches?.length ?? 0) >= 50 && (
              <div className="branch-picker-truncated">
                Showing 50 most-recent branches. Type to filter further.
              </div>
            )}
            <ul className="branch-picker-list" ref={listRef}>
              {filtered.map((b, idx) => (
                <li
                  key={(b.isRemote ? "r:" : "l:") + b.name}
                  data-idx={idx}
                  className={[
                    "branch-picker-item",
                    b.isCurrent && "current",
                    b.isRemote && "remote",
                    idx === activeIdx && "active",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    onClick={() => onSwitch(b)}
                    onMouseEnter={() => setActiveIdx(idx)}
                    disabled={busy || (b.isCurrent ? false : inProgress)}
                    title={b.lastCommitSubject}
                  >
                    <span className="branch-picker-name">{b.name}</span>
                    <span className="branch-picker-meta">
                      {formatRelativeTime(b.lastCommitSecs)}
                      {!b.isCurrent &&
                        (b.aheadMain > 0 || b.behindMain > 0) && (
                          <>
                            {" "}
                            · ↑{b.aheadMain} ↓{b.behindMain}
                          </>
                        )}
                      {b.isCurrent && " · current"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="branch-picker-footer">
        <label className="branch-picker-toggle">
          <input
            type="checkbox"
            checked={showRemote}
            onChange={(e) => setShowRemote(e.target.checked)}
          />
          Show remote branches
        </label>
        {!creating ? (
          <button
            type="button"
            className="branch-picker-new"
            onClick={() => setCreating(true)}
            disabled={inProgress}
          >
            + New branch
          </button>
        ) : (
          <form
            className="branch-picker-new-form"
            onSubmit={(e) => {
              e.preventDefault();
              void onCreate();
            }}
          >
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="branch-name"
              disabled={busy}
            />
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              disabled={busy}
            >
              {(branches ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  from {b.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy}>
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setNewName(settings.gitBranchPrefix ?? "");
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </form>
        )}
      </div>
      {status.inProgress !== "none" && (
        <div className="branch-picker-abort">
          <button
            type="button"
            onClick={async () => {
              try {
                await import("../tauri/api").then((m) => m.gitAbortMerge());
                onChanged();
                onClose();
                pushToast(`Aborted ${status.inProgress}`, { tone: "info" });
              } catch (err) {
                const e = parseGitError(err);
                setError(e.message);
              }
            }}
          >
            Abort {status.inProgress}
          </button>
        </div>
      )}
    </div>
  );
}
