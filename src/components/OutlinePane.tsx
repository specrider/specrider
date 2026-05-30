import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { changeKindForLine, changeKindForRange } from "../hooks/useDiff";
import { scrollBehavior } from "../lib/motion";
import { usePins } from "../pins/store";
import { useSettings } from "../settings/store";
import type { ChangeSet } from "../tauri/api";
import type { OutlineListItem, OutlineNode, OutlineTask } from "../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Icon } from "./icons";

type Filter = "all" | "unfinished";

interface Props {
  outline: OutlineNode[];
  progress: { done: number; total: number };
  activeHeading: string;
  /** Path of the active plan — needed so the Pinned group can look
   *  up which sections of *this* plan are pinned, and so toggling
   *  knows which plan to address. */
  planPath: string | null;
  diff: ChangeSet;
  /** Shared collapse state with the Reader. Outline carets toggle
   *  the same set, so a section folded in either surface stays
   *  folded in both — and the persistence is per-doc via
   *  useCollapsedSections. */
  collapsed: Set<string>;
  onToggleSection: (id: string) => void;
  /** Source-line keyed task fold state shared with the Reader.
   *  Toggling a nested-task caret here folds the same task in the
   *  Markdown viewer and vice versa. */
  taskCollapsed: Set<number>;
  onToggleTaskCollapse: (line: number) => void;
  /** `sourceLine` is the heading's 1-based source line — used by edit
   *  / split modes to scroll the editor as well as the preview. */
  onJump: (id: string, sourceLine: number) => void;
  onJumpToTask: (line: number) => void;
  onJumpToListItem: (line: number) => void;
}

type ChildRow =
  | { kind: "task"; line: number; item: OutlineTask }
  | { kind: "list"; line: number; item: OutlineListItem };

function nodeMatchesFilter(n: OutlineNode, filter: Filter): boolean {
  if (filter === "all") return true;
  if (n.tasks.some((t) => !t.done)) return true;
  return n.children.some((c) => nodeMatchesFilter(c, filter));
}

