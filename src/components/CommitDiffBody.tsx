// biome-ignore-all lint/security/noDangerouslySetInnerHtml: Shiki returns trusted token HTML for code spans.
// CommitDiffBody - virtualized commit diff stream.
//
// The diff explorer has one scroll container, so the body flattens all
// files, hunk headers, lines, and hint rows into one TanStack Virtual
// list. File headers stay addressable by path for the file list and the
// active header is force-rendered as a sticky row.

import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type MutableRefObject,
  memo,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  detectLangFromPath,
  ensureLanguage,
  highlightSync,
  isLangReady,
} from "../markdown/highlight";
import { LinkedRepoTrustCallout } from "../security/linkedRepoTrust";
import type {
  CommitDetail,
  DiffHunk,
  DiffLine,
  FileChange,
} from "../tauri/api";
import { Icon } from "./icons";

interface Props {
  detail: CommitDetail | null;
  loading: boolean;
  error: string | null;
  /** Existing `.diff-explorer-body` scroll container. */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** Optional path -> virtual scroll helper for external controls. */
  scrollToPathRef?: MutableRefObject<((path: string) => void) | null>;
  /** Filled with data-backed find controls for the virtualized diff. */
  findApiRef?: MutableRefObject<DiffFindApi | null>;
  /** When set, only this file's diff renders after a double-click
   *  filter. Compared against `FileChange.path`. */
  filterPath?: string | null;
  softWrap?: boolean;
  /** Set of file keys (see `fileKey`) that are currently collapsed.
   *  When omitted, every file renders expanded. */
  collapsedFiles?: ReadonlySet<string>;
  /** Toggle a file's collapsed state. Called with the same key
   *  shape as `collapsedFiles`. */
  onToggleFile?: (key: string) => void;
  /** Loads a placeholder file body for header-first commit details. */
  onLoadFile?: (file: FileChange) => void;
}

