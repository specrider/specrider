import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePins } from "../pins/store";
import {
  type ChangedPlan,
  createFolder,
  createPlan,
  deletePlan,
  duplicatePlan,
  getPlansRoot,
  movePlan,
  openPlanInNewWindow,
  renamePlan,
  revealPlan,
} from "../tauri/api";
import type { Plan } from "../types";
import { KNOWN_BUCKETS } from "../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Icon } from "./icons";

interface Props {
  plans: Plan[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Invoked after a "New doc…" / "New doc here…" create completes,
   *  so the parent can select the new plan *and* switch the reader
   *  into split mode (writer-friendly default for fresh files).
   *  Falls back to `onSelect` when not provided. */
  onCreate?: (id: string) => void;
  changedPlans: Map<string, ChangedPlan>;
}

interface MenuTarget {
  plan: Plan;
  anchor: { left: number; top: number };
}

const DND_MIME = "application/x-specrider-plan";
const SPRING_LOAD_MS = 500;

/** Computes the destination relative path for a plan being dropped
 *  onto a target folder. Returns null when the move would be a no-op
 *  (same parent dir). */
function destForFolderDrop(
  planPath: string,
  folderPath: string,
): string | null {
  const basename = basenameOf(planPath);
  const dest = `${folderPath}/${basename}`;
  if (dest === planPath) return null;
  return dest;
}

/** Returns the parent folder path of a plan, or "" for root-level
 *  plans. Used so dropping onto a sibling row routes the move into
 *  that row's folder. */
function parentFolder(planPath: string): string {
  const idx = planPath.lastIndexOf("/");
  return idx < 0 ? "" : planPath.slice(0, idx);
}

const WELL_KNOWN_BUCKETS: Array<(typeof KNOWN_BUCKETS)[number]> = [
  "active",
  "upcoming",
  "backlog",
  "archive",
];

function basenameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

const STORAGE_KEY = `specrider.bucketExpanded.v1.${getCurrentWindow().label}`;
const MAX_DEPTH_CLASS = 5;

// ─── Tree model ──────────────────────────────────────────────────────

interface FolderNode {
  kind: "folder";
  name: string;
  /** Full forward-slash path under the plans root. */
  path: string;
  depth: number;
  children: TreeNode[];
}

interface PlanNode {
  kind: "plan";
  plan: Plan;
  depth: number;
}

type TreeNode = FolderNode | PlanNode;

function buildTree(plans: Plan[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const plan of plans) {
    const segments = plan.path.split("/").filter(Boolean);
    const folders = segments.slice(0, -1);
    let parent = root;
    let pathSoFar = "";
    for (let i = 0; i < folders.length; i++) {
      pathSoFar += (pathSoFar ? "/" : "") + folders[i];
      let folder = parent.find(
        (n): n is FolderNode => n.kind === "folder" && n.path === pathSoFar,
      );
      if (!folder) {
        folder = {
          kind: "folder",
          name: folders[i],
          path: pathSoFar,
          depth: i,
          children: [],
        };
        parent.push(folder);
      }
      parent = folder.children;
    }
    parent.push({ kind: "plan", plan, depth: folders.length });
  }
  sortLevel(root);
  return root;
}

function sortLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (a.kind === "folder" && b.kind === "folder") {
      const ka = wellKnownIndex(a.name);
      const kb = wellKnownIndex(b.name);
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name);
    }
    // Plans arrive from list_plans already sorted by mtime; preserve.
    return 0;
  });
  for (const n of nodes) {
    if (n.kind === "folder") sortLevel(n.children);
  }
}

function wellKnownIndex(name: string): number {
  const i = (KNOWN_BUCKETS as readonly string[]).indexOf(name);
  return i >= 0 ? i : 100;
}

function folderBucketClass(name: string): string | null {
  return (KNOWN_BUCKETS as readonly string[]).includes(name)
    ? `bucket-${name}`
    : null;
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes;
  const lower = q.toLowerCase();
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.kind === "plan") {
      const hay = `${n.plan.title} ${n.plan.path}`.toLowerCase();
      if (hay.includes(lower)) out.push(n);
    } else {
      const folderMatches =
        n.name.toLowerCase().includes(lower) ||
        n.path.toLowerCase().includes(lower);
      const filteredChildren = filterTree(n.children, q);
      if (folderMatches) {
        // Folder name matched → keep it fully open with all children
        out.push(n);
      } else if (filteredChildren.length > 0) {
        out.push({ ...n, children: filteredChildren });
      }
    }
  }
  return out;
}

function collectFolderPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "folder") {
      out.push(n.path);
      collectFolderPaths(n.children, out);
    }
  }
  return out;
}

function defaultFolderOpen(node: FolderNode): boolean {
  if (node.depth === 0) return node.name !== "archive";
  return false;
}

// ─── Storage helpers ─────────────────────────────────────────────────

function loadStored(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object")
      return parsed as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return {};
}

