import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppCommands } from "./app/useAppCommands";
import { useOutlineState } from "./app/useOutlineState";
import { usePaneLayout } from "./app/usePaneLayout";
import { usePlanWorkspace } from "./app/usePlanWorkspace";
import { useViewerMutations } from "./app/useViewerMutations";
import { saveWindowState } from "./app/windowState";
import { BootFallback } from "./components/BootFallback";
import type { CommitSelection } from "./components/CommitHistoryRail";
import { DocumentBrowser } from "./components/DocumentBrowser";
import { GitOverlays } from "./components/GitOverlays";
import type { MarkdownEditorHandle } from "./components/MarkdownEditor";
import { OutlinePane } from "./components/OutlinePane";
import { Reader } from "./components/Reader";
import { TitleBar } from "./components/TitleBar";
import { UpdateAvailable } from "./components/UpdateAvailable";
import { WelcomeSplash } from "./components/WelcomeSplash";
import { WorkspaceConfigPrompt } from "./components/WorkspaceConfigPrompt";
import { ZenState } from "./components/ZenState";
import { useGitStatusContext } from "./hooks/gitStatusContext";
import { useBackgroundFetch } from "./hooks/useBackgroundFetch";
import { useCommitGraph } from "./hooks/useCommitGraph";
import { useBlame, useChangedPlans, useDiff } from "./hooks/useDiff";
import { useHasUncommittedChanges } from "./hooks/useHasUncommittedChanges";
import { ToastViewport, useToasts } from "./hooks/useToasts";
import { scrollBehavior } from "./lib/motion";
import { installUpdater, useUpdaterState } from "./lib/updater";
import { resolveRelativePath } from "./markdown/relativePath";
import type { FrontmatterLinkTarget } from "./markdown/render";
import {
  buildDiffReviewTabs,
  DOCS_REVIEW_TAB_ID,
  hasDiffReviewTab,
} from "./review/diffTabs";
import {
  type AppPaneFocus,
  focusTerminalCwdPane,
  initialTerminalCwdFollowState,
  requestTerminalCwd,
  shouldRequestCwdForDiffTargetChange,
  terminalCwdRepoHandle,
} from "./review/terminalCwdFollow";
import { TrustPromptHost } from "./security/TrustPrompt";
import { WorkspaceTrustProvider } from "./security/trust";
import { useApplyCss } from "./settings/applyCss";
import { useSettings } from "./settings/store";
import type { ChangedPlan } from "./tauri/api";
import {
  type Hunk,
  pickPlansRoot,
  pickSingleMarkdownFile,
  setWindowTitle,
  terminalResolveCwd,
} from "./tauri/api";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((mod) => ({
    default: mod.TerminalPane,
  })),
);
const DiffExplorerPane = lazy(() =>
  import("./components/DiffExplorerPane").then((mod) => ({
    default: mod.DiffExplorerPane,
  })),
);
const CommitHistoryPane = lazy(() =>
  import("./components/CommitHistoryPane").then((mod) => ({
    default: mod.CommitHistoryPane,
  })),
);
const QuickSwitch = lazy(() =>
  import("./search/QuickSwitch").then((mod) => ({ default: mod.QuickSwitch })),
);
const FindInProject = lazy(() =>
  import("./search/FindInProject").then((mod) => ({
    default: mod.FindInProject,
  })),
);
const DiffPopover = lazy(() =>
  import("./components/DiffPopover").then((mod) => ({
    default: mod.DiffPopover,
  })),
);
const CommitPopover = lazy(() =>
  import("./components/CommitPopover").then((mod) => ({
    default: mod.CommitPopover,
  })),
);
const TerminalSpike = lazy(() =>
  import("./components/TerminalSpike").then((mod) => ({
    default: mod.TerminalSpike,
  })),
);

const EMPTY_CHANGED_PLANS: Map<string, ChangedPlan> = new Map();

interface NavEntry {
  planId: string;
  headingId: string;
}

/** Climb past common "wrapper" directory names (docs, plans, doc) so
 *  ~/Sites/specrider/docs/plans, ~/Sites/specrider/docs, and
 *  ~/Sites/specrider/plans all read as "specrider" in the OS title. */
function projectNameFromPath(root: string | null): string | null {
  if (!root) return null;
  const segments = root
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .filter(Boolean);
  if (segments.length === 0) return null;
  const wrappers = new Set(["plans", "docs", "doc"]);
  let i = segments.length - 1;
  // Walk up while the current segment is a wrapper *and* there's a
  // parent to fall back on.
  while (i > 0 && wrappers.has(segments[i])) i--;
  return segments[i];
}

function EmptyDocumentPane() {
  return (
    <main
      className="pane reader reader-empty"
      id="document"
      aria-label="Document"
    >
      <div className="reader-head">
        <span className="rh-path">
          <span className="seg-end">No document selected</span>
        </span>
        <span className="rh-spacer" />
      </div>
      <div className="reader-empty-body" aria-hidden="true" />
    </main>
  );
}