export interface DiffSearchMatch {
  id: string;
  itemIndex: number;
  lineKey: string;
  path: string;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface DiffFindApi {
  search: (query: string) => DiffSearchMatch[];
  activate: (match: DiffSearchMatch | null) => void;
  clear: () => void;
}

const STATUS_LABEL: Record<FileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

const ESTIMATE = {
  fileHead: 32,
  hunkHead: 26,
  line: 18,
  hint: 44,
  unloaded: 44,
  truncated: 44,
};
const HUNK_PREVIEW_LINES = 300;
const TAB_COLUMNS = 8;

type DiffItem =
  | { kind: "file-head"; key: string; fileKey: string; file: FileChange }
  | { kind: "large-hint"; key: string; fileKey: string; file: FileChange }
  | { kind: "binary"; key: string; fileKey: string; file: FileChange }
  | { kind: "unloaded"; key: string; fileKey: string; file: FileChange }
  | { kind: "empty"; key: string; fileKey: string; file: FileChange }
  | {
      kind: "hunk-head";
      key: string;
      fileKey: string;
      file: FileChange;
      hunkIdx: number;
      hunk: DiffHunk;
    }
  | {
      kind: "line";
      key: string;
      fileKey: string;
      file: FileChange;
      hunkIdx: number;
      lineIdx: number;
      hunk: DiffHunk;
      line: DiffLine;
    }
  | {
      kind: "hunk-more";
      key: string;
      fileKey: string;
      hunkKey: string;
      hidden: number;
    }
  | { kind: "truncated"; key: string; fileKey: string; file: FileChange };

/** Stable key for a `FileChange`. Includes oldPath so renames don't
 *  collide with their target. Exported so the parent (DiffExplorerPane)
 *  can hold a collapsed-keys set without re-implementing the formula. */
export function fileKey(file: FileChange): string {
  return `${file.path}\0${file.oldPath ?? ""}`;
}

export const CommitDiffBody = memo(function CommitDiffBody(props: Props) {
  const {
    detail,
    loading,
    error,
    bodyRef,
    scrollToPathRef,
    findApiRef,
    filterPath,
    softWrap,
    collapsedFiles,
    onToggleFile,
    onLoadFile,
  } = props;
  const [hunkHtmlCache, setHunkHtmlCache] = useState<
    Map<string, Array<string | null>>
  >(() => new Map());
  const [expandedHunks, setExpandedHunks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [findMatchesByLine, setFindMatchesByLine] = useState<
    Map<string, DiffSearchMatch[]>
  >(() => new Map());
  const [activeFindMatchId, setActiveFindMatchId] = useState<string | null>(
    null,
  );
  const [selectedLineKeys, setSelectedLineKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [lastSelectedLineKey, setLastSelectedLineKey] = useState<string | null>(
    null,
  );

  const filesToRender = useMemo(() => {
    if (!detail) return [];
    if (!filterPath) return detail.files;
    return detail.files.filter((f) => f.path === filterPath);
  }, [detail, filterPath]);

  const stream = useMemo(() => {
    const items: DiffItem[] = [];
    const fileHeadIndexes = new Map<string, number>();
    const fileHeadIndexesByPath = new Map<string, number>();

    for (const file of filesToRender) {
      const key = fileKey(file);
      const collapsed = collapsedFiles?.has(key) ?? false;
      const fileHeadIndex = items.length;
      fileHeadIndexes.set(key, fileHeadIndex);
      fileHeadIndexesByPath.set(file.path, fileHeadIndex);
      items.push({
        kind: "file-head",
        key: `file:${key}`,
        fileKey: key,
        file,
      });

      if (collapsed) {
        if (file.large) {
          items.push({
            kind: "large-hint",
            key: `large:${key}`,
            fileKey: key,
            file,
          });
        }
        continue;
      }
      if (file.binary) {
        items.push({
          kind: "binary",
          key: `binary:${key}`,
          fileKey: key,
          file,
        });
        continue;
      }
      if (file.bodyLoaded === false) {
        items.push({
          kind: "unloaded",
          key: `unloaded:${key}`,
          fileKey: key,
          file,
        });
        continue;
      }
      if (file.hunks.length === 0) {
        items.push({
          kind: "empty",
          key: `empty:${key}`,
          fileKey: key,
          file,
        });
      } else {
        for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
          const hunk = file.hunks[hunkIdx];
          const hunkKeyValue = hunkItemKey(key, hunkIdx);
          const expanded = expandedHunks.has(hunkKeyValue);
          const visibleLines =
            hunk.lines.length > HUNK_PREVIEW_LINES && !expanded
              ? hunk.lines.slice(0, HUNK_PREVIEW_LINES)
              : hunk.lines;
          items.push({
            kind: "hunk-head",
            key: `hunk:${key}:${hunkIdx}:${hunk.oldStart}:${hunk.newStart}`,
            fileKey: key,
            file,
            hunkIdx,
            hunk,
          });
          for (let lineIdx = 0; lineIdx < visibleLines.length; lineIdx++) {
            const line = visibleLines[lineIdx];
            items.push({
              kind: "line",
              key: `line:${key}:${hunkIdx}:${line.kind}:${
                line.oldLine ?? "none"
              }:${line.newLine ?? "none"}:${lineIdx}`,
              fileKey: key,
              file,
              hunkIdx,
              lineIdx,
              hunk,
              line,
            });
          }
          if (visibleLines.length < hunk.lines.length) {
            items.push({
              kind: "hunk-more",
              key: `hunk-more:${key}:${hunkIdx}`,
              fileKey: key,
              hunkKey: hunkKeyValue,
              hidden: hunk.lines.length - visibleLines.length,
            });
          }
        }
      }
      if (file.truncatedLines != null && file.truncatedLines > 0) {
        items.push({
          kind: "truncated",
          key: `truncated:${key}`,
          fileKey: key,
          file,
        });
      }
    }

    return { items, fileHeadIndexes, fileHeadIndexesByPath };
  }, [filesToRender, collapsedFiles, expandedHunks]);

  const lineKeysInOrder = useMemo(
    () =>
      stream.items
        .filter((item): item is Extract<DiffItem, { kind: "line" }> => {
          return item.kind === "line";
        })
        .map((item) => item.key),
    [stream.items],
  );

  const selectedLineCopyText = useMemo(() => {
    if (selectedLineKeys.size === 0) return "";
    const lines: string[] = [];
    for (const item of stream.items) {
      if (item.kind === "line" && selectedLineKeys.has(item.key)) {
        lines.push(item.line.text);
      }
    }
    return lines.join("\n");
  }, [selectedLineKeys, stream.items]);

  const diffScrollStyle = useMemo(
    () =>
      ({
        "--cdb-scroll-width": softWrap
          ? "100%"
          : `calc(${maxDiffLineColumns(stream.items)}ch + var(--cdb-line-chrome-width) + 28px)`,
      }) as CSSProperties,
    [softWrap, stream.items],
  );

  useEffect(() => {
    setHunkHtmlCache(new Map());
    setExpandedHunks(new Set());
    setFindMatchesByLine(new Map());
    setActiveFindMatchId(null);
  }, []);

  useEffect(() => {
    if (selectedLineKeys.size === 0) return;
    const visibleLineKeys = new Set(lineKeysInOrder);
    setSelectedLineKeys((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        if (visibleLineKeys.has(key)) next.add(key);
      }
      return next.size === prev.size ? prev : next;
    });
    setLastSelectedLineKey((prev) =>
      prev && !visibleLineKeys.has(prev) ? null : prev,
    );
  }, [lineKeysInOrder, selectedLineKeys]);

  const selectDiffLine = useCallback(
    (lineKey: string, additive: boolean, range: boolean) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
      setSelectedLineKeys((prev) => {
        if (range && lastSelectedLineKey) {
          const start = lineKeysInOrder.indexOf(lastSelectedLineKey);
          const end = lineKeysInOrder.indexOf(lineKey);
          if (start !== -1 && end !== -1) {
            const next = additive ? new Set(prev) : new Set<string>();
            const from = Math.min(start, end);
            const to = Math.max(start, end);
            for (let index = from; index <= to; index++) {
              const key = lineKeysInOrder[index];
              if (key) next.add(key);
            }
            return next;
          }
        }

        if (additive) {
          const next = new Set(prev);
          if (next.has(lineKey)) next.delete(lineKey);
          else next.add(lineKey);
          return next;
        }

        if (prev.size === 1 && prev.has(lineKey)) return new Set();
        return new Set([lineKey]);
      });
      setLastSelectedLineKey(lineKey);
    },
    [lastSelectedLineKey, lineKeysInOrder],
  );

  const onCopySelectedLines = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      if (selectedLineKeys.size === 0) return;
      const nativeSelection = window.getSelection()?.toString();
      if (nativeSelection) return;
      e.clipboardData.setData("text/plain", selectedLineCopyText);
      e.preventDefault();
    },
    [selectedLineCopyText, selectedLineKeys],
  );

  const onDiffBodyKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Escape" || selectedLineKeys.size === 0) return;
      e.stopPropagation();
      setSelectedLineKeys(new Set());
      setLastSelectedLineKey(null);
    },
    [selectedLineKeys],
  );

  const activeStickyIndexRef = useMemo(() => ({ current: 0 }), []);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const next = defaultRangeExtractor(range);
      let active = -1;
      for (const index of stream.fileHeadIndexes.values()) {
        if (index <= range.startIndex && index > active) active = index;
      }
      activeStickyIndexRef.current = active;
      return active >= 0 ? Array.from(new Set([active, ...next])) : next;
    },
    [activeStickyIndexRef, stream.fileHeadIndexes],
  );

  const rowVirtualizer = useVirtualizer({
    count: stream.items.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: (index) => estimateItem(stream.items[index]),
    getItemKey: (index) => stream.items[index]?.key ?? index,
    measureElement: softWrap
      ? (element) => element.getBoundingClientRect().height
      : undefined,
    rangeExtractor,
    overscan: 8,
  });

  useEffect(() => {
    if (!scrollToPathRef) return;
    scrollToPathRef.current = (path: string) => {
      const index = stream.fileHeadIndexesByPath.get(path);
      if (index == null) return;
      rowVirtualizer.scrollToIndex(index, { align: "start" });
    };
    return () => {
      scrollToPathRef.current = null;
    };
  }, [rowVirtualizer, scrollToPathRef, stream.fileHeadIndexesByPath]);

  const searchDiff = useCallback(
    (query: string): DiffSearchMatch[] => {
      const q = query.toLowerCase();
      const matches: DiffSearchMatch[] = [];
      const byLine = new Map<string, DiffSearchMatch[]>();
      if (!q) {
        setFindMatchesByLine(byLine);
        setActiveFindMatchId(null);
        return matches;
      }
      for (const file of filesToRender) {
        if (file.bodyLoaded === false && !file.binary) {
          onLoadFile?.(file);
        }
      }
      for (let itemIndex = 0; itemIndex < stream.items.length; itemIndex++) {
        const item = stream.items[itemIndex];
        if (!item || item.kind !== "line") continue;
        const lower = item.line.text.toLowerCase();
        let matchStart = lower.indexOf(q);
        while (matchStart !== -1) {
          const match: DiffSearchMatch = {
            id: `${item.key}:${matchStart}`,
            itemIndex,
            lineKey: item.key,
            path: item.file.path,
            lineText: item.line.text,
            matchStart,
            matchEnd: matchStart + query.length,
          };
          matches.push(match);
          const lineMatches = byLine.get(item.key);
          if (lineMatches) lineMatches.push(match);
          else byLine.set(item.key, [match]);
          matchStart = lower.indexOf(q, matchStart + query.length);
        }
      }
      setFindMatchesByLine(byLine);
      setActiveFindMatchId(matches[0]?.id ?? null);
      return matches;
    },
    [filesToRender, onLoadFile, stream.items],
  );

  const activateDiffMatch = useCallback(
    (match: DiffSearchMatch | null) => {
      setActiveFindMatchId(match?.id ?? null);
      if (match) {
        rowVirtualizer.scrollToIndex(match.itemIndex, { align: "center" });
      }
    },
    [rowVirtualizer],
  );

  const clearDiffFind = useCallback(() => {
    setFindMatchesByLine(new Map());
    setActiveFindMatchId(null);
  }, []);

  useEffect(() => {
    if (!findApiRef) return;
    findApiRef.current = {
      search: searchDiff,
      activate: activateDiffMatch,
      clear: clearDiffFind,
    };
    return () => {
      findApiRef.current = null;
    };
  }, [activateDiffMatch, clearDiffFind, findApiRef, searchDiff]);

  const virtualItems = rowVirtualizer.getVirtualItems();
  const onExpandHunk = useCallback((hunkKeyValue: string) => {
    setExpandedHunks((prev) => {
      if (prev.has(hunkKeyValue)) return prev;
      const next = new Set(prev);
      next.add(hunkKeyValue);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!onLoadFile || virtualItems.length === 0) return;
    const requested = new Set<string>();
    for (const virtualItem of virtualItems) {
      const item = stream.items[virtualItem.index];
      if (!item) continue;
      const file =
        item.kind === "unloaded"
          ? item.file
          : item.kind === "file-head" &&
              item.file.bodyLoaded === false &&
              item.file.binary !== true &&
              !(collapsedFiles?.has(item.fileKey) ?? false)
            ? item.file
            : null;
      if (!file) continue;
      const key = fileKey(file);
      if (requested.has(key)) continue;
      requested.add(key);
      onLoadFile(file);
    }
  }, [collapsedFiles, onLoadFile, stream.items, virtualItems]);

  useEffect(() => {
    if (virtualItems.length === 0) return;
    const needed = new Map<
      string,
      { hunk: DiffHunk; lang: string; lineCount: number }
    >();
    for (const virtualItem of virtualItems) {
      const item = stream.items[virtualItem.index];
      if (!item || (item.kind !== "line" && item.kind !== "hunk-head")) {
        continue;
      }
      const lang = detectLangFromPath(item.file.path);
      if (!lang) continue;
      const key = hunkCacheKey(item.fileKey, item.hunkIdx, lang);
      if (hunkHtmlCache.has(key) || needed.has(key)) continue;
      needed.set(key, {
        hunk: item.hunk,
        lang,
        lineCount: item.hunk.lines.length,
      });
    }
    if (needed.size === 0) return;

    let cancelled = false;
    for (const [key, req] of needed) {
      const fill = () => {
        const html = highlightHunk(req.hunk, req.lang);
        if (cancelled) return;
        setHunkHtmlCache((prev) => {
          if (prev.has(key)) return prev;
          const next = new Map(prev);
          next.set(
            key,
            html ?? Array.from({ length: req.lineCount }, () => null),
          );
          return next;
        });
      };
      if (isLangReady(req.lang)) {
        fill();
      } else {
        ensureLanguage(req.lang).then((ok) => {
          if (!cancelled && ok) fill();
        });
      }
    }
    return () => {
      cancelled = true;
    };
  }, [hunkHtmlCache, stream.items, virtualItems]);

  if (loading && !detail) {
    return (
      <div className="cdb-empty">
        <span className="cdb-spinner" /> loading diff...
      </div>
    );
  }
  if (error) {
    return (
      <div className="cdb-empty cdb-error">
        <LinkedRepoTrustCallout error={error} />
      </div>
    );
  }
  if (!detail) {
    return null;
  }
  if (detail.files.length === 0) {
    return (
      <div className="cdb-empty">
        {detail.sha === "unstaged"
          ? "No uncommitted changes."
          : "This commit has no file changes."}
      </div>
    );
  }
  if (filesToRender.length === 0) {
    return <div className="cdb-empty">No diff for the filtered file.</div>;
  }

  return (
    <div
      className={`cdb-root ${softWrap ? "soft-wrap" : ""}`}
      style={diffScrollStyle}
      role="listbox"
      aria-label="Diff lines"
      aria-multiselectable="true"
      tabIndex={-1}
      onCopy={onCopySelectedLines}
      onKeyDown={onDiffBodyKeyDown}
    >
      <div
        className="cdb-virtual-spacer"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualItem) => {
          const item = stream.items[virtualItem.index];
          if (!item) return null;
          const sticky = virtualItem.index === activeStickyIndexRef.current;
          return (
            <div
              key={virtualItem.key}
              className={`cdb-virtual-row ${sticky ? "sticky" : ""}`}
              data-index={virtualItem.index}
              ref={softWrap ? rowVirtualizer.measureElement : undefined}
              style={
                sticky
                  ? { height: virtualItem.size }
                  : {
                      height: virtualItem.size,
                      transform: `translateY(${virtualItem.start}px)`,
                    }
              }
            >
              <DiffItemRow
                item={item}
                collapsed={collapsedFiles?.has(item.fileKey) ?? false}
                htmlCache={hunkHtmlCache}
                findMatchesByLine={findMatchesByLine}
                activeFindMatchId={activeFindMatchId}
                selectedLineKeys={selectedLineKeys}
                onToggleFile={onToggleFile}
                onExpandHunk={onExpandHunk}
                onSelectLine={selectDiffLine}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

interface DiffItemRowProps {
  item: DiffItem;
  collapsed: boolean;
  htmlCache: Map<string, Array<string | null>>;
  findMatchesByLine: Map<string, DiffSearchMatch[]>;
  activeFindMatchId: string | null;
  selectedLineKeys: ReadonlySet<string>;
  onToggleFile?: (key: string) => void;
  onExpandHunk: (hunkKeyValue: string) => void;
  onSelectLine: (lineKey: string, additive: boolean, range: boolean) => void;
}

const DiffItemRow = memo(function DiffItemRow({
  item,
  collapsed,
  htmlCache,
  findMatchesByLine,
  activeFindMatchId,
  selectedLineKeys,
  onToggleFile,
  onExpandHunk,
  onSelectLine,
}: DiffItemRowProps) {
  switch (item.kind) {
    case "file-head":
      return (
        <DiffFileHeaderRow
          file={item.file}
          fileKeyValue={item.fileKey}
          collapsed={collapsed}
          onToggleFile={onToggleFile}
        />
      );
    case "large-hint":
      return (
        <LargeHintRow
          file={item.file}
          fileKeyValue={item.fileKey}
          onToggleFile={onToggleFile}
        />
      );
    case "binary":
      return <div className="cdb-binary">Binary file (no diff rendered).</div>;
    case "unloaded":
      return <UnloadedRow file={item.file} />;
    case "empty":
      return (
        <div className="cdb-empty-hunks">
          {item.file.status === "renamed" || item.file.status === "copied"
            ? "Rename only - no content change."
            : "No textual changes."}
        </div>
      );
    case "hunk-head":
      return <DiffHunkHeaderRow hunk={item.hunk} />;
    case "line": {
      const lang = detectLangFromPath(item.file.path);
      const html =
        lang != null
          ? (htmlCache.get(hunkCacheKey(item.fileKey, item.hunkIdx, lang))?.[
              item.lineIdx
            ] ?? null)
          : null;
      return (
        <DiffLineRow
          lineKey={item.key}
          line={item.line}
          html={html}
          findMatches={findMatchesByLine.get(item.key) ?? null}
          activeFindMatchId={activeFindMatchId}
          selected={selectedLineKeys.has(item.key)}
          onSelectLine={onSelectLine}
        />
      );
    }
    case "hunk-more":
      return (
        <HunkMoreRow
          hidden={item.hidden}
          onClick={() => onExpandHunk(item.hunkKey)}
        />
      );
    case "truncated":
      return <TruncatedRow file={item.file} />;
  }
});

function UnloadedRow({ file }: { file: FileChange }) {
  return (
    <div className="cdb-unloaded">
      <span className="cdb-spinner" />
      loading {file.path}
    </div>
  );
}

interface DiffFileHeaderRowProps {
  file: FileChange;
  fileKeyValue: string;
  collapsed: boolean;
  onToggleFile?: (key: string) => void;
}

const DiffFileHeaderRow = memo(function DiffFileHeaderRow({
  file,
  fileKeyValue,
  collapsed,
  onToggleFile,
}: DiffFileHeaderRowProps) {
  const headInteractive = !!onToggleFile;
  return (
    <header
      className={`cdb-file-head ${headInteractive ? "interactive" : ""}`}
      data-file-path={file.path}
    >
      <span className="cdb-file-main">
        {headInteractive ? (
          <button
            type="button"
            className={`cdb-file-toggle ${collapsed ? "" : "open"}`}
            aria-label={collapsed ? "Expand file" : "Collapse file"}
            aria-expanded={!collapsed}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFile?.(fileKeyValue);
            }}
          >
            <Icon.Caret />
          </button>
        ) : null}
        <span className={`cdb-status status-${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="cdb-path" title={file.path}>
          {file.oldPath && file.oldPath !== file.path ? (
            <>
              <span className="cdb-path-old">{file.oldPath}</span>
              <span className="cdb-path-arrow">-&gt;</span>
              <span className="cdb-path-new">{file.path}</span>
            </>
          ) : (
            file.path
          )}
        </span>
      </span>
      <span className="cdb-counts">
        <span className="cdb-add">+{file.additions}</span>
        <span className="cdb-del">-{file.deletions}</span>
      </span>
    </header>
  );
});

function LargeHintRow({
  file,
  fileKeyValue,
  onToggleFile,
}: {
  file: FileChange;
  fileKeyValue: string;
  onToggleFile?: (key: string) => void;
}) {
  return (
    <div className="cdb-large-hint">
      Large diff ({file.additions + file.deletions} lines){" "}
      <button
        type="button"
        className="cdb-large-expand"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFile?.(fileKeyValue);
        }}
      >
        Load diff
      </button>
    </div>
  );
}

const DiffHunkHeaderRow = memo(function DiffHunkHeaderRow({
  hunk,
}: {
  hunk: DiffHunk;
}) {
  const label = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return (
    <div className="cdb-hunk-head" data-hunk-label={label}>
      <span className="cdb-hunk-label">{label}</span>
      {hunk.headerText && (
        <span className="cdb-hunk-context"> {hunk.headerText}</span>
      )}
    </div>
  );
});

function TruncatedRow({ file }: { file: FileChange }) {
  if (file.truncatedLines == null || file.truncatedLines <= 0) return null;
  return (
    <div className="cdb-truncated-hint">
      Diff truncated - {file.truncatedLines.toLocaleString()} more line
      {file.truncatedLines === 1 ? "" : "s"} not shown. Open the file directly
      to view the full content.
    </div>
  );
}

function HunkMoreRow({
  hidden,
  onClick,
}: {
  hidden: number;
  onClick: () => void;
}) {
  return (
    <div className="cdb-hunk-more">
      <button type="button" className="cdb-hunk-more-btn" onClick={onClick}>
        Show {hidden.toLocaleString()} more line{hidden === 1 ? "" : "s"} in
        this hunk
      </button>
    </div>
  );
}

const DiffLineRow = memo(
  function DiffLineRow({
    lineKey,
    line,
    html,
    findMatches,
    activeFindMatchId,
    selected,
    onSelectLine,
  }: {
    lineKey: string;
    line: DiffLine;
    html: string | null;
    findMatches: readonly DiffSearchMatch[] | null;
    activeFindMatchId: string | null;
    selected: boolean;
    onSelectLine: (lineKey: string, additive: boolean, range: boolean) => void;
  }) {
    const marker =
      line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
    const showFindHighlights = findMatches != null && findMatches.length > 0;
    return (
      <div
        className={`cdb-line ${line.kind} ${selected ? "selected" : ""}`}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={(e) => {
          const root = e.currentTarget.closest(
            ".cdb-root",
          ) as HTMLElement | null;
          root?.focus({ preventScroll: true });
          onSelectLine(lineKey, e.metaKey || e.ctrlKey, e.shiftKey);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onSelectLine(lineKey, e.metaKey || e.ctrlKey, e.shiftKey);
        }}
      >
        <span className="cdb-gutter old">{line.oldLine ?? ""}</span>
        <span className="cdb-gutter new">{line.newLine ?? ""}</span>
        <span className="cdb-marker">{marker}</span>
        {showFindHighlights ? (
          <span className="cdb-line-text">
            {renderFindText(line.text || " ", findMatches, activeFindMatchId)}
          </span>
        ) : html ? (
          <span
            className="cdb-line-text shiki-tokens"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <span className="cdb-line-text">{line.text || " "}</span>
        )}
      </div>
    );
  },
  (a, b) =>
    a.line === b.line &&
    a.html === b.html &&
    a.findMatches === b.findMatches &&
    a.activeFindMatchId === b.activeFindMatchId &&
    a.selected === b.selected &&
    a.onSelectLine === b.onSelectLine,
);

function estimateItem(item: DiffItem | undefined): number {
  if (!item) return ESTIMATE.line;
  switch (item.kind) {
    case "file-head":
      return ESTIMATE.fileHead;
    case "hunk-head":
      return ESTIMATE.hunkHead;
    case "line":
      return ESTIMATE.line;
    case "hunk-more":
      return ESTIMATE.hint;
    case "unloaded":
      return ESTIMATE.unloaded;
    case "truncated":
      return ESTIMATE.truncated;
    default:
      return ESTIMATE.hint;
  }
}

function hunkCacheKey(
  fileKeyValue: string,
  hunkIdx: number,
  lang: string,
): string {
  return `${fileKeyValue}\0${hunkIdx}\0${lang}`;
}

function hunkItemKey(fileKeyValue: string, hunkIdx: number): string {
  return `${fileKeyValue}\0${hunkIdx}`;
}

function maxDiffLineColumns(items: readonly DiffItem[]): number {
  let max = 1;
  for (const item of items) {
    if (item.kind !== "line") continue;
    max = Math.max(max, displayColumns(item.line.text || " "));
  }
  return max;
}

function displayColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === "\t") {
      columns += TAB_COLUMNS - (columns % TAB_COLUMNS);
    } else {
      columns += 1;
    }
  }
  return columns;
}

function renderFindText(
  text: string,
  matches: readonly DiffSearchMatch[],
  activeFindMatchId: string | null,
) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.matchStart > cursor) {
      parts.push(text.slice(cursor, match.matchStart));
    }
    parts.push(
      <mark
        key={match.id}
        className={`cdb-find-match ${
          match.id === activeFindMatchId ? "current" : ""
        }`}
      >
        {text.slice(match.matchStart, match.matchEnd)}
      </mark>,
    );
    cursor = match.matchEnd;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** Highlight one visible hunk as a single shiki call. With
 *  `structure: "inline"` shiki emits `<br>` between lines, so we split
 *  on that to recover per-line HTML. */
const SHIKI_LINE_BREAK = /<br\s*\/?>/g;
function highlightHunk(
  hunk: DiffHunk,
  lang: string,
): Array<string | null> | null {
  if (hunk.lines.length === 0) return [];
  const text = hunk.lines.map((l) => l.text).join("\n");
  const html = highlightSync(text, lang);
  if (html == null) return hunk.lines.map(() => null);
  const parts = html.split(SHIKI_LINE_BREAK);
  if (parts.length !== hunk.lines.length) {
    return hunk.lines.map(() => null);
  }
  return parts;
}
