// DiffExplorerPane — middle-pane half.
//
// Sister of TerminalPane. Lives in the same action slot inside
// `.middle-stack`; mutually exclusive with the terminal.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGitStatusContext } from "../hooks/gitStatusContext";
import { useCommitDetail } from "../hooks/useCommitDetail";
import { formatRelativeTime } from "../lib/time";
import { isWideDiffLayout } from "../review/diffLayout";
import { DiffFind } from "../search/DiffFind";
import type { GraphCommit } from "../tauri/api";
import { CommitDiffBody, type DiffFindApi, fileKey } from "./CommitDiffBody";
import { CommitFileList } from "./CommitFileList";
import type { CommitSelection } from "./CommitHistoryRail";
import { CommitPanel } from "./CommitPanel";

const SPLIT_RATIO_KEY = `specrider.diffExplorerSplit.v1.${getCurrentWindow().label}`;
const DEFAULT_SPLIT_RATIO = 0.3;
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.7;

function loadSplitRatio(): number {
  try {
    const raw = localStorage.getItem(SPLIT_RATIO_KEY);
    if (!raw) return DEFAULT_SPLIT_RATIO;
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n >= MIN_SPLIT_RATIO && n <= MAX_SPLIT_RATIO) {
      return n;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SPLIT_RATIO;
}

export interface DiffExplorerPaneProps {
  open: boolean;
  /** Selected commit/unstaged row from the outline rail. null while
   *  nothing's been picked (e.g. empty repo, brand-new plan). */
  selection: CommitSelection | null;
  /** Pass-through from useCommitGraph so we can render the row's
   *  one-line metadata immediately, without waiting for the full
   *  commitMeta round-trip. */
  commits: GraphCommit[];
  repoHandle?: string | null;
  readOnly?: boolean;
  /** ⌘F-driven find overlay. App.tsx owns the boolean so its
   *  global keybinding can flip it when focus is inside this pane. */
  findOpen: boolean;
  onCloseFind: () => void;
  onClose: () => void;
}

export function DiffExplorerPane(props: DiffExplorerPaneProps) {
  // Lazy-mount gate matching TerminalPane: stay null until first open,
  // then stay mounted and toggle visibility via CSS.
  const [hasOpened, setHasOpened] = useState(false);
  useEffect(() => {
    if (props.open) setHasOpened(true);
  }, [props.open]);
  if (!hasOpened) return null;
  return <DiffExplorerPaneInner {...props} />;
}

function DiffExplorerPaneInner(props: DiffExplorerPaneProps) {
  const {
    open,
    selection,
    commits,
    repoHandle = null,
    readOnly = false,
    findOpen,
    onCloseFind,
    onClose,
  } = props;
  const detail = useCommitDetail(selection, repoHandle);
  const gitStatus = useGitStatusContext();
  const isUnstaged = selection?.kind === "unstaged";
  const [softWrap, setSoftWrap] = useState(false);
  const [wideLayout, setWideLayout] = useState(false);
  // File-list / diff-body horizontal split. Persisted per window.
  const [splitRatio, setSplitRatio] = useState<number>(loadSplitRatio);
  // Selecting a file row scopes the diff body to that file. Clicking
  // the surrounding file-list surface clears the selection.
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  // Per-file collapsed-state set, keyed by `fileKey(file)`. Default
  // is "all expanded" (empty set). Lifted up here so the
  // expand/collapse-all header button can flip every entry at once.
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Files staged for the next commit (only meaningful when isUnstaged).
  // Default-includes every file under plansRoot. Outside-plansRoot
  // files are surfaced but unchecked unless the user opts in.
  const [selectedForCommit, setSelectedForCommit] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const paneRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrollDiffPathRef = useRef<((path: string) => void) | null>(null);
  const diffFindApiRef = useRef<DiffFindApi | null>(null);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const applyWidth = (width: number) => {
      const next = isWideDiffLayout(width);
      setWideLayout((prev) => (prev === next ? prev : next));
    };
    applyWidth(pane.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyWidth(entry.contentRect.width);
    });
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  // Reset file selection + collapse state whenever the parent
  // commit changes — the file list is different, and "remembering"
  // collapsed paths across commits would be more confusing than useful.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection is the reset key even though the effect only clears local state.
  useEffect(() => {
    setSelectedFilePath(null);
    setCollapsedFiles(new Set());
  }, [selection]);

  // GitHub-style auto-collapse: when the parsed detail arrives, mark
  // every file flagged `large` (over the soft cap) as collapsed by
  // default. Only seeds once per detail load — once the user toggles
  // a file, their choice sticks until selection changes.
  const seededLargeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detail.detail) return;
    const key = `${selection?.kind ?? "none"}:${
      selection?.kind === "commit" ? selection.sha : ""
    }`;
    if (seededLargeRef.current === key) return;
    seededLargeRef.current = key;
    const largeKeys = detail.detail.files.filter((f) => f.large).map(fileKey);
    if (largeKeys.length > 0) {
      setCollapsedFiles(new Set(largeKeys));
    }
  }, [detail.detail, selection]);

  // Seed/refresh the staging set whenever the unstaged file list
  // changes. Default-include every change *under plansRoot* — the
  // plans-root scoping comes from gitStatus.changes which carries the
  // relToPlans mapping.
  useEffect(() => {
    if (!isUnstaged) return;
    const insidePaths = new Set(
      (gitStatus.status?.changes ?? [])
        .filter((c) => c.relToPlans !== null && c.kind !== "conflicted")
        .map((c) => c.path),
    );
    setSelectedForCommit((prev) => {
      // If the user hasn't deselected anything yet, just default to
      // "everything in plansRoot". Otherwise leave their picks alone
      // but drop any paths that no longer exist in the file list.
      const fileSet = new Set(detail.detail?.files.map((f) => f.path) ?? []);
      if (prev.size === 0) return insidePaths;
      const next = new Set<string>();
      for (const p of prev) if (fileSet.has(p)) next.add(p);
      // Add any newly-appeared inside-plansRoot paths.
      for (const p of insidePaths) if (fileSet.has(p)) next.add(p);
      return next;
    });
  }, [isUnstaged, gitStatus.status, detail.detail]);

  const summary =
    selection?.kind === "commit"
      ? (commits.find((c) => c.sha === selection.sha) ?? null)
      : null;
  const body = detail.detail?.body ?? "";
  const files = detail.detail?.files ?? [];
  const loadedFileKey = useMemo(
    () =>
      files
        .map(
          (file) =>
            `${file.path}:${file.oldPath ?? ""}:${file.bodyLoaded === false ? 0 : 1}`,
        )
        .join("|"),
    [files],
  );

  const onSelectFile = useCallback(
    (path: string) => {
      setSelectedFilePath(path);
      const file = files.find((candidate) => candidate.path === path);
      if (!file) return;
      detail.loadFile(file);
      setCollapsedFiles((prev) => {
        const key = fileKey(file);
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [detail.loadFile, files],
  );

  const onClearFileSelection = useCallback(() => {
    setSelectedFilePath(null);
  }, []);

  const onToggleFile = useCallback((key: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // "Collapse all" when at least one file is currently expanded; else
  // "Expand all". The toggle's icon and label flip accordingly.
  const allCollapsed = useMemo(() => {
    if (files.length === 0) return false;
    return files.every((f) => collapsedFiles.has(fileKey(f)));
  }, [files, collapsedFiles]);

  const onToggleAll = useCallback(() => {
    if (files.length === 0) return;
    if (allCollapsed) {
      setCollapsedFiles(new Set());
    } else {
      setCollapsedFiles(new Set(files.map(fileKey)));
    }
  }, [files, allCollapsed]);

  const onToggleCommit = useCallback((path: string) => {
    setSelectedForCommit((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onToggleCommitAll = useCallback(() => {
    setSelectedForCommit((prev) => {
      const allPaths = files.map((f) => f.path);
      const allChecked =
        allPaths.length > 0 && allPaths.every((p) => prev.has(p));
      if (allChecked) return new Set();
      return new Set(allPaths);
    });
  }, [files]);

  const onCommitted = useCallback(() => {
    gitStatus.refresh();
    detail.refresh();
    setSelectedFilePath(null);
    setCollapsedFiles(new Set());
    setSelectedForCommit(new Set());
  }, [gitStatus, detail.refresh]);

  const startSplitDrag = useCallback(
    (e: React.MouseEvent<HTMLHRElement>) => {
      e.preventDefault();
      const container = e.currentTarget.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      let raf = 0;
      let latest = splitRatio;
      const onMove = (ev: MouseEvent) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (rect.height <= 0) return;
          const desired = (ev.clientY - rect.top) / rect.height;
          const clamped = Math.max(
            MIN_SPLIT_RATIO,
            Math.min(MAX_SPLIT_RATIO, desired),
          );
          latest = clamped;
          setSplitRatio(clamped);
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          localStorage.setItem(SPLIT_RATIO_KEY, String(latest));
        } catch {
          /* ignore */
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [splitRatio],
  );

  const onSplitterKey = (e: React.KeyboardEvent<HTMLHRElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    if (e.key === "ArrowUp")
      next = Math.max(MIN_SPLIT_RATIO, splitRatio - step);
    else if (e.key === "ArrowDown")
      next = Math.min(MAX_SPLIT_RATIO, splitRatio + step);
    else if (e.key === "Home") next = MIN_SPLIT_RATIO;
    else if (e.key === "End") next = MAX_SPLIT_RATIO;
    if (next === null) return;
    e.preventDefault();
    setSplitRatio(next);
    try {
      localStorage.setItem(SPLIT_RATIO_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  return (
    <section
      ref={paneRef}
      className="diff-explorer-pane"
      aria-label="Diff explorer"
      aria-hidden={!open}
    >
      <div className="diff-explorer-header">
        {selection?.kind === "unstaged" ? (
          <>
            <span className="diff-explorer-badge unstaged">●</span>
            <span className="diff-explorer-title">Uncommitted changes</span>
            <span className="diff-explorer-meta">working tree vs. HEAD</span>
          </>
        ) : summary ? (
          <>
            <span className="diff-explorer-sha" title={summary.sha}>
              {summary.shortSha}
            </span>
            <span className="diff-explorer-title">{summary.subject}</span>
            <span className="diff-explorer-meta">
              {summary.authorName} · {formatRelativeTime(summary.timeSecs)}
            </span>
          </>
        ) : (
          <span className="diff-explorer-empty">
            Select a commit (or Unstaged) from the right rail to view its diff.
          </span>
        )}
        <div className="diff-explorer-spacer" />
        {files.length > 1 && (
          <button
            type="button"
            className="diff-explorer-collapse-all"
            onClick={onToggleAll}
            aria-label={
              allCollapsed ? "Expand all files" : "Collapse all files"
            }
            title={allCollapsed ? "Expand all files" : "Collapse all files"}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
        <label
          className="diff-explorer-toggle"
          title="Soft-wrap long lines in the diff body"
        >
          <input
            type="checkbox"
            checked={softWrap}
            onChange={(e) => setSoftWrap(e.target.checked)}
          />
          <span>Wrap</span>
        </label>
        <button
          type="button"
          className="diff-explorer-close"
          onClick={onClose}
          aria-label="Close diff explorer"
          title="Close diff explorer"
        >
          ×
        </button>
      </div>
      <DiffFind
        open={findOpen}
        apiRef={diffFindApiRef}
        scanKey={`${selection?.kind ?? "none"}:${
          selection?.kind === "commit" ? selection.sha : ""
        }:${selectedFilePath ?? ""}:${collapsedFiles.size}:${loadedFileKey}`}
        onClose={onCloseFind}
      />
      {selection ? (
        <div
          className={`diff-explorer-layout ${wideLayout ? "wide" : "narrow"}`}
          style={
            wideLayout
              ? undefined
              : {
                  gridTemplateRows: `auto auto ${
                    splitRatio * 100
                  }% 6px minmax(0, 1fr)`,
                }
          }
        >
          {body && (
            <div className="diff-explorer-body-message">
              <pre>{body}</pre>
            </div>
          )}
          {isUnstaged && !readOnly && (
            <div className="diff-explorer-commit-slot">
              <CommitPanel
                files={files}
                selectedForCommit={selectedForCommit}
                onCommitted={onCommitted}
              />
            </div>
          )}
          {/* biome-ignore lint/a11y: background clicks in the file-list pane clear the scoped file; keyboard users have the clear button. */}
          <div className="diff-explorer-files" onClick={onClearFileSelection}>
            <CommitFileList
              files={files}
              selectedPath={selectedFilePath}
              onSelect={onSelectFile}
              onClearSelection={onClearFileSelection}
              selectedForCommit={
                isUnstaged && !readOnly ? selectedForCommit : null
              }
              onToggleCommit={
                isUnstaged && !readOnly ? onToggleCommit : undefined
              }
              onToggleCommitAll={
                isUnstaged && !readOnly ? onToggleCommitAll : undefined
              }
            />
          </div>
          <hr
            className="splitter splitter-horizontal diff-explorer-file-splitter"
            onMouseDown={startSplitDrag}
            onKeyDown={onSplitterKey}
            aria-orientation="horizontal"
            aria-label="Resize file list / diff body"
            aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
            aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
            aria-valuenow={Math.round(splitRatio * 100)}
            tabIndex={wideLayout ? -1 : 0}
            aria-hidden={wideLayout}
          />
          <div ref={bodyRef} className="diff-explorer-body">
            <CommitDiffBody
              detail={detail.detail}
              loading={detail.loading}
              error={detail.error}
              bodyRef={bodyRef}
              scrollToPathRef={scrollDiffPathRef}
              findApiRef={diffFindApiRef}
              softWrap={softWrap}
              filterPath={selectedFilePath}
              collapsedFiles={collapsedFiles}
              onToggleFile={onToggleFile}
              onLoadFile={detail.loadFile}
            />
          </div>
        </div>
      ) : (
        <div className="diff-explorer-body" />
      )}
    </section>
  );
}