function saveStored(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// ─── Component ───────────────────────────────────────────────────────

const PINNED_GROUP_KEY = "__pinned__";

// ─── Tree-pattern flattening ─────────────────────────────────────────

interface VisibleNode {
  /** Stable id used for the active-node cursor and row refs.
   *  Folder/regular-plan rows use the file path; pinned rows are
   *  prefixed so they don't collide with the same plan rendered in
   *  its bucket. */
  key: string;
  level: number;
  posInSet: number;
  setSize: number;
  parentKey: string | null;
  kind: "folder" | "plan" | "pinned-group" | "pinned-plan";
  expanded?: boolean;
  hasChildren?: boolean;
  folder?: FolderNode;
  plan?: Plan;
}

function pinnedKey(plan: Plan): string {
  return `pinned:${plan.path}`;
}

function flattenVisible(
  visibleTree: TreeNode[],
  isOpen: (f: FolderNode) => boolean,
  pinnedPlans: Plan[],
  pinnedGroupOpen: boolean,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  const hasPinned = pinnedPlans.length > 0;
  const rootSetSize = visibleTree.length + (hasPinned ? 1 : 0);

  if (hasPinned) {
    out.push({
      key: PINNED_GROUP_KEY,
      level: 1,
      posInSet: 1,
      setSize: rootSetSize,
      parentKey: null,
      kind: "pinned-group",
      expanded: pinnedGroupOpen,
      hasChildren: pinnedPlans.length > 0,
    });
    if (pinnedGroupOpen) {
      pinnedPlans.forEach((p, i) => {
        out.push({
          key: pinnedKey(p),
          level: 2,
          posInSet: i + 1,
          setSize: pinnedPlans.length,
          parentKey: PINNED_GROUP_KEY,
          kind: "pinned-plan",
          plan: p,
        });
      });
    }
  }

  const walk = (
    nodes: TreeNode[],
    level: number,
    parentKey: string | null,
    posOffset: number,
    setSize: number,
  ): void => {
    nodes.forEach((n, i) => {
      const posInSet = i + 1 + posOffset;
      if (n.kind === "folder") {
        const opened = isOpen(n);
        out.push({
          key: n.path,
          level,
          posInSet,
          setSize,
          parentKey,
          kind: "folder",
          expanded: opened,
          hasChildren: n.children.length > 0,
          folder: n,
        });
        if (opened) {
          walk(n.children, level + 1, n.path, 0, n.children.length);
        }
      } else {
        out.push({
          key: n.plan.path,
          level,
          posInSet,
          setSize,
          parentKey,
          kind: "plan",
          plan: n.plan,
        });
      }
    });
  };
  walk(visibleTree, 1, null, hasPinned ? 1 : 0, rootSetSize);
  return out;
}

export function DocumentBrowser({
  plans,
  activeId,
  onSelect,
  onCreate,
  changedPlans,
}: Props) {
  const { pinnedPlans, isPlanPinned, togglePlan: togglePinnedPlan } = usePins();
  // Inline search box was removed — the title bar's ⌘P quick switcher
  // and ⌘⇧F project search cover the same surface without duplicate
  // chrome inside the browser pane. Filter still wired but always a
  // no-op (query stays at "").
  const query: string = "";
  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadStored);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Drag state. `draggingPath` dims the source row; `dropTarget`
  // highlights the folder/row currently under the cursor.
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // "+ new" affordance: which mode the user is composing in (or
  // null when neither). `createParent` overrides the default-parent
  // resolver when the user invoked from a folder's context menu.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [creating, setCreating] = useState<"plan" | "folder" | null>(null);
  const [createParent, setCreateParent] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // Folder context menu — separate from the plan-row menu so each
  // can have its own bucket-aware items.
  const [folderMenu, setFolderMenu] = useState<{
    folder: FolderNode;
    anchor: { left: number; top: number };
  } | null>(null);
  // Spring-load: when the user hovers a collapsed folder during a
  // drag, expand it after a short pause so they can drop deeper.
  const springLoadTimer = useRef<number | null>(null);
  const springLoadTarget = useRef<string | null>(null);
  const cancelSpringLoad = () => {
    if (springLoadTimer.current !== null) {
      window.clearTimeout(springLoadTimer.current);
      springLoadTimer.current = null;
    }
    springLoadTarget.current = null;
  };

  const onPlanContextMenu = (plan: Plan, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ plan, anchor: { left: e.clientX, top: e.clientY } });
  };

  const onRenameStart = (plan: Plan) => {
    setRenameTarget(plan.path);
    setRenameError(null);
  };

  const onRenameCommit = async (plan: Plan, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setRenameError("name cannot be empty");
      return;
    }
    if (trimmed === basenameOf(plan.path).replace(/\.md$/i, "")) {
      // No-op rename — just close.
      setRenameTarget(null);
      setRenameError(null);
      return;
    }
    try {
      await renamePlan(plan.path, trimmed);
      setRenameTarget(null);
      setRenameError(null);
    } catch (err) {
      setRenameError(String(err));
    }
  };

  const onRenameCancel = () => {
    setRenameTarget(null);
    setRenameError(null);
  };

  const onDuplicate = async (plan: Plan) => {
    try {
      await duplicatePlan(plan.path);
    } catch (err) {
      console.error("duplicatePlan:", err);
    }
  };

  const onDelete = async (plan: Plan) => {
    const ok = await ask(`Move "${plan.title}" to Trash?`, {
      title: "Delete plan",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    try {
      await deletePlan(plan.path);
    } catch (err) {
      console.error("deletePlan:", err);
    }
  };

  const onMoveToBucket = async (plan: Plan, bucket: string) => {
    const basename = basenameOf(plan.path);
    const dest = `${bucket}/${basename}`;
    if (dest === plan.path) return;
    try {
      await movePlan(plan.path, dest);
    } catch (err) {
      console.error("movePlan:", err);
    }
  };

  const onMoveToOther = async (plan: Plan) => {
    const root = await getPlansRoot();
    if (!root) return;
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: root,
    });
    if (typeof picked !== "string") return;
    // Normalize separators (Windows returns backslashes) and trailing
    // slashes before prefix-matching against the plans root.
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const normRoot = norm(root);
    const normPicked = norm(picked);
    let relFolder: string;
    if (normPicked === normRoot) {
      relFolder = "";
    } else if (normPicked.startsWith(`${normRoot}/`)) {
      relFolder = normPicked.slice(normRoot.length + 1);
    } else {
      await message(
        `The chosen folder is outside the plans root.\n\nPick a folder inside:\n${root}`,
        { title: "Move to", kind: "error" },
      );
      return;
    }
    const basename = basenameOf(plan.path);
    const dest = relFolder ? `${relFolder}/${basename}` : basename;
    if (dest === plan.path) return;
    try {
      await movePlan(plan.path, dest);
    } catch (err) {
      console.error("movePlan:", err);
    }
  };

  // ─── Drag-and-drop handlers ────────────────────────────────────────

  const onPlanDragStart = (plan: Plan, e: React.DragEvent) => {
    e.dataTransfer.setData(DND_MIME, plan.path);
    // Also set text/plain as a fallback so the drag has *some* data
    // (some browsers refuse drags without a text payload).
    e.dataTransfer.setData("text/plain", plan.path);
    e.dataTransfer.effectAllowed = "move";
    setDraggingPath(plan.path);
  };

  const onPlanDragEnd = () => {
    setDraggingPath(null);
    setDropTarget(null);
    cancelSpringLoad();
  };

  /** Reads the dragged plan's relative path from the drop event,
   *  preferring the typed MIME but falling back to text/plain. */
  const readDraggedPath = (e: React.DragEvent): string | null => {
    return (
      e.dataTransfer.getData(DND_MIME) ||
      e.dataTransfer.getData("text/plain") ||
      null
    );
  };

  const onFolderDragOver = (folder: FolderNode, e: React.DragEvent) => {
    if (!draggingPath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== folder.path) setDropTarget(folder.path);
    // Spring-load: hover a collapsed folder ≥500ms → auto-expand.
    if (!isOpen(folder)) {
      if (springLoadTarget.current !== folder.path) {
        cancelSpringLoad();
        springLoadTarget.current = folder.path;
        springLoadTimer.current = window.setTimeout(() => {
          // Recheck — user might have left in the meantime.
          if (springLoadTarget.current === folder.path) {
            const next = { ...expanded, [folder.path]: true };
            setExpanded(next);
            saveStored(next);
          }
          springLoadTarget.current = null;
          springLoadTimer.current = null;
        }, SPRING_LOAD_MS);
      }
    } else {
      cancelSpringLoad();
    }
  };

  const onFolderDragLeave = (folder: FolderNode, _e: React.DragEvent) => {
    if (springLoadTarget.current === folder.path) cancelSpringLoad();
    if (dropTarget === folder.path) setDropTarget(null);
  };

  const onFolderDrop = async (folder: FolderNode, e: React.DragEvent) => {
    e.preventDefault();
    cancelSpringLoad();
    const src = readDraggedPath(e);
    setDraggingPath(null);
    setDropTarget(null);
    if (!src) return;
    const dest = destForFolderDrop(src, folder.path);
    if (!dest) return; // same parent, no-op
    try {
      await movePlan(src, dest);
    } catch (err) {
      console.error("movePlan (drop):", err);
    }
  };

  const onPlanRowDragOver = (plan: Plan, e: React.DragEvent) => {
    if (!draggingPath || draggingPath === plan.path) return;
    const targetFolder = parentFolder(plan.path);
    const sourceFolder = parentFolder(draggingPath);
    // Same-folder drops are reorders, which require manual sort mode
    // (not yet shipped). Skip for now so the cursor signals not-allowed.
    if (targetFolder === sourceFolder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== plan.path) setDropTarget(plan.path);
  };

  const onPlanRowDragLeave = (plan: Plan, _e: React.DragEvent) => {
    if (dropTarget === plan.path) setDropTarget(null);
  };

  const onPlanRowDrop = async (plan: Plan, e: React.DragEvent) => {
    e.preventDefault();
    const src = readDraggedPath(e);
    setDraggingPath(null);
    setDropTarget(null);
    if (!src) return;
    const targetFolder = parentFolder(plan.path);
    if (!targetFolder) return;
    const dest = destForFolderDrop(src, targetFolder);
    if (!dest) return;
    try {
      await movePlan(src, dest);
    } catch (err) {
      console.error("movePlan (row drop):", err);
    }
  };

  const onCopyPath = async (plan: Plan) => {
    try {
      await navigator.clipboard.writeText(plan.path);
    } catch (err) {
      console.error("clipboard:", err);
    }
  };

  const onReveal = async (plan: Plan) => {
    try {
      await revealPlan(plan.path);
    } catch (err) {
      console.error("revealPlan:", err);
    }
  };

  const onOpenInNewWindow = async (plan: Plan) => {
    try {
      await openPlanInNewWindow(plan.path);
    } catch (err) {
      console.error("openPlanInNewWindow:", err);
    }
  };

  /** Resolves the parent folder for the in-flight create. Honors an
   *  explicit `createParent` (set when invoked from a folder's
   *  context menu); otherwise creates at the plans root. */
  const activeCreateParent = (): string => createParent ?? "";

  const onCommitNewPlan = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setCreating(null);
      setCreateParent(null);
      setCreateError(null);
      return;
    }
    const parent = activeCreateParent();
    const rel = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      const created = await createPlan(rel);
      setCreating(null);
      setCreateParent(null);
      setCreateError(null);
      // Hand off to the create-specific callback so the parent can
      // select the new plan *and* drop the reader straight into split
      // mode (the natural starting point for fresh, empty files).
      // Falls back to plain selection when the host hasn't wired it.
      (onCreate ?? onSelect)(created);
    } catch (err) {
      setCreateError(String(err));
    }
  };

  const onCommitNewFolder = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setCreating(null);
      setCreateParent(null);
      setCreateError(null);
      return;
    }
    const parent = activeCreateParent();
    const rel = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      await createFolder(rel);
      setCreating(null);
      setCreateParent(null);
      setCreateError(null);
    } catch (err) {
      setCreateError(String(err));
    }
  };

  const onCancelCreate = () => {
    setCreating(null);
    setCreateParent(null);
    setCreateError(null);
  };

  const onFolderContextMenu = (folder: FolderNode, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderMenu({ folder, anchor: { left: e.clientX, top: e.clientY } });
  };

  const buildFolderMenuItems = (folder: FolderNode): ContextMenuItem[] => [
    {
      label: "New doc here…",
      onSelect: () => {
        setCreateParent(folder.path);
        setCreating("plan");
        setCreateError(null);
        // Make sure the folder is open so the user sees their new
        // plan land in it after the watcher refreshes.
        if (!isOpen(folder)) toggle(folder);
      },
    },
    {
      label: "New subfolder here…",
      onSelect: () => {
        setCreateParent(folder.path);
        setCreating("folder");
        setCreateError(null);
        if (!isOpen(folder)) toggle(folder);
      },
    },
  ];

  const buildMenuItems = (plan: Plan): ContextMenuItem[] => {
    const currentBucket = plan.path.split("/")[0];
    const pinned = isPlanPinned(plan.path);
    return [
      { label: "Open", onSelect: () => onSelect(plan.id) },
      { label: "Open in New Window", onSelect: () => onOpenInNewWindow(plan) },
      { divider: true, label: "" },
      {
        label: pinned ? "Unpin" : "Pin",
        onSelect: () => {
          void togglePinnedPlan(plan.path).catch((err) =>
            console.error("togglePlanPin:", err),
          );
        },
      },
      { divider: true, label: "" },
      { label: "Rename…", onSelect: () => onRenameStart(plan) },
      { label: "Duplicate", onSelect: () => onDuplicate(plan) },
      {
        label: "Move to",
        submenu: [
          ...WELL_KNOWN_BUCKETS.map((b) => ({
            label: b.charAt(0).toUpperCase() + b.slice(1),
            disabled: b === currentBucket,
            onSelect: () => onMoveToBucket(plan, b),
          })),
          { divider: true, label: "" },
          { label: "Other folder…", onSelect: () => onMoveToOther(plan) },
        ],
      },
      { divider: true, label: "" },
      { label: "Reveal in Finder", onSelect: () => onReveal(plan) },
      { label: "Copy path", onSelect: () => onCopyPath(plan) },
      { divider: true, label: "" },
      { label: "Delete…", danger: true, onSelect: () => onDelete(plan) },
    ];
  };

  const tree = useMemo(() => buildTree(plans), [plans]);
  const visibleTree = useMemo(
    () => (query ? filterTree(tree, query.trim()) : tree),
    [tree],
  );

  const allFolderPaths = useMemo(() => collectFolderPaths(tree), [tree]);

  const isOpen = useCallback(
    (folder: FolderNode): boolean => {
      if (query) return true; // Search auto-expands matching folders
      if (expanded[folder.path] !== undefined) return expanded[folder.path];
      return defaultFolderOpen(folder);
    },
    [expanded],
  );

  // Pinned group is collapsible but defaults open — fast access is the
  // whole point of the surface; collapsing it defeats the purpose, but
  // we still let the user fold it when the list grows long.
  const pinnedGroupOpen =
    expanded[PINNED_GROUP_KEY] !== undefined
      ? expanded[PINNED_GROUP_KEY]
      : true;
  const togglePinnedGroup = () => {
    const next = { ...expanded, [PINNED_GROUP_KEY]: !pinnedGroupOpen };
    setExpanded(next);
    saveStored(next);
  };

  const planByPath = useMemo(() => {
    const m = new Map<string, Plan>();
    for (const p of plans) m.set(p.path, p);
    return m;
  }, [plans]);

  // Resolve pinned-plan paths back to Plan objects. Skip pins whose
  // file no longer exists in the listing — the row can't render
  // without metadata, and the orphan persists in config until the
  // user explicitly unpins (cheap; keeps the API surface narrow).
  const resolvedPinnedPlans = useMemo(
    () =>
      pinnedPlans
        .map((pp) => planByPath.get(pp.planPath))
        .filter((p): p is Plan => p !== undefined),
    [pinnedPlans, planByPath],
  );

  const toggle = (folder: FolderNode) => {
    const next = { ...expanded, [folder.path]: !isOpen(folder) };
    setExpanded(next);
    saveStored(next);
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const p of allFolderPaths) next[p] = false;
    setExpanded(next);
    saveStored(next);
  };

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    for (const p of allFolderPaths) next[p] = true;
    setExpanded(next);
    saveStored(next);
  };

  // Single toggle reflects current state: any folder open → next click
  // collapses; everything closed → next click expands.
  const anyExpanded = allFolderPaths.some((p) => expanded[p] === true);

  // ─── Tree-pattern keyboard nav ─────────────────────────────────────
  const treeRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setRowRef = (key: string) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };

  const visibleNodes = useMemo(
    () =>
      flattenVisible(visibleTree, isOpen, resolvedPinnedPlans, pinnedGroupOpen),
    // isOpen reads `expanded` and `query`; both are tracked below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleTree, resolvedPinnedPlans, pinnedGroupOpen, isOpen],
  );

  const activePlanPath = useMemo(() => {
    const p = plans.find((pl) => pl.id === activeId);
    return p?.path ?? null;
  }, [activeId, plans]);

  const [activeNodeKey, setActiveNodeKey] = useState<string | null>(null);

  // Keep activeNodeKey pointing at a node that's still visible. If the
  // active plan is in the visible list, prefer its key; otherwise fall
  // back to the first visible row.
  useEffect(() => {
    if (visibleNodes.length === 0) {
      setActiveNodeKey(null);
      return;
    }
    if (activeNodeKey && visibleNodes.some((n) => n.key === activeNodeKey)) {
      return;
    }
    const fallback =
      (activePlanPath &&
        visibleNodes.find((n) => n.key === activePlanPath)?.key) ||
      visibleNodes[0].key;
    setActiveNodeKey(fallback);
  }, [visibleNodes, activeNodeKey, activePlanPath]);

  // Move keyboard focus to the active row when the cursor changes,
  // but only if the tree already contains focus — don't yank focus
  // away from the editor or another pane just because the user clicked
  // a plan link.
  useEffect(() => {
    if (!activeNodeKey) return;
    const tree = treeRef.current;
    if (!tree?.contains(document.activeElement)) return;
    const el = rowRefs.current.get(activeNodeKey);
    el?.focus();
  }, [activeNodeKey]);

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (!activeNodeKey || visibleNodes.length === 0) return;
    const idx = visibleNodes.findIndex((n) => n.key === activeNodeKey);
    if (idx < 0) return;
    const node = visibleNodes[idx];
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const nextIdx = Math.min(idx + 1, visibleNodes.length - 1);
        setActiveNodeKey(visibleNodes[nextIdx].key);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prevIdx = Math.max(idx - 1, 0);
        setActiveNodeKey(visibleNodes[prevIdx].key);
        return;
      }
      case "ArrowRight": {
        if (node.kind === "folder" || node.kind === "pinned-group") {
          e.preventDefault();
          if (!node.expanded) {
            if (node.kind === "folder" && node.folder) toggle(node.folder);
            else if (node.kind === "pinned-group") togglePinnedGroup();
          } else if (node.hasChildren) {
            const nextIdx = Math.min(idx + 1, visibleNodes.length - 1);
            setActiveNodeKey(visibleNodes[nextIdx].key);
          }
        }
        return;
      }
      case "ArrowLeft": {
        if (
          (node.kind === "folder" || node.kind === "pinned-group") &&
          node.expanded
        ) {
          e.preventDefault();
          if (node.kind === "folder" && node.folder) toggle(node.folder);
          else if (node.kind === "pinned-group") togglePinnedGroup();
        } else if (node.parentKey) {
          e.preventDefault();
          setActiveNodeKey(node.parentKey);
        }
        return;
      }
      case "Home": {
        e.preventDefault();
        setActiveNodeKey(visibleNodes[0].key);
        return;
      }
      case "End": {
        e.preventDefault();
        setActiveNodeKey(visibleNodes[visibleNodes.length - 1].key);
        return;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        if (node.kind === "folder" && node.folder) toggle(node.folder);
        else if (node.kind === "pinned-group") togglePinnedGroup();
        else if (
          (node.kind === "plan" || node.kind === "pinned-plan") &&
          node.plan
        ) {
          onSelect(node.plan.id);
        }
        return;
      }
    }
  };

  // When the tree shrinks (a folder disappears from disk), prune its
  // entry from the stored map so we don't leak state across plansRoot
  // changes.
  useEffect(() => {
    const live = new Set(allFolderPaths);
    let dirty = false;
    const next: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(expanded)) {
      if (live.has(k)) next[k] = v;
      else dirty = true;
    }
    if (dirty) {
      setExpanded(next);
      saveStored(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, allFolderPaths]);

  return (
    <aside className="pane browser" aria-label="Documents">
      <div className="browser-head pane-tab-head">
        <div className="pane-tabs" role="tablist" aria-label="Documents pane">
          <button
            type="button"
            role="tab"
            aria-selected="true"
            tabIndex={0}
            className="pane-tab on"
          >
            Docs
          </button>
        </div>
        <div className="browser-head-actions">
          <button
            type="button"
            className="browser-head-btn"
            onClick={anyExpanded ? collapseAll : expandAll}
            title={anyExpanded ? "Collapse all folders" : "Expand all folders"}
            aria-label={
              anyExpanded ? "Collapse all folders" : "Expand all folders"
            }
          >
            {anyExpanded ? <Icon.FoldVertical /> : <Icon.UnfoldVertical />}
          </button>
          <div className="browser-head-add">
            <button
              type="button"
              className="browser-head-btn"
              onClick={() => setAddMenuOpen((v) => !v)}
              title="New plan or folder"
              aria-label="New plan or folder"
              aria-expanded={addMenuOpen}
            >
              <Icon.Plus />
            </button>
            {addMenuOpen && (
              <div
                className="browser-add-menu"
                role="menu"
                onMouseLeave={() => setAddMenuOpen(false)}
              >
                <button
                  type="button"
                  onClick={() => {
                    setCreating("plan");
                    setCreateError(null);
                    setAddMenuOpen(false);
                  }}
                >
                  New doc…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating("folder");
                    setCreateError(null);
                    setAddMenuOpen(false);
                  }}
                >
                  New folder…
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: empty-list clicks dismiss the transient add menu; no keyboard action is needed. */}
      <div
        className="browser-list"
        onClick={(e) => {
          // Click empty space inside the list area dismisses the
          // add-menu so it doesn't linger after the user changes their
          // mind.
          if (
            addMenuOpen &&
            (e.target as HTMLElement).closest(".browser-add-menu") === null
          ) {
            setAddMenuOpen(false);
          }
        }}
      >
        {creating && (
          <CreateRow
            kind={creating}
            parentLabel={activeCreateParent() || "(root)"}
            error={createError}
            onCommit={(v) =>
              creating === "plan" ? onCommitNewPlan(v) : onCommitNewFolder(v)
            }
            onCancel={onCancelCreate}
          />
        )}
        <div
          ref={treeRef}
          role="tree"
          aria-label="Documents"
          className="browser-tree"
          onKeyDown={onTreeKeyDown}
        >
          {resolvedPinnedPlans.length > 0 && (
            <PinnedGroup
              plans={resolvedPinnedPlans}
              open={pinnedGroupOpen}
              onToggleGroup={togglePinnedGroup}
              activeId={activeId}
              onSelect={onSelect}
              onPlanContextMenu={onPlanContextMenu}
              onPlanOpenInNewWindow={onOpenInNewWindow}
              changedPlans={changedPlans}
              activeNodeKey={activeNodeKey}
              setActiveNodeKey={setActiveNodeKey}
              setRowRef={setRowRef}
              rootSetSize={visibleTree.length + 1}
            />
          )}
          {renderNodes(visibleTree, {
            activeId,
            onSelect,
            isOpen,
            toggle,
            changedPlans,
            onPlanContextMenu,
            onPlanOpenInNewWindow: onOpenInNewWindow,
            onFolderContextMenu,
            renameTarget,
            renameError,
            onRenameCommit,
            onRenameCancel,
            draggingPath,
            dropTarget,
            onPlanDragStart,
            onPlanDragEnd,
            onFolderDragOver,
            onFolderDragLeave,
            onFolderDrop,
            onPlanRowDragOver,
            onPlanRowDragLeave,
            onPlanRowDrop,
            isPlanPinned,
            activeNodeKey,
            setActiveNodeKey,
            setRowRef,
            rootPosOffset: resolvedPinnedPlans.length > 0 ? 1 : 0,
            rootSetSize:
              visibleTree.length + (resolvedPinnedPlans.length > 0 ? 1 : 0),
          })}
        </div>
      </div>
      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          items={buildMenuItems(menu.plan)}
          onClose={() => setMenu(null)}
        />
      )}
      {folderMenu && (
        <ContextMenu
          anchor={folderMenu.anchor}
          items={buildFolderMenuItems(folderMenu.folder)}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </aside>
  );
}