export function OutlinePane({
  outline,
  progress,
  activeHeading,
  planPath,
  diff,
  collapsed,
  onToggleSection,
  taskCollapsed,
  onToggleTaskCollapse,
  onJump,
  onJumpToTask,
  onJumpToListItem,
}: Props) {
  const { effective: settings } = useSettings();
  const { pinnedSections, isSectionPinned, toggleSection } = usePins();

  // Flatten the outline tree once so the Pinned group's "find this
  // heading" lookups don't have to walk the tree on every render.
  const headingByIdMap = useMemo(() => {
    const m = new Map<string, OutlineNode>();
    const walk = (nodes: OutlineNode[]) => {
      for (const n of nodes) {
        m.set(n.id, n);
        walk(n.children);
      }
    };
    walk(outline);
    return m;
  }, [outline]);

  const sectionsForPlan = planPath ? pinnedSections(planPath) : [];
  const resolvedPinnedSections = useMemo(() => {
    if (!planPath) return [];
    return sectionsForPlan.map((s) => {
      const node = headingByIdMap.get(s.headingId);
      if (!node) {
        // Pinned heading no longer exists in this plan (renamed,
        // removed, or pin was set in a different plan). Surface a
        // stub row using the persisted text so the user can still
        // unpin it.
        return {
          node: null as OutlineNode | null,
          headingId: s.headingId,
          headingText: s.headingText,
        };
      }
      return { node, headingId: s.headingId, headingText: s.headingText };
    });
  }, [headingByIdMap, planPath, sectionsForPlan]);

  const onTogglePinForHeading = (headingId: string, headingText: string) => {
    if (!planPath) return;
    void toggleSection(planPath, headingId, headingText).catch((err) =>
      console.error("toggleSectionPin:", err),
    );
  };

  // Right-click context menu over outline rows. Mirrors the sidebar's
  // pin/unpin entry — the outline previously had no menu, so this is
  // the menu's only purpose for now.
  const [pinMenu, setPinMenu] = useState<{
    headingId: string;
    headingText: string;
    anchor: { left: number; top: number };
  } | null>(null);

  const buildPinMenuItems = (
    headingId: string,
    headingText: string,
  ): ContextMenuItem[] => {
    const isPinned = planPath ? isSectionPinned(planPath, headingId) : false;
    return [
      {
        label: isPinned ? "Unpin section" : "Pin section",
        onSelect: () => onTogglePinForHeading(headingId, headingText),
      },
    ];
  };

  const showTasks = settings.outlineShowTasks;
  const showNumbered = settings.outlineShowNumberedLists;
  const showBulleted = settings.outlineShowBulletedLists;

  const visibleListsFor = useCallback(
    (n: OutlineNode): OutlineListItem[] =>
      n.lists.filter(
        (l) =>
          (l.kind === "numbered" && showNumbered) ||
          (l.kind === "bulleted" && showBulleted),
      ),
    [showBulleted, showNumbered],
  );

  const [filter, setFilter] = useState<Filter>("all");

  // Keep the highlighted row visible: when reader scroll changes
  // activeHeading, the matching row may be below the outline fold.
  // `block: "nearest"` is a no-op when already in view, so clicking
  // an already-visible row doesn't jump.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!activeHeading) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(".ol-row.active");
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [activeHeading]);

  const totalDone = progress.done;
  const totalAll = progress.total;
  const pct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0;

  // Chip badge counts reflect TASKS (matching the "N / total tasks"
  // header), not heading nodes — a doc with one section but 33 tasks
  // should read "All 33 / To do 26", not "All 1 / To do 1".
  const totalTaskCount = totalAll;
  const unfinishedTaskCount = Math.max(0, totalAll - totalDone);

  // Outline shares the Reader's collapsed Set, so a heading is
  // "expanded" iff it isn't in that set. Persistence + per-doc
  // restoration come for free from useCollapsedSections.
  const isExpanded = useCallback(
    (n: OutlineNode): boolean => !collapsed.has(n.id),
    [collapsed],
  );

  // ─── Flat visible-row list for tree-pattern keyboard navigation ────
  //
  // Heading rows can host both tasks/lists and child headings; nested
  // tasks live as flat siblings styled with depth. We model the
  // visible cursor as a single ordered list of treeitems regardless of
  // their kind, with a parentKey lookup so Left can walk back to the
  // enclosing heading.
  interface FlatRow {
    key: string;
    level: number;
    parentKey: string | null;
    kind: "heading" | "task" | "list" | "pinned-heading";
    expandable: boolean;
    expanded?: boolean;
    /** Activate (Enter/Space) callback. */
    activate?: () => void;
    /** Toggle expand/collapse callback (only for expandable rows). */
    toggleExpanded?: () => void;
  }
  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = [];
    if (planPath && resolvedPinnedSections.length > 0) {
      for (const r of resolvedPinnedSections) {
        const node = r.node;
        rows.push({
          key: `ph:${r.headingId}`,
          level: 1,
          parentKey: null,
          kind: "pinned-heading",
          expandable: false,
          activate: () => {
            if (node) onJump(r.headingId, node.line);
          },
        });
      }
    }
    const walkNode = (n: OutlineNode, parentKey: string | null) => {
      if (!nodeMatchesFilter(n, filter)) return;
      const headingKey = `h:${n.id}`;
      const visibleLists = filter === "unfinished" ? [] : visibleListsFor(n);
      const renderableTasks = showTasks ? n.tasks : [];
      const hasOwnRows = renderableTasks.length > 0 || visibleLists.length > 0;
      const hasTasksOrChildren = hasOwnRows || n.children.length > 0;
      const expandedNow = isExpanded(n);
      rows.push({
        key: headingKey,
        level: n.depth + 1,
        parentKey,
        kind: "heading",
        expandable: hasTasksOrChildren,
        expanded: hasTasksOrChildren ? expandedNow : undefined,
        activate: () => onJump(n.id, n.line),
        toggleExpanded: hasTasksOrChildren
          ? () => onToggleSection(n.id)
          : undefined,
      });
      if (!expandedNow || !hasTasksOrChildren) return;

      // Replicate the renderNode task-collapse logic so flatRows match
      // exactly what's rendered.
      const taskHasChildren = new Set<number>();
      for (let i = 0; i < renderableTasks.length; i++) {
        const next = renderableTasks[i + 1];
        if (next && next.depth > renderableTasks[i].depth) {
          taskHasChildren.add(renderableTasks[i].line);
        }
      }
      const taskHiddenByCollapse = new Set<number>();
      {
        let suppressAtDepth: number | null = null;
        for (const t of renderableTasks) {
          if (suppressAtDepth !== null && t.depth > suppressAtDepth) {
            taskHiddenByCollapse.add(t.line);
            continue;
          }
          suppressAtDepth = null;
          if (taskHasChildren.has(t.line) && taskCollapsed.has(t.line)) {
            suppressAtDepth = t.depth;
          }
        }
      }
      const visibleTasks =
        filter === "unfinished"
          ? renderableTasks.filter((t) => !t.done)
          : renderableTasks;
      const childRows: ChildRow[] = [
        ...visibleTasks.map<ChildRow>((t) => ({
          kind: "task",
          line: t.line,
          item: t,
        })),
        ...visibleLists.map<ChildRow>((l) => ({
          kind: "list",
          line: l.line,
          item: l,
        })),
      ].sort((a, b) => a.line - b.line);
      for (const row of childRows) {
        if (row.kind === "task") {
          if (taskHiddenByCollapse.has(row.line)) continue;
          const hasChildren = taskHasChildren.has(row.line);
          const folded = hasChildren && taskCollapsed.has(row.line);
          rows.push({
            key: `t:${n.id}:${row.line}`,
            level: n.depth + 2,
            parentKey: headingKey,
            kind: "task",
            expandable: hasChildren,
            expanded: hasChildren ? !folded : undefined,
            activate: () => onJumpToTask(row.line),
            toggleExpanded: hasChildren
              ? () => onToggleTaskCollapse(row.line)
              : undefined,
          });
        } else {
          rows.push({
            key: `l:${n.id}:${row.line}`,
            level: n.depth + 2,
            parentKey: headingKey,
            kind: "list",
            expandable: false,
            activate: () => onJumpToListItem(row.line),
          });
        }
      }
      for (const child of n.children) walkNode(child, headingKey);
    };
    for (const n of outline) walkNode(n, null);
    return rows;
  }, [
    outline,
    filter,
    taskCollapsed,
    resolvedPinnedSections,
    planPath,
    showTasks,
    onJump,
    onJumpToTask,
    onJumpToListItem,
    onToggleSection,
    onToggleTaskCollapse,
    visibleListsFor,
    isExpanded,
  ]);

  const flatByKey = useMemo(() => {
    const m = new Map<string, FlatRow>();
    for (const r of flatRows) m.set(r.key, r);
    return m;
  }, [flatRows]);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setRowRef = (key: string) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };

  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);

  useEffect(() => {
    if (flatRows.length === 0) {
      setActiveRowKey(null);
      return;
    }
    if (activeRowKey && flatByKey.has(activeRowKey)) return;
    // Default cursor: the active reader heading if one is visible,
    // otherwise the first row.
    const fallback =
      (activeHeading &&
        flatByKey.has(`h:${activeHeading}`) &&
        `h:${activeHeading}`) ||
      flatRows[0].key;
    setActiveRowKey(fallback);
  }, [flatRows, flatByKey, activeRowKey, activeHeading]);

  // Move keyboard focus to the active row when the cursor changes,
  // but only if the outline already contains focus.
  useEffect(() => {
    if (!activeRowKey) return;
    const tree = treeRef.current;
    if (!tree?.contains(document.activeElement)) return;
    const el = rowRefs.current.get(activeRowKey);
    el?.focus();
  }, [activeRowKey]);

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (!activeRowKey || flatRows.length === 0) return;
    const idx = flatRows.findIndex((r) => r.key === activeRowKey);
    if (idx < 0) return;
    const row = flatRows[idx];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveRowKey(flatRows[Math.min(idx + 1, flatRows.length - 1)].key);
        return;
      case "ArrowUp":
        e.preventDefault();
        setActiveRowKey(flatRows[Math.max(idx - 1, 0)].key);
        return;
      case "ArrowRight":
        if (row.expandable) {
          e.preventDefault();
          if (!row.expanded) {
            row.toggleExpanded?.();
          } else {
            setActiveRowKey(
              flatRows[Math.min(idx + 1, flatRows.length - 1)].key,
            );
          }
        }
        return;
      case "ArrowLeft":
        if (row.expandable && row.expanded) {
          e.preventDefault();
          row.toggleExpanded?.();
        } else if (row.parentKey) {
          e.preventDefault();
          setActiveRowKey(row.parentKey);
        }
        return;
      case "Home":
        e.preventDefault();
        setActiveRowKey(flatRows[0].key);
        return;
      case "End":
        e.preventDefault();
        setActiveRowKey(flatRows[flatRows.length - 1].key);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        row.activate?.();
        return;
    }
  };

  const renderNode = (n: OutlineNode): ReactNode[] => {
    if (!nodeMatchesFilter(n, filter)) return [];

    const complete = n.taskTotal > 0 && n.taskDone === n.taskTotal;
    const donePct = n.taskTotal ? n.taskDone / n.taskTotal : 0;
    // To-do mode is a tasks-only view: bulleted/numbered list items
    // are noise here, so suppress them entirely. (In 'all' mode they
    // still respect the per-kind settings via visibleListsFor.)
    const visibleLists = filter === "unfinished" ? [] : visibleListsFor(n);
    const renderableTasks = showTasks ? n.tasks : [];
    const hasOwnRows = renderableTasks.length > 0 || visibleLists.length > 0;
    const hasTasksOrChildren = hasOwnRows || n.children.length > 0;
    const expandedNow = isExpanded(n);

    const visibleTasks =
      filter === "unfinished"
        ? renderableTasks.filter((t) => !t.done)
        : renderableTasks;

    // Walk the full (pre-filter) task list once to derive structure:
    //  - taskHasChildren — tasks immediately followed by a deeper one
    //  - taskHiddenByCollapse — tasks whose ancestor is folded
    // Using `renderableTasks` (not `visibleTasks`) so the To-do filter
    // can't flatten the parent/child relationship.
    const taskHasChildren = new Set<number>();
    for (let i = 0; i < renderableTasks.length; i++) {
      const next = renderableTasks[i + 1];
      if (next && next.depth > renderableTasks[i].depth) {
        taskHasChildren.add(renderableTasks[i].line);
      }
    }
    const taskHiddenByCollapse = new Set<number>();
    {
      let suppressAtDepth: number | null = null;
      for (const t of renderableTasks) {
        if (suppressAtDepth !== null && t.depth > suppressAtDepth) {
          taskHiddenByCollapse.add(t.line);
          continue;
        }
        suppressAtDepth = null;
        if (taskHasChildren.has(t.line) && taskCollapsed.has(t.line)) {
          suppressAtDepth = t.depth;
        }
      }
    }

    const childRows: ChildRow[] = [
      ...visibleTasks.map<ChildRow>((t) => ({
        kind: "task",
        line: t.line,
        item: t,
      })),
      ...visibleLists.map<ChildRow>((l) => ({
        kind: "list",
        line: l.line,
        item: l,
      })),
    ].sort((a, b) => a.line - b.line);

    const headingChange = changeKindForRange(diff, n.line, n.endLine);
    const sectionPinned = planPath ? isSectionPinned(planPath, n.id) : false;

    const headingClasses = [
      "ol-row",
      `depth-${n.depth}`,
      activeHeading === n.id && "active",
      complete && "complete",
      sectionPinned && "pinned",
      headingChange.kind && `change-${headingChange.kind}`,
    ]
      .filter(Boolean)
      .join(" ");

    const out: ReactNode[] = [];

    const headingKey = `h:${n.id}`;
    const isTreeActive = activeRowKey === headingKey;
    out.push(
      // biome-ignore lint/a11y/useKeyWithClickEvents: tree keyboard navigation is handled by the tree container.
      <div
        key={n.id}
        ref={setRowRef(headingKey)}
        className={`${headingClasses}${isTreeActive ? " tree-active" : ""}`}
        role="treeitem"
        aria-level={n.depth + 1}
        aria-expanded={hasTasksOrChildren ? expandedNow : undefined}
        tabIndex={isTreeActive ? 0 : -1}
        onClick={() => {
          setActiveRowKey(headingKey);
          onJump(n.id, n.line);
        }}
        onFocus={() => setActiveRowKey(headingKey)}
        onContextMenu={(e) => {
          if (!planPath) return;
          e.preventDefault();
          e.stopPropagation();
          setPinMenu({
            headingId: n.id,
            headingText: n.text,
            anchor: { left: e.clientX, top: e.clientY },
          });
        }}
      >
        {hasTasksOrChildren ? (
          <button
            type="button"
            className={`ol-caret ${expandedNow ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSection(n.id);
            }}
            aria-label={expandedNow ? "Collapse" : "Expand"}
            tabIndex={-1}
          >
            <Icon.Caret />
          </button>
        ) : (
          <span className="ol-mark" />
        )}
        {sectionPinned && (
          <span className="ol-pin-glyph" title="Pinned">
            <Icon.Pin />
          </span>
        )}
        <span className="ol-text">{n.text}</span>
        <span className="ol-meta">
          {n.taskTotal > 0 && (
            <>
              <span className="ol-mini">
                <span
                  className="ol-mini-done"
                  style={{ width: `${donePct * 100}%` }}
                />
              </span>
              <span className={`ol-count ${complete ? "complete" : ""}`}>
                {n.taskDone}/{n.taskTotal}
              </span>
            </>
          )}
        </span>
      </div>,
    );

    if (hasTasksOrChildren) {
      const children: ReactNode[] = [];
      childRows.forEach((row) => {
        const changeKind = changeKindForLine(diff, row.line);
        if (row.kind === "task") {
          const t = row.item;
          if (taskHiddenByCollapse.has(t.line)) return; // ancestor folded
          const hasChildren = taskHasChildren.has(t.line);
          const folded = hasChildren && taskCollapsed.has(t.line);
          const taskClasses = [
            "ol-task-row",
            `depth-${n.depth}`,
            t.done ? "done" : "",
            t.depth > 0 ? "nested" : "",
            hasChildren ? "has-children" : "",
            changeKind ? `change-${changeKind}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          // Nested tasks add 14px per level on top of the heading-depth
          // base padding via the --task-nest custom property; see styles.
          const taskStyle =
            t.depth > 0
              ? ({ "--task-nest": `${t.depth * 14}px` } as React.CSSProperties)
              : undefined;
          const taskKey = `t:${n.id}:${t.line}`;
          const isTaskTreeActive = activeRowKey === taskKey;
          children.push(
            // biome-ignore lint/a11y/useKeyWithClickEvents: tree keyboard navigation is handled by the tree container.
            <div
              key={`${n.id}-t-${t.line}`}
              ref={setRowRef(taskKey)}
              className={`${taskClasses}${isTaskTreeActive ? " tree-active" : ""}`}
              role="treeitem"
              aria-level={n.depth + 2}
              aria-expanded={hasChildren ? !folded : undefined}
              tabIndex={isTaskTreeActive ? 0 : -1}
              style={taskStyle}
              onClick={() => {
                setActiveRowKey(taskKey);
                onJumpToTask(t.line);
              }}
              onFocus={() => setActiveRowKey(taskKey)}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className={`ol-task-caret ${folded ? "" : "open"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleTaskCollapse(t.line);
                  }}
                  aria-label={folded ? "Expand children" : "Collapse children"}
                  aria-expanded={!folded}
                  tabIndex={-1}
                >
                  <Icon.Caret />
                </button>
              ) : (
                <span className="ol-task-caret-spacer" aria-hidden="true" />
              )}
              <span className={`ol-task-check ${t.done ? "done" : ""}`} />
              <span className="ol-task-text">{t.text}</span>
            </div>,
          );
        } else {
          const l = row.item;
          const listClasses = [
            "ol-list-row",
            l.kind,
            `depth-${n.depth}`,
            changeKind ? `change-${changeKind}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          const listKey = `l:${n.id}:${l.line}`;
          const isListTreeActive = activeRowKey === listKey;
          children.push(
            // biome-ignore lint/a11y/useKeyWithClickEvents: tree keyboard navigation is handled by the tree container.
            <div
              key={`${n.id}-l-${l.line}`}
              ref={setRowRef(listKey)}
              className={`${listClasses}${isListTreeActive ? " tree-active" : ""}`}
              role="treeitem"
              aria-level={n.depth + 2}
              tabIndex={isListTreeActive ? 0 : -1}
              onClick={() => {
                setActiveRowKey(listKey);
                onJumpToListItem(l.line);
              }}
              onFocus={() => setActiveRowKey(listKey)}
            >
              <span className="ol-list-marker">
                {l.kind === "numbered" ? l.marker : "•"}
              </span>
              <span className="ol-list-text">{l.text}</span>
            </div>,
          );
        }
      });
      n.children.forEach((c) => {
        children.push(...renderNode(c));
      });
      out.push(
        // biome-ignore lint/a11y/useSemanticElements: role=group is the correct child container inside the tree pattern.
        <div
          key={`${n.id}-children`}
          className={`ol-children ${expandedNow ? "open" : ""}`}
          role="group"
          aria-hidden={!expandedNow}
        >
          <div className="ol-children-inner">{children}</div>
        </div>,
      );
    }

    return out;
  };

  return (
    <div className="pane outline">
      <div className="outline-head">
        <div className="outline-progress">
          <div className="op-numbers">
            <span className="op-done">{totalDone}</span>
            <span className="op-of">/ {totalAll} tasks</span>
            <span className="op-pct">{pct}%</span>
          </div>
          <div className="op-bar">
            <div
              className="op-bar-done"
              style={{
                width: totalAll ? `${(totalDone / totalAll) * 100}%` : "0%",
              }}
            />
          </div>
          <div className="op-legend">
            <span className="op-legend-item">
              <span className="op-legend-dot done" />
              done
            </span>
            <span className="op-legend-item">
              <span className="op-legend-dot todo" />
              todo
            </span>
          </div>
        </div>
      </div>

      <div className="outline-filters">
        <button
          type="button"
          aria-pressed={filter === "all"}
          className={`of-chip ${filter === "all" ? "on" : ""}`}
          onClick={() => setFilter("all")}
        >
          All <span className="of-chip-count">{totalTaskCount}</span>
        </button>
        <button
          type="button"
          aria-pressed={filter === "unfinished"}
          className={`of-chip ${filter === "unfinished" ? "on" : ""}`}
          onClick={() => setFilter("unfinished")}
        >
          To do <span className="of-chip-count">{unfinishedTaskCount}</span>
        </button>
      </div>

      <div
        className="outline-list"
        ref={(el) => {
          listRef.current = el;
          treeRef.current = el;
        }}
        role="tree"
        aria-label="Outline"
        onKeyDown={onTreeKeyDown}
      >
        {planPath && resolvedPinnedSections.length > 0 && (
          <div className="ol-pinned-group">
            <div className="ol-section-head pinned-group">
              <span className="ol-section-label">PINNED</span>
              <span className="ol-section-count">
                {resolvedPinnedSections.length}
              </span>
            </div>
            {resolvedPinnedSections.map((row) => {
              const node = row.node;
              const text = node?.text ?? row.headingText;
              const orphan = node === null;
              const pinKey = `ph:${row.headingId}`;
              const isPinTreeActive = activeRowKey === pinKey;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: tree keyboard navigation is handled by the tree container.
                <div
                  key={`pinned:${row.headingId}`}
                  ref={setRowRef(pinKey)}
                  role="treeitem"
                  aria-level={1}
                  tabIndex={isPinTreeActive ? 0 : -1}
                  className={[
                    "ol-row",
                    "pinned",
                    "in-pinned-group",
                    activeHeading === row.headingId && "active",
                    orphan && "orphan",
                    isPinTreeActive && "tree-active",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => {
                    setActiveRowKey(pinKey);
                    if (node) onJump(row.headingId, node.line);
                  }}
                  onFocus={() => setActiveRowKey(pinKey)}
                  onContextMenu={(e) => {
                    if (!planPath) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setPinMenu({
                      headingId: row.headingId,
                      headingText: text,
                      anchor: { left: e.clientX, top: e.clientY },
                    });
                  }}
                  title={orphan ? "Pinned heading no longer exists" : undefined}
                >
                  <span className="ol-pin-glyph" aria-hidden="true">
                    <Icon.Pin />
                  </span>
                  <span className="ol-text">{text}</span>
                </div>
              );
            })}
          </div>
        )}
        {outline.flatMap((n) => renderNode(n))}
      </div>
      {pinMenu && (
        <ContextMenu
          anchor={pinMenu.anchor}
          items={buildPinMenuItems(pinMenu.headingId, pinMenu.headingText)}
          onClose={() => setPinMenu(null)}
        />
      )}
    </div>
  );
}