function App() {
  const {
    effective: settings,
    customThemes,
    loaded: settingsLoaded,
    update: updateSetting,
  } = useSettings();
  useApplyCss(settings, customThemes);
  const gitStatus = useGitStatusContext();
  useBackgroundFetch(settings.gitFetchIntervalSecs);
  const { push: pushToast } = useToasts();

  const updaterState = useUpdaterState();
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const openUpdateModal = useCallback(() => setUpdateModalOpen(true), []);
  const closeUpdateModal = useCallback(() => setUpdateModalOpen(false), []);

  // Wire the updater on first mount. Role detection inside the module
  // decides whether this window is the source of truth (main) or a
  // passive listener (window-*). Settings has its own install call.
  // We re-install if checkForUpdatesOnLaunch flips because the 30s
  // timer is keyed on that flag at install time — the module is
  // idempotent for repeated installs after a teardown.
  useEffect(() => {
    let teardown: (() => void) | null = null;
    void installUpdater({
      checkOnLaunch: settings.checkForUpdatesOnLaunch,
    }).then((fn) => {
      teardown = fn;
    });
    return () => {
      if (teardown) teardown();
    };
  }, [settings.checkForUpdatesOnLaunch]);

  const {
    actionSplitRatio,
    actionVerticalRatio,
    anyActionOpen,
    bothActionOpen,
    browserVisible,
    diffPaneHasOpened,
    diffPaneOpen,
    leftPaneClamp,
    outlineVisible,
    paneWidths,
    persistedActivePlanPath,
    readerVisible,
    rightPaneClamp,
    rightRailMode,
    setDiffPaneOpen,
    setReaderVisible,
    setRightRailMode,
    setTerminalPaneOpen,
    startActionVerticalResize,
    startCenterResize,
    startPaneResize,
    terminalPaneHasOpened,
    terminalPaneOpen,
    toggleBrowserPane,
    toggleOutlinePane,
    zenStateActive,
    zenStateRun,
    onActionVerticalSplitterKey,
    onCenterSplitterKey,
    onPaneSplitterKey,
  } = usePaneLayout();

  const {
    activeHeading,
    activeId,
    activePlan,
    ast,
    mode,
    outline,
    planForView,
    plans,
    plansRoot,
    plansRootLoaded,
    progress,
    rawMd,
    rawMdOwnerRef,
    workspaceConfigKey,
    workspaceRepos,
    setActiveHeading,
    setActiveId,
    setMode,
    setParseSource,
    setRawMd,
  } = usePlanWorkspace({
    defaultReaderMode: settings.defaultReaderMode,
    persistedActivePlanPath,
    planTitleSource: settings.planTitleSource,
    settingsLoaded,
  });

  // Browser-style navigation history. Cross-plan navigations
  // (link clicks, document-row clicks) push the current entry onto `back`
  // and clear `forward`. Outline / heading jumps within the same plan
  // don't push — too noisy.
  const [navBack, setNavBack] = useState<NavEntry[]>([]);
  const [navForward, setNavForward] = useState<NavEntry[]>([]);

  // Change-awareness state — diff for the active plan, modified-plan
  // map for the browser chip, popover anchor for the inline diff, and
  // a cursor through hunks for next/prev navigation. The setting gates
  // both the data fetch (cheap-but-still-pointless if off) and every
  // consumer below.
  const showChanges = settings.showChangeIndicators;
  const rawDiff = useDiff(showChanges && activeId ? activeId : null);
  const rawChangedPlans = useChangedPlans();
  const diff = showChanges
    ? rawDiff
    : { added: [], modified: [], deletedAfter: [], hunks: [] };
  const changedPlans = showChanges ? rawChangedPlans : EMPTY_CHANGED_PLANS;
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const [popover, setPopover] = useState<{
    hunk: Hunk;
    anchor: { left: number; top: number } | null;
  } | null>(null);
  const hunkCursorRef = useRef(0);

  // Per-line blame — gated on the persisted setting AND a session-only
  // override (`⌘⇧B`) so the user can flip it on for the current run
  // without persisting the choice. The hook itself no-ops when
  // `blameEnabled` is false, so the heavier `git blame` shell-out only
  // runs when the user has actually opted in.
  const [blameSessionOverride, setBlameSessionOverride] = useState<
    boolean | null
  >(null);
  const blameEnabled = blameSessionOverride ?? settings.showLineBlame;
  const blame = useBlame(activeId || null, blameEnabled);
  const [commitPopover, setCommitPopover] = useState<{
    sha: string;
    anchor: { left: number; top: number } | null;
  } | null>(null);
  const onBlameShaClick = useCallback((sha: string) => {
    setCommitPopover({
      sha,
      anchor: {
        left: window.innerWidth / 2 - 230,
        top: window.innerHeight / 2 - 160,
      },
    });
  }, []);

  // Reset hunk cursor when active plan changes.
  useEffect(() => {
    hunkCursorRef.current = 0;
    setPopover(null);
    setCommitPopover(null);
  }, []);

  // Persist the selected document per window.
  useEffect(() => {
    saveWindowState({ activePlanPath: activeId || null });
  }, [activeId]);

  // Search surfaces — ⌘T (quick switch), ⌘F (find in doc, Read mode
  // only; Markdown mode hands off to CodeMirror's built-in find), and
  // ⌘⇧F (find across the whole project).
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [quickSwitchHasOpened, setQuickSwitchHasOpened] = useState(false);
  const [terminalSpikeOpen, setTerminalSpikeOpen] = useState(false);

  // Selected commit row in the diff explorer's history rail. null
  // until the user clicks a row.
  const [diffSelection, setDiffSelection] = useState<CommitSelection | null>(
    null,
  );
  const [activeDiffTabId, setActiveDiffTabId] =
    useState<string>(DOCS_REVIEW_TAB_ID);
  const [terminalCwdFollow, setTerminalCwdFollow] = useState(
    initialTerminalCwdFollowState,
  );
  const markPaneFocus = useCallback((pane: AppPaneFocus) => {
    setTerminalCwdFollow((state) => focusTerminalCwdPane(state, pane));
  }, []);
  useEffect(() => {
    const paneForTarget = (target: EventTarget | null): AppPaneFocus | null => {
      if (!(target instanceof Element)) return null;
      if (target.closest(".terminal-pane")) return "terminal";
      if (target.closest(".diff-explorer-pane")) return "diff";
      if (target.closest(".outline-mode-commits")) return "diff";
      if (target.closest(".pane.outline")) return "reader";
      if (target.closest(".pane.reader")) return "reader";
      return null;
    };
    const onPaneEvent = (event: Event) => {
      const pane = paneForTarget(event.target);
      if (pane) markPaneFocus(pane);
    };
    document.addEventListener("focusin", onPaneEvent);
    document.addEventListener("click", onPaneEvent);
    return () => {
      document.removeEventListener("focusin", onPaneEvent);
      document.removeEventListener("click", onPaneEvent);
    };
  }, [markPaneFocus]);

  const [findOpen, setFindOpen] = useState(false);
  const [findInitialQuery, setFindInitialQuery] = useState<string | undefined>(
    undefined,
  );
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  // ⌘F-driven find scoped to the diff explorer pane. Lifted to App
  // because the global keybinding handler down below decides which
  // surface owns the chord based on focus.
  const [diffFindOpen, setDiffFindOpen] = useState(false);
  const [projectSearchHasOpened, setProjectSearchHasOpened] = useState(false);

  useEffect(() => {
    if (quickSwitchOpen) setQuickSwitchHasOpened(true);
  }, [quickSwitchOpen]);

  useEffect(() => {
    if (projectSearchOpen) setProjectSearchHasOpened(true);
  }, [projectSearchOpen]);

  // Home dir for tilde-substituting paths in the title bar. Async one-shot.
  const [home, setHome] = useState<string>("");
  useEffect(() => {
    homeDir()
      .then((p) => setHome(p))
      .catch((e) => console.error("homeDir failed:", e));
  }, []);

  const diffReviewTabs = useMemo(
    () =>
      buildDiffReviewTabs(planForView?.linkedRepoLinks ?? [], {
        plansRoot,
        workspaceRepos,
      }),
    [planForView?.linkedRepoLinks, plansRoot, workspaceRepos],
  );
  const activeDiffTab = useMemo(
    () =>
      diffReviewTabs.find((tab) => tab.id === activeDiffTabId) ??
      diffReviewTabs[0],
    [diffReviewTabs, activeDiffTabId],
  );
  const activeDiffRepoHandle =
    activeDiffTab?.kind === "linked" ? activeDiffTab.repo : null;
  const activeDiffReviewBranch =
    activeDiffTab?.kind === "linked" ? activeDiffTab.branch : null;
  const activeDiffReviewBase =
    activeDiffTab?.kind === "linked" ? activeDiffTab.base : null;
  const activeDiffReadOnly = activeDiffTab?.kind === "linked";
  const previousActiveDiffRepoHandleRef = useRef<string | null>(
    activeDiffRepoHandle,
  );
  useEffect(() => {
    if (previousActiveDiffRepoHandleRef.current === activeDiffRepoHandle) {
      return;
    }
    previousActiveDiffRepoHandleRef.current = activeDiffRepoHandle;
    setTerminalCwdFollow((state) =>
      shouldRequestCwdForDiffTargetChange(state)
        ? requestTerminalCwd(state)
        : state,
    );
  }, [activeDiffRepoHandle]);
  const terminalCwdRepo = terminalCwdRepoHandle(
    terminalCwdFollow,
    activeDiffRepoHandle,
  );
  const terminalCwdResolutionKey = `${plansRoot ?? ""}\n${
    terminalCwdRepo ?? "self"
  }`;
  const [terminalCwdTarget, setTerminalCwdTarget] = useState<{
    key: string;
    cwd: string;
  }>(() => ({
    key: "",
    cwd: "",
  }));
  useEffect(() => {
    if (!plansRoot) {
      setTerminalCwdTarget({ key: terminalCwdResolutionKey, cwd: "" });
      return;
    }
    let cancelled = false;
    terminalResolveCwd({
      plansRoot,
      repoHandle: terminalCwdRepo,
    })
      .then((payload) => {
        if (!cancelled) {
          setTerminalCwdTarget({
            key: terminalCwdResolutionKey,
            cwd: payload.cwd,
          });
        }
      })
      .catch((e) => {
        console.error("terminal_resolve_cwd failed:", e);
        if (!cancelled && terminalCwdRepo == null) {
          setTerminalCwdTarget({
            key: terminalCwdResolutionKey,
            cwd: plansRoot,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [plansRoot, terminalCwdRepo, terminalCwdResolutionKey]);
  const terminalCwdResolved =
    terminalCwdTarget.key === terminalCwdResolutionKey
      ? terminalCwdTarget.cwd
      : (plansRoot ?? "");
  const terminalCwdRequest =
    terminalCwdTarget.key === terminalCwdResolutionKey
      ? {
          seq: terminalCwdFollow.requestSeq,
          cwd: terminalCwdTarget.cwd,
        }
      : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the active review tab when the active plan changes.
  useEffect(() => {
    setActiveDiffTabId(DOCS_REVIEW_TAB_ID);
    setDiffSelection(null);
  }, [planForView?.id]);
  useEffect(() => {
    if (!hasDiffReviewTab(diffReviewTabs, activeDiffTabId)) {
      setActiveDiffTabId(DOCS_REVIEW_TAB_ID);
      setDiffSelection(null);
    }
  }, [diffReviewTabs, activeDiffTabId]);

  // Full-repo commit graph for the diff explorer rail. It is deliberately
  // lazy: `git log --all` is useful when the diff pane or commit rail is
  // visible, but it should not compete with initial workspace paint.
  const commitHistoryEnabled = diffPaneOpen || rightRailMode === "commits";
  const commitHistory = useCommitGraph({
    planRel: activeDiffReadOnly ? null : (planForView?.path ?? null),
    branches: activeDiffReadOnly ? [] : (planForView?.gitBranches ?? []),
    commitShas: activeDiffReadOnly ? [] : (planForView?.gitCommits ?? []),
    repoHandle: activeDiffRepoHandle,
    reviewBranch: activeDiffReviewBranch,
    reviewBase: activeDiffReviewBase,
    enabled: commitHistoryEnabled,
  });
  const repoHasUncommitted = useHasUncommittedChanges(
    commitHistoryEnabled,
    activeDiffRepoHandle,
  );

  // Seed the diff explorer's selection so the body never opens blank.
  // Prefers Uncommitted changes when present, otherwise the newest
  // commit. The repo-dirtiness signal is async, so skip while it's
  // still null — otherwise we'd race-pick "newest commit" before the
  // truthy answer arrives, and the early-return below would lock us in.
  useEffect(() => {
    if (!diffPaneOpen) return;
    if (diffSelection !== null) return;
    if (repoHasUncommitted === null) return;
    if (repoHasUncommitted) {
      setDiffSelection({ kind: "unstaged" });
    } else if (commitHistory.commits.length > 0) {
      setDiffSelection({
        kind: "commit",
        sha: commitHistory.commits[0].sha,
      });
    }
  }, [diffPaneOpen, diffSelection, repoHasUncommitted, commitHistory.commits]);

  const handleCommitHistorySelect = useCallback(
    (sel: CommitSelection) => {
      setDiffSelection(sel);
      setDiffPaneOpen(true);
    },
    [setDiffPaneOpen],
  );
  const handleDiffReviewTabSelect = useCallback((tabId: string) => {
    setActiveDiffTabId(tabId);
    setDiffSelection(null);
  }, []);
  const handleFrontmatterLinkClick = useCallback(
    (target: FrontmatterLinkTarget) => {
      const tab = diffReviewTabs.find(
        (candidate) =>
          candidate.kind === "linked" &&
          candidate.repo === target.repo &&
          candidate.branch === target.branch &&
          candidate.base === target.base,
      );
      if (!tab) {
        pushToast(
          `No linked review tab found for ${target.repo} @ ${target.branch}.`,
          { tone: "warn" },
        );
        return;
      }

      setActiveDiffTabId(tab.id);
      setDiffSelection(null);
      setRightRailMode("commits");
      setDiffPaneOpen(true);
      markPaneFocus("diff");
    },
    [
      diffReviewTabs,
      markPaneFocus,
      pushToast,
      setDiffPaneOpen,
      setRightRailMode,
    ],
  );

  const {
    ancestorChain,
    collapseHook,
    enclosingHeadingId,
    headingHierarchy,
    taskCollapsed,
    toggleTaskCollapse,
  } = useOutlineState(activeId, ast);

  const {
    insertTaskAfter,
    moveTaskBlock,
    removeTaskBlock,
    toggleTask,
    viewerRedo,
    viewerUndo,
  } = useViewerMutations({
    editorRef,
    mode,
    rawMd,
    rawMdOwnerRef,
    setMode,
    setParseSource,
    setRawMd,
  });

  const onJump = useCallback(
    (id: string, sourceLine?: number) => {
      // Editor (edit + split): scroll source. Preview (read + split):
      // scroll the rendered DOM. Mode is NEVER changed by an outline
      // click — the user picked the mode for a reason.
      if ((mode === "edit" || mode === "split") && sourceLine != null) {
        editorRef.current?.scrollToLine(sourceLine, {
          placeCursor: "lineStart",
        });
      }
      if (mode === "read" || mode === "split") {
        // If the target (or any ancestor) is collapsed, expanding before
        // the scroll lands ensures the heading actually exists in the DOM.
        collapseHook.expandIds(ancestorChain(id));
        requestAnimationFrame(() => {
          const el = document.getElementById(id);
          if (el) {
            el.scrollIntoView({
              behavior: mode === "split" ? "instant" : scrollBehavior(),
              block: "start",
            });
            setActiveHeading(id);
            el.classList.add("flash");
            window.setTimeout(() => el.classList.remove("flash"), 700);
          }
        });
      } else {
        // Edit-only mode: still update the active-heading model so the
        // outline highlight tracks the click.
        setActiveHeading(id);
      }
    },
    [mode, collapseHook, ancestorChain, setActiveHeading],
  );

  // Cross-plan navigation: pushes the current spot onto the back
  // stack and clears the forward stack (browser convention).
  const navigateToPlan = useCallback(
    (planId: string, headingId: string = "") => {
      if (activeId) {
        setNavBack((b) => [
          ...b,
          { planId: activeId, headingId: activeHeading },
        ]);
        setNavForward([]);
      }
      setActiveId(planId);
      setActiveHeading(headingId);
    },
    [activeId, activeHeading, setActiveId, setActiveHeading],
  );

  const goBack = useCallback(() => {
    setNavBack((b) => {
      if (b.length === 0) return b;
      const prev = b[b.length - 1];
      setNavForward((f) => [
        ...f,
        { planId: activeId, headingId: activeHeading },
      ]);
      setActiveId(prev.planId);
      setActiveHeading(prev.headingId);
      if (prev.headingId) {
        window.setTimeout(() => {
          const el = document.getElementById(prev.headingId);
          if (el)
            el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        }, 120);
      }
      return b.slice(0, -1);
    });
  }, [activeId, activeHeading, setActiveId, setActiveHeading]);

  const goForward = useCallback(() => {
    setNavForward((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setNavBack((b) => [...b, { planId: activeId, headingId: activeHeading }]);
      setActiveId(next.planId);
      setActiveHeading(next.headingId);
      if (next.headingId) {
        window.setTimeout(() => {
          const el = document.getElementById(next.headingId);
          if (el)
            el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        }, 120);
      }
      return f.slice(0, -1);
    });
  }, [activeId, activeHeading, setActiveId, setActiveHeading]);

  const onLinkClick = useCallback(
    (href: string) => {
      // Hash-only — scroll within current doc. The user clicked a
      // link inside the rendered preview, so the preview is visible
      // in whatever mode they're in (read or split). Don't force a
      // mode switch — that would yank the editor away in split mode.
      if (href.startsWith("#")) {
        const id = href.slice(1);
        if (mode === "edit") setMode("read");
        requestAnimationFrame(() => {
          const el = document.getElementById(id);
          if (el) {
            el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
            setActiveHeading(id);
          }
        });
        return;
      }
      // External URL — anything with a scheme that isn't a relative path
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        openUrl(href).catch((e) => console.error("openUrl:", e));
        return;
      }
      // Relative .md file (with optional anchor)
      if (/\.md(?:#.*)?$/i.test(href) && activePlan) {
        const [pathPart, hash] = href.split("#");
        const resolved = resolveRelativePath(activePlan.path, pathPart);
        if (!resolved) return;
        const target =
          plans.find((p) => p.path === resolved) ??
          plans.find(
            (p) =>
              p.path.replace(/\.md$/i, "") === resolved.replace(/\.md$/i, ""),
          ) ??
          // Fallback: match by basename (covers "foo.md" referenced from a
          // sibling directory the doc author got wrong)
          plans.find(
            (p) => p.path.split("/").pop() === resolved.split("/").pop(),
          );
        if (!target) {
          console.warn("link target not found:", resolved);
          return;
        }
        navigateToPlan(target.id, hash ?? "");
        if (hash) {
          window.setTimeout(() => {
            const el = document.getElementById(hash);
            if (el)
              el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
          }, 120);
        }
      }
    },
    [activePlan, plans, mode, navigateToPlan, setActiveHeading, setMode],
  );

  const onJumpToTask = useCallback(
    (line: number) => {
      if (mode === "edit" || mode === "split") {
        editorRef.current?.scrollToLine(line, {
          placeCursor: "afterTaskMarker",
        });
      }
      if (mode === "read" || mode === "split") {
        const enclosing = enclosingHeadingId(line);
        if (enclosing) collapseHook.expandIds(ancestorChain(enclosing));
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(
            `[data-task-line="${line}"]`,
          );
          if (!el) return;
          el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
          el.classList.add("flash");
          window.setTimeout(() => el.classList.remove("flash"), 700);
        });
      }
    },
    [mode, enclosingHeadingId, ancestorChain, collapseHook],
  );

  /** Reveals a 1-based source line in whichever view is active. In
   *  Read mode, finds the block whose source range contains the line
   *  and scrolls there. In Markdown mode, defers to the editor's
   *  imperative `scrollToLine`. In Split mode, drives both. */
  const onJumpToLine = useCallback(
    (line: number) => {
      if (mode === "edit" || mode === "split") {
        editorRef.current?.scrollToLine(line, { placeCursor: "lineStart" });
      }
      if (mode === "read" || mode === "split") {
        const enclosing = enclosingHeadingId(line);
        if (enclosing) collapseHook.expandIds(ancestorChain(enclosing));
        requestAnimationFrame(() => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>("[data-source-start-line]"),
          );
          let best: HTMLElement | null = null;
          for (const el of candidates) {
            const start = Number(el.dataset.sourceStartLine ?? "0");
            const end = Number(el.dataset.sourceEndLine ?? "0");
            if (start <= line && end >= line) {
              best = el;
              break;
            }
            if (start > line) break;
            best = el;
          }
          if (!best) return;
          best.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
          best.classList.add("flash");
          window.setTimeout(() => best?.classList.remove("flash"), 700);
        });
      }
    },
    [mode, enclosingHeadingId, ancestorChain, collapseHook],
  );

  /** Returns the hunk hierarchy sorted by `newStart`. Ties broken by
   *  insertion order, which `parse_hunks` preserves naturally. */
  const sortedHunks = useMemo(() => {
    return [...diff.hunks].sort((a, b) => a.newStart - b.newStart);
  }, [diff]);

  // Reset hunk cursor whenever the active plan changes — otherwise an
  // index from the previous plan carries over and the next ⌘⇧J lands
  // on a non-obvious starting hunk.
  useEffect(() => {
    hunkCursorRef.current = -1;
  }, []);

  const cycleHunk = useCallback(
    (direction: 1 | -1) => {
      if (sortedHunks.length === 0) return;
      const idx = hunkCursorRef.current;
      // First call after a plan switch (idx = -1) lands on hunk 0
      // when going forward, or the last hunk going backward — instead
      // of skipping the natural starting point.
      const next =
        idx < 0
          ? direction === 1
            ? 0
            : sortedHunks.length - 1
          : (idx + direction + sortedHunks.length) % sortedHunks.length;
      hunkCursorRef.current = next;
      const hunk = sortedHunks[next];
      // Pure-deletion hunks have `newLines === 0` and `newStart`
      // points at the line *before* the deletion (the marker renders
      // between `newStart` and `newStart + 1`). Jumping the cursor to
      // `newStart` lands on an unchanged line with no gutter. Use
      // `newStart + 1` for deletions so the user lands on the line
      // directly below the deletion marker — visually adjacent and
      // unambiguous. Pure additions and modifications still target
      // `newStart`, the first changed line.
      const targetLine =
        hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
      onJumpToLine(targetLine);
    },
    [sortedHunks, onJumpToLine],
  );

  const togglePopoverForCurrentHunk = useCallback(() => {
    if (popover) {
      setPopover(null);
      return;
    }
    if (sortedHunks.length === 0) return;
    const hunk = sortedHunks[hunkCursorRef.current % sortedHunks.length];
    setPopover({
      hunk,
      anchor: {
        left: window.innerWidth / 2 - 240,
        top: window.innerHeight / 2 - 120,
      },
    });
  }, [popover, sortedHunks]);

  const onSelectPlan = useCallback(
    (id: string) => {
      if (id === activeId) return;
      navigateToPlan(id, "");
    },
    [activeId, navigateToPlan],
  );

  // Brand-new doc just landed from "New doc…" / "New doc here…".
  // Select it (using the same nav path as a click) and force split
  // mode so the user lands in the editor with the rendered preview
  // alongside — the writer-friendly default for fresh files.
  const onCreatePlan = useCallback(
    (id: string) => {
      navigateToPlan(id, "");
      setMode("split");
    },
    [navigateToPlan, setMode],
  );

  // ⌘⇧F handoff: picked a hit in the project-search palette → switch
  // to that plan in Read mode and open the in-doc find bar pre-filled
  // with the same query so all matches glow and the user can step
  // through them. The line number is currently informational only;
  // the in-doc find auto-scrolls to the first match in document order.
  const onSelectProjectHit = useCallback(
    (planId: string, _line: number, query: string) => {
      if (planId !== activeId) navigateToPlan(planId, "");
      setMode("read");
      setFindInitialQuery(query);
      setFindOpen(true);
    },
    [activeId, navigateToPlan, setMode],
  );

  // Zoom: bumps reader prose (bodySize) and code/terminal (monoSize)
  // together — the two sizes that show up inside the reader/editor.
  // UI chrome (titlebar, plans browser, outline) stays put, so the app
  // doesn't reflow when you're just trying to read more comfortably.
  // Reset writes null so settings revert to DEFAULTS.
  const applyZoom = useCallback(
    (delta: number | "reset") => {
      if (delta === "reset") {
        void updateSetting("bodySize", null);
        void updateSetting("monoSize", null);
        return;
      }
      const clamp = (n: number) => Math.max(10, Math.min(22, n));
      void updateSetting("bodySize", clamp(settings.bodySize + delta));
      void updateSetting("monoSize", clamp(settings.monoSize + delta));
    },
    [updateSetting, settings.bodySize, settings.monoSize],
  );

  useAppCommands({
    applyZoom,
    collapseHook,
    cycleHunk,
    diffPaneOpen,
    goBack,
    goForward,
    headingHierarchy,
    mode,
    pushToast,
    setBlameSessionOverride,
    setDiffFindOpen,
    setDiffPaneOpen,
    setDiffSelection,
    setFindInitialQuery,
    setFindOpen,
    setMode,
    setProjectSearchOpen,
    setQuickSwitchOpen,
    setTerminalPaneOpen,
    setTerminalSpikeOpen,
    setUpdateModalOpen,
    showLineBlame: settings.showLineBlame,
    togglePopoverForCurrentHunk,
    viewerRedo,
    viewerUndo,
  });

  // Keep the OS window title in sync with the active project so ⌘Tab,
  // Mission Control, and Stage Manager show meaningful labels per
  // window. The project dir alone is enough — no "SpecRider —" prefix
  // needed since the dock/app icon already identifies the app.
  useEffect(() => {
    const project = projectNameFromPath(plansRoot);
    const title = project ?? "SpecRider";
    setWindowTitle(title).catch((e) =>
      console.error("setWindowTitle failed:", e),
    );
  }, [plansRoot]);

  const choosePlansRoot = useCallback(() => {
    void pickPlansRoot().catch((e) => console.error("pickPlansRoot:", e));
  }, []);

  const chooseSingleFile = useCallback(() => {
    void pickSingleMarkdownFile().catch((e) =>
      console.error("pickSingleMarkdownFile:", e),
    );
  }, []);

  const openProjectSearch = useCallback(() => {
    setProjectSearchOpen(true);
  }, []);

  const toggleReaderVisible = useCallback(() => {
    setReaderVisible((v) => !v);
  }, [setReaderVisible]);

  const toggleTerminalPane = useCallback(() => {
    setTerminalPaneOpen((v) => !v);
  }, [setTerminalPaneOpen]);

  const toggleDiffPane = useCallback(() => {
    setDiffPaneOpen((v) => !v);
  }, [setDiffPaneOpen]);

  const closeReaderFind = useCallback(() => {
    setFindOpen(false);
    setFindInitialQuery(undefined);
  }, []);

  const closeTerminalPane = useCallback(() => {
    setTerminalPaneOpen(false);
  }, [setTerminalPaneOpen]);

  const closeDiffFind = useCallback(() => {
    setDiffFindOpen(false);
  }, []);

  const closeDiffPane = useCallback(() => {
    setDiffPaneOpen(false);
    setDiffFindOpen(false);
  }, [setDiffPaneOpen]);

  const showOutlineRail = useCallback(() => {
    setRightRailMode("outline");
    markPaneFocus("reader");
  }, [markPaneFocus, setRightRailMode]);

  const showCommitRail = useCallback(() => {
    setRightRailMode("commits");
    markPaneFocus("diff");
  }, [markPaneFocus, setRightRailMode]);

  const openUncommittedChanges = useCallback(() => {
    setDiffPaneOpen(true);
    setDiffSelection({ kind: "unstaged" });
  }, [setDiffPaneOpen]);

  const closeQuickSwitch = useCallback(() => {
    setQuickSwitchOpen(false);
  }, []);

  const closeProjectSearch = useCallback(() => {
    setProjectSearchOpen(false);
  }, []);

  const closePopover = useCallback(() => {
    setPopover(null);
  }, []);

  const closeCommitPopover = useCallback(() => {
    setCommitPopover(null);
  }, []);

  const closeTerminalSpike = useCallback(() => {
    setTerminalSpikeOpen(false);
  }, []);

  if (!plansRootLoaded) {
    return <BootFallback />;
  }

  if (!plansRoot) {
    return (
      <WelcomeSplash
        onChooseFolder={choosePlansRoot}
        onChooseFile={chooseSingleFile}
      />
    );
  }

  return (
    <WorkspaceTrustProvider
      plansRoot={plansRoot}
      defaultPolicy={settings.defaultTrustPolicy}
      workspaceConfigKey={workspaceConfigKey}
    >
      <div className="app">
        <a className="skip-link" href="#document">
          Skip to document
        </a>
        <TitleBar
          plansRoot={plansRoot}
          homeDir={home}
          settings={settings}
          browserVisible={browserVisible}
          outlineVisible={outlineVisible}
          markdownOpen={readerVisible}
          terminalOpen={terminalPaneOpen}
          diffOpen={diffPaneOpen}
          onToggleBrowser={toggleBrowserPane}
          onOpenSearch={openProjectSearch}
          onToggleOutline={toggleOutlinePane}
          onToggleMarkdown={toggleReaderVisible}
          onToggleTerminal={toggleTerminalPane}
          onToggleDiff={toggleDiffPane}
          onOpenUncommitted={openUncommittedChanges}
          onOpenUpdate={openUpdateModal}
        />
        <GitOverlays onOpenPlan={onSelectPlan} />
        <WorkspaceConfigPrompt plansRoot={plansRoot} />
        {updateModalOpen && updaterState.update && (
          <UpdateAvailable state={updaterState} onClose={closeUpdateModal} />
        )}
        <div
          className={[
            "panes",
            !browserVisible && "left-pane-hidden",
            !outlineVisible && "right-pane-hidden",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            gridTemplateColumns: `${
              browserVisible ? paneWidths.left : 0
            }px ${browserVisible ? 6 : 0}px 1fr ${
              outlineVisible ? 6 : 0
            }px ${outlineVisible ? paneWidths.right : 0}px`,
          }}
        >
          <DocumentBrowser
            plans={plans}
            activeId={activeId}
            onSelect={onSelectPlan}
            onCreate={onCreatePlan}
            changedPlans={changedPlans}
          />
          <hr
            className="splitter splitter-left"
            onMouseDown={startPaneResize("left")}
            onKeyDown={onPaneSplitterKey("left")}
            aria-label="Resize plans pane"
            aria-orientation="vertical"
            aria-valuemin={leftPaneClamp.min}
            aria-valuemax={leftPaneClamp.max}
            aria-valuenow={paneWidths.left}
            tabIndex={browserVisible ? 0 : -1}
          />
          <div
            className={[
              "middle-stack",
              anyActionOpen && "with-action",
              !readerVisible && "reader-hidden",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              // Always 3 grid tracks so panes can transition their width
              // smoothly. Reader is col 1, splitter col 2, action panes
              // col 3. Each track collapses to 0 when its pane is hidden.
              gridTemplateColumns: `${
                !readerVisible
                  ? "0px"
                  : anyActionOpen
                    ? `${actionSplitRatio * 100}%`
                    : "1fr"
              } ${readerVisible && anyActionOpen ? "6px" : "0px"} ${
                anyActionOpen ? "1fr" : "0px"
              }`,
            }}
          >
            {planForView ? (
              <Reader
                plan={planForView}
                ast={ast}
                setActiveHeading={setActiveHeading}
                toggleTask={toggleTask}
                onMoveTaskBlock={moveTaskBlock}
                onInsertTaskAfter={insertTaskAfter}
                onRemoveTaskBlock={removeTaskBlock}
                onLinkClick={onLinkClick}
                onFrontmatterLinkClick={handleFrontmatterLinkClick}
                mode={mode}
                setMode={setMode}
                rawMd={rawMd}
                setRawMd={setRawMd}
                canGoBack={navBack.length > 0}
                canGoForward={navForward.length > 0}
                onGoBack={goBack}
                onGoForward={goForward}
                findOpen={findOpen}
                findInitialQuery={findInitialQuery}
                onCloseFind={closeReaderFind}
                diff={diff}
                blame={blame}
                blameEnabled={blameEnabled}
                onBlameShaClick={onBlameShaClick}
                collapsed={collapseHook.collapsed}
                onToggleSection={collapseHook.toggle}
                taskCollapsed={taskCollapsed}
                onToggleTaskCollapse={toggleTaskCollapse}
                editorRef={editorRef}
                plans={plans}
                conflicted={
                  !!gitStatus.status?.conflicts.some(
                    (c) => c.relToPlans === planForView.path,
                  )
                }
              />
            ) : (
              <EmptyDocumentPane />
            )}
            <hr
              className="splitter splitter-center"
              onMouseDown={startCenterResize}
              onKeyDown={onCenterSplitterKey}
              aria-orientation="vertical"
              aria-label="Resize action pane"
              aria-valuemin={20}
              aria-valuemax={85}
              aria-valuenow={Math.round(actionSplitRatio * 100)}
              tabIndex={anyActionOpen ? 0 : -1}
              aria-hidden={!anyActionOpen}
            />
            <div
              className={`action-column ${
                bothActionOpen ? "split-vertical" : ""
              }`}
              style={{
                gridTemplateRows: bothActionOpen
                  ? `${actionVerticalRatio * 100}% 6px 1fr`
                  : "1fr",
              }}
              aria-hidden={!anyActionOpen}
            >
              {terminalPaneHasOpened && (
                <Suspense fallback={null}>
                  <TerminalPane
                    open={terminalPaneOpen}
                    cwd={terminalCwdResolved}
                    cwdRequest={terminalCwdRequest}
                    initialAgent="shell"
                    onClose={closeTerminalPane}
                  />
                </Suspense>
              )}
              <hr
                className="splitter splitter-action-vertical"
                onMouseDown={startActionVerticalResize}
                onKeyDown={onActionVerticalSplitterKey}
                aria-orientation="horizontal"
                aria-label="Resize terminal / diff"
                aria-valuemin={20}
                aria-valuemax={85}
                aria-valuenow={Math.round(actionVerticalRatio * 100)}
                tabIndex={bothActionOpen ? 0 : -1}
                aria-hidden={!bothActionOpen}
              />
              {diffPaneHasOpened && (
                <Suspense fallback={null}>
                  <DiffExplorerPane
                    open={diffPaneOpen}
                    selection={diffSelection}
                    commits={commitHistory.commits}
                    repoHandle={activeDiffRepoHandle}
                    readOnly={activeDiffReadOnly}
                    findOpen={diffFindOpen && diffPaneOpen}
                    onCloseFind={closeDiffFind}
                    onClose={closeDiffPane}
                  />
                </Suspense>
              )}
            </div>
          </div>
          <hr
            className="splitter splitter-right"
            onMouseDown={startPaneResize("right")}
            onKeyDown={onPaneSplitterKey("right")}
            aria-label="Resize outline pane"
            aria-orientation="vertical"
            aria-valuemin={rightPaneClamp.min}
            aria-valuemax={rightPaneClamp.max}
            aria-valuenow={paneWidths.right}
            tabIndex={outlineVisible ? 0 : -1}
          />
          <aside className="right-rail" aria-label="Outline and commits">
            <div className="pane-tab-head">
              <div
                className="pane-tabs"
                role="tablist"
                aria-label="Right rail view"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightRailMode === "outline"}
                  tabIndex={rightRailMode === "outline" ? 0 : -1}
                  className={`pane-tab ${
                    rightRailMode === "outline" ? "on" : ""
                  }`}
                  onClick={showOutlineRail}
                >
                  Outline
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightRailMode === "commits"}
                  tabIndex={rightRailMode === "commits" ? 0 : -1}
                  className={`pane-tab ${
                    rightRailMode === "commits" ? "on" : ""
                  }`}
                  onClick={showCommitRail}
                >
                  Commits
                </button>
              </div>
            </div>
            {rightRailMode === "commits" ? (
              <Suspense fallback={null}>
                <CommitHistoryPane
                  commits={commitHistory.commits}
                  layout={commitHistory.layout}
                  derivedBySha={commitHistory.derivedBySha}
                  relevanceBySha={commitHistory.relevanceBySha}
                  refsByCommit={commitHistory.refsByCommit}
                  displayRefsByCommit={commitHistory.displayRefsByCommit}
                  loading={commitHistory.loading}
                  loaded={commitHistory.loaded}
                  error={commitHistory.error}
                  hasUnstaged={repoHasUncommitted ?? false}
                  selected={diffSelection}
                  onSelect={handleCommitHistorySelect}
                  onRefresh={commitHistory.refresh}
                  readOnly={activeDiffReadOnly}
                  repoHandle={activeDiffRepoHandle}
                  reviewBranch={activeDiffReviewBranch}
                  showLanes={settings.showCommitGraph}
                  settings={settings}
                  tabs={diffReviewTabs}
                  activeTabId={activeDiffTabId}
                  onSelectTab={handleDiffReviewTabSelect}
                />
              </Suspense>
            ) : (
              <OutlinePane
                outline={outline}
                progress={progress}
                activeHeading={activeHeading}
                planPath={planForView?.path ?? null}
                diff={diff}
                collapsed={collapseHook.collapsed}
                onToggleSection={collapseHook.toggle}
                taskCollapsed={taskCollapsed}
                onToggleTaskCollapse={toggleTaskCollapse}
                onJump={onJump}
                onJumpToTask={onJumpToTask}
                onJumpToListItem={onJumpToLine}
              />
            )}
          </aside>
          {zenStateActive && <ZenState key={zenStateRun} />}
        </div>
        {quickSwitchHasOpened && (
          <Suspense fallback={null}>
            <QuickSwitch
              open={quickSwitchOpen}
              plans={plans}
              onSelect={onSelectPlan}
              onClose={closeQuickSwitch}
            />
          </Suspense>
        )}
        {projectSearchHasOpened && (
          <Suspense fallback={null}>
            <FindInProject
              open={projectSearchOpen}
              plans={plans}
              onSelect={onSelectProjectHit}
              onClose={closeProjectSearch}
            />
          </Suspense>
        )}
        {popover && (
          <Suspense fallback={null}>
            <DiffPopover
              hunk={popover.hunk}
              anchor={popover.anchor}
              onClose={closePopover}
            />
          </Suspense>
        )}
        {commitPopover && (
          <Suspense fallback={null}>
            <CommitPopover
              sha={commitPopover.sha}
              anchor={commitPopover.anchor}
              onClose={closeCommitPopover}
            />
          </Suspense>
        )}
        {terminalSpikeOpen && (
          <Suspense fallback={null}>
            <TerminalSpike onClose={closeTerminalSpike} />
          </Suspense>
        )}
        <ToastViewport />
        <TrustPromptHost plansRoot={plansRoot} homeDir={home} />
      </div>
    </WorkspaceTrustProvider>
  );
}

export default App;