interface RenderCtx {
  activeId: string;
  onSelect: (id: string) => void;
  isOpen: (folder: FolderNode) => boolean;
  toggle: (folder: FolderNode) => void;
  changedPlans: Map<string, ChangedPlan>;
  onPlanContextMenu: (plan: Plan, e: React.MouseEvent) => void;
  onPlanOpenInNewWindow: (plan: Plan) => void;
  onFolderContextMenu: (folder: FolderNode, e: React.MouseEvent) => void;
  renameTarget: string | null;
  renameError: string | null;
  onRenameCommit: (plan: Plan, value: string) => void;
  onRenameCancel: () => void;
  draggingPath: string | null;
  dropTarget: string | null;
  onPlanDragStart: (plan: Plan, e: React.DragEvent) => void;
  onPlanDragEnd: () => void;
  onFolderDragOver: (folder: FolderNode, e: React.DragEvent) => void;
  onFolderDragLeave: (folder: FolderNode, e: React.DragEvent) => void;
  onFolderDrop: (folder: FolderNode, e: React.DragEvent) => void;
  onPlanRowDragOver: (plan: Plan, e: React.DragEvent) => void;
  onPlanRowDragLeave: (plan: Plan, e: React.DragEvent) => void;
  onPlanRowDrop: (plan: Plan, e: React.DragEvent) => void;
  isPlanPinned: (planPath: string) => boolean;
  /** Roving-tabindex cursor — only the matching row is in the tab order. */
  activeNodeKey: string | null;
  setActiveNodeKey: (key: string) => void;
  setRowRef: (key: string) => (el: HTMLElement | null) => void;
  /** Root-level set size and offset so root-level rows can report
   *  aria-setsize / aria-posinset that include the synthetic Pinned
   *  group when present. */
  rootPosOffset: number;
  rootSetSize: number;
}

function renderNodes(
  nodes: TreeNode[],
  ctx: RenderCtx,
  level: number = 1,
  setSize?: number,
  posOffset: number = 0,
): ReactNode[] {
  const effectiveSetSize =
    setSize ?? (level === 1 ? ctx.rootSetSize : nodes.length);
  const effectivePosOffset = level === 1 ? ctx.rootPosOffset : posOffset;
  const out: ReactNode[] = [];
  nodes.forEach((n, i) => {
    const posInSet = i + 1 + effectivePosOffset;
    if (n.kind === "folder") {
      const open = ctx.isOpen(n);
      const count = countLeaves(n);
      const depth = Math.min(n.depth, MAX_DEPTH_CLASS);
      const label = n.depth === 0 ? n.name.toUpperCase() : n.name;
      const isDropTarget = ctx.dropTarget === n.path;
      const isActiveNode = ctx.activeNodeKey === n.path;
      out.push(
        <button
          key={`f:${n.path}`}
          type="button"
          ref={ctx.setRowRef(n.path)}
          role="treeitem"
          aria-expanded={open}
          aria-level={level}
          aria-setsize={effectiveSetSize}
          aria-posinset={posInSet}
          tabIndex={isActiveNode ? 0 : -1}
          className={[
            "tree-folder",
            `depth-${depth}`,
            folderBucketClass(n.name),
            open ? "open" : "",
            isDropTarget ? "drop-target" : "",
            isActiveNode ? "tree-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            ctx.setActiveNodeKey(n.path);
            ctx.toggle(n);
          }}
          onFocus={() => ctx.setActiveNodeKey(n.path)}
          onContextMenu={(e) => ctx.onFolderContextMenu(n, e)}
          onDragOver={(e) => ctx.onFolderDragOver(n, e)}
          onDragLeave={(e) => ctx.onFolderDragLeave(n, e)}
          onDrop={(e) => ctx.onFolderDrop(n, e)}
        >
          <span className="tree-caret" aria-hidden="true">
            <Icon.Caret />
          </span>
          {n.depth === 0 && <span className="bdot" />}
          <span className="tree-folder-label">{label}</span>
          <span className="tree-folder-count">{count}</span>
        </button>,
      );
      out.push(
        // biome-ignore lint/a11y/useSemanticElements: role=group is the correct child container inside the tree pattern.
        <div
          key={`fc:${n.path}`}
          className={`tree-children ${open ? "open" : ""}`}
          role="group"
          aria-hidden={!open}
        >
          <div className="tree-children-inner">
            {renderNodes(n.children, ctx, level + 1, n.children.length, 0)}
          </div>
        </div>,
      );
    } else {
      const p = n.plan;
      const pct = p.progress.total ? p.progress.done / p.progress.total : 0;
      const depth = Math.min(n.depth, MAX_DEPTH_CLASS);
      const isDragSource = ctx.draggingPath === p.path;
      const isDropTarget = ctx.dropTarget === p.path;
      const classes = [
        "document-row",
        `tree-depth-${depth}`,
        p.id === ctx.activeId && "active",
        // Use bucket for the "shipped" fade now that status is
        // optional — archived plans get muted titles regardless of
        // whether their frontmatter declares a status.
        p.bucket === "archive" && "shipped",
        `bucket-${p.bucket}`,
        isDragSource && "dragging",
        isDropTarget && "drop-target",
      ]
        .filter(Boolean)
        .join(" ");
      const changed = ctx.changedPlans.get(p.path);
      const changeTooltip = changed
        ? `${changed.addedCount} added, ${changed.removedCount} removed`
        : undefined;
      const isRenaming = ctx.renameTarget === p.path;
      const pinned = ctx.isPlanPinned(p.path);
      const isActiveNode = ctx.activeNodeKey === p.path;
      out.push(
        <PlanRow
          key={`p:${p.id}`}
          plan={p}
          classes={pinned ? `${classes} pinned` : classes}
          pct={pct}
          changed={changed}
          changeTooltip={changeTooltip}
          isRenaming={isRenaming}
          renameError={isRenaming ? ctx.renameError : null}
          pinned={pinned}
          rowRef={ctx.setRowRef(p.path)}
          tabIndex={isActiveNode ? 0 : -1}
          ariaLevel={level}
          ariaSetSize={effectiveSetSize}
          ariaPosInSet={posInSet}
          onClick={(e) => {
            ctx.setActiveNodeKey(p.path);
            // ⌘-click (or Ctrl on non-mac) opens in a new window — same
            // gesture as the browser/Finder convention for "duplicate
            // this view." Plain clicks select.
            if (e.metaKey || e.ctrlKey) {
              ctx.onPlanOpenInNewWindow(p);
            } else {
              ctx.onSelect(p.id);
            }
          }}
          onFocus={() => ctx.setActiveNodeKey(p.path)}
          onContextMenu={(e) => ctx.onPlanContextMenu(p, e)}
          onRenameCommit={(v) => ctx.onRenameCommit(p, v)}
          onRenameCancel={ctx.onRenameCancel}
          onDragStart={(e) => ctx.onPlanDragStart(p, e)}
          onDragEnd={ctx.onPlanDragEnd}
          onDragOver={(e) => ctx.onPlanRowDragOver(p, e)}
          onDragLeave={(e) => ctx.onPlanRowDragLeave(p, e)}
          onDrop={(e) => ctx.onPlanRowDrop(p, e)}
        />,
      );
    }
  });
  return out;
}

interface PinnedGroupProps {
  plans: Plan[];
  open: boolean;
  onToggleGroup: () => void;
  activeId: string;
  onSelect: (id: string) => void;
  onPlanContextMenu: (plan: Plan, e: React.MouseEvent) => void;
  onPlanOpenInNewWindow: (plan: Plan) => void;
  changedPlans: Map<string, ChangedPlan>;
  /** Tree-pattern wiring. */
  activeNodeKey: string | null;
  setActiveNodeKey: (key: string) => void;
  setRowRef: (key: string) => (el: HTMLElement | null) => void;
  /** Set size at the root level (this group + visible top-level nodes). */
  rootSetSize: number;
}

/** Renders the "Pinned" depth-0 group at the top of the document
 *  browser. Mirrors the existing tree-folder header treatment so the
 *  surface visually fits with the bucket headers below. Rows are
 *  rendered as plain (non-draggable) PlanRows — pinning is a
 *  surfacing aid, not a structural move. */
function PinnedGroup({
  plans,
  open,
  onToggleGroup,
  activeId,
  onSelect,
  onPlanContextMenu,
  onPlanOpenInNewWindow,
  changedPlans,
  activeNodeKey,
  setActiveNodeKey,
  setRowRef,
  rootSetSize,
}: PinnedGroupProps) {
  const isGroupActive = activeNodeKey === PINNED_GROUP_KEY;
  return (
    <>
      <button
        type="button"
        ref={setRowRef(PINNED_GROUP_KEY)}
        role="treeitem"
        aria-expanded={open}
        aria-level={1}
        aria-setsize={rootSetSize}
        aria-posinset={1}
        tabIndex={isGroupActive ? 0 : -1}
        className={[
          "tree-folder",
          "depth-0",
          "pinned-group",
          open ? "open" : "",
          isGroupActive ? "tree-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          setActiveNodeKey(PINNED_GROUP_KEY);
          onToggleGroup();
        }}
        onFocus={() => setActiveNodeKey(PINNED_GROUP_KEY)}
      >
        <span className="tree-caret" aria-hidden="true">
          <Icon.Caret />
        </span>
        <span className="bdot pinned" />
        <span className="tree-folder-label">PINNED</span>
        <span className="tree-folder-count">{plans.length}</span>
      </button>
      {/* biome-ignore lint/a11y/useSemanticElements: role=group is the correct child container inside the tree pattern. */}
      <div
        className={`tree-children ${open ? "open" : ""}`}
        role="group"
        aria-hidden={!open}
      >
        <div className="tree-children-inner">
          {plans.map((p, i) => {
            const pct = p.progress.total
              ? p.progress.done / p.progress.total
              : 0;
            const changed = changedPlans.get(p.path);
            const changeTooltip = changed
              ? `${changed.addedCount} added, ${changed.removedCount} removed`
              : undefined;
            const classes = [
              "document-row",
              "tree-depth-1",
              "pinned",
              p.id === activeId && "active",
              p.bucket === "archive" && "shipped",
              `bucket-${p.bucket}`,
            ]
              .filter(Boolean)
              .join(" ");
            const key = pinnedKey(p);
            const isActiveNode = activeNodeKey === key;
            return (
              <PlanRow
                key={`pinned:${p.id}`}
                plan={p}
                classes={classes}
                pct={pct}
                changed={changed}
                changeTooltip={changeTooltip}
                isRenaming={false}
                renameError={null}
                pinned={true}
                rowRef={setRowRef(key)}
                tabIndex={isActiveNode ? 0 : -1}
                ariaLevel={2}
                ariaSetSize={plans.length}
                ariaPosInSet={i + 1}
                onClick={(e) => {
                  setActiveNodeKey(key);
                  if (e.metaKey || e.ctrlKey) {
                    onPlanOpenInNewWindow(p);
                  } else {
                    onSelect(p.id);
                  }
                }}
                onFocus={() => setActiveNodeKey(key)}
                onContextMenu={(e) => onPlanContextMenu(p, e)}
                onRenameCommit={() => {}}
                onRenameCancel={() => {}}
                onDragStart={() => {}}
                onDragEnd={() => {}}
                onDragOver={() => {}}
                onDragLeave={() => {}}
                onDrop={() => {}}
                draggable={false}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

interface CreateRowProps {
  kind: "plan" | "folder";
  parentLabel: string;
  error: string | null;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** Inline row above the document tree for naming a new plan or
 *  folder. Auto-focuses on mount; Enter commits, Esc cancels, blur
 *  commits unless the input is empty (in which case it cancels so
 *  the row vanishes when the user clicks elsewhere). */
function CreateRow({
  kind,
  parentLabel,
  error,
  onCommit,
  onCancel,
}: CreateRowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const placeholder =
    kind === "plan" ? "new-plan (.md is added)" : "new-folder";
  return (
    <div className="document-create-row">
      <span className="document-create-prefix">
        {kind === "plan" ? "New plan" : "New folder"} in{" "}
        <code>{parentLabel}</code>
      </span>
      <input
        ref={inputRef}
        type="text"
        className={`pr-rename-input${error ? " has-error" : ""}`}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={(e) => {
          // Only commit on blur when the user actually typed something
          // — empty blur = cancel, so accidentally clicking outside
          // doesn't try to create an untitled file.
          if (e.currentTarget.value.trim()) {
            onCommit(e.currentTarget.value);
          } else {
            onCancel();
          }
        }}
      />
      {error && <span className="pr-rename-error">{error}</span>}
    </div>
  );
}

function countLeaves(node: FolderNode): number {
  let n = 0;
  for (const child of node.children) {
    if (child.kind === "plan") n += 1;
    else n += countLeaves(child);
  }
  return n;
}

interface PlanRowProps {
  plan: Plan;
  classes: string;
  pct: number;
  changed: ChangedPlan | undefined;
  changeTooltip: string | undefined;
  isRenaming: boolean;
  renameError: string | null;
  /** Drives the leading pin glyph in the title. The pin toggle itself
   *  lives in the right-click menu — there's no row-level button. */
  pinned: boolean;
  /** Tree-pattern attributes — supplied by renderNodes / PinnedGroup. */
  rowRef?: (el: HTMLElement | null) => void;
  tabIndex?: 0 | -1;
  ariaLevel?: number;
  ariaSetSize?: number;
  ariaPosInSet?: number;
  onClick: (e: React.MouseEvent) => void;
  onFocus?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  /** Plan rows in the Pinned group aren't draggable — the surface
   *  is purely a shortcut and reordering would imply moving the file. */
  draggable?: boolean;
}

function PlanRow({
  plan,
  classes,
  pct,
  changed,
  changeTooltip,
  isRenaming,
  renameError,
  pinned,
  rowRef,
  tabIndex,
  ariaLevel,
  ariaSetSize,
  ariaPosInSet,
  onClick,
  onFocus,
  onContextMenu,
  onRenameCommit,
  onRenameCancel,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  draggable = true,
}: PlanRowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Initial value for the rename input — strip `.md` so the user
  // edits the bare basename. The Rust side adds the extension back.
  const initial = basenameOf(plan.path).replace(/\.md$/i, "");

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  if (isRenaming) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: custom context menu is available on plan rows while renaming.
      <div className={`${classes} renaming`} onContextMenu={onContextMenu}>
        <span className="pr-mark" />
        <span className="pr-body">
          <input
            ref={inputRef}
            type="text"
            className={`pr-rename-input${renameError ? " has-error" : ""}`}
            defaultValue={initial}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRenameCommit(e.currentTarget.value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onRenameCancel();
              }
            }}
            onBlur={(e) => onRenameCommit(e.currentTarget.value)}
            // Stop the row's onClick / drag from interfering with text editing.
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {renameError && (
            <span className="pr-rename-error">{renameError}</span>
          )}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      ref={rowRef}
      role="treeitem"
      tabIndex={tabIndex}
      aria-level={ariaLevel}
      aria-setsize={ariaSetSize}
      aria-posinset={ariaPosInSet}
      className={classes}
      onClick={onClick}
      onFocus={onFocus}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="pr-mark" />
      <span className="pr-body">
        <span className="pr-title">
          {pinned && (
            <span className="pr-pin-glyph" title="Pinned">
              <Icon.Pin />
            </span>
          )}
          {plan.title}
          {changed && (
            <span className="pr-change-chip" title={changeTooltip}>
              M
            </span>
          )}
        </span>
        <span className="pr-meta">
          <span>{plan.modifiedAt}</span>
          <span className="pr-meta-sep">·</span>
          <span>
            {plan.progress.done}/{plan.progress.total}
          </span>
          <span className="pr-progress">
            <span
              className="pr-progress-bar"
              style={{ width: `${pct * 100}%` }}
            />
          </span>
        </span>
      </span>
    </button>
  );
}
