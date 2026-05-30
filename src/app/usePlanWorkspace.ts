import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReaderMode } from "../components/Reader";
import { useDebounced } from "../hooks/useDebounced";
import { extractOutline, totalProgress } from "../markdown/outline";
import { parseMarkdown } from "../markdown/parse";
import {
  type MarkdownParseResult,
  parseInWorker,
} from "../markdown/parseInWorker";
import { planFromFile } from "../plans/build";
import { decideSaveSnapshot } from "../plans/saveGuard";
import type { PlanTitleSource } from "../settings/types";
import {
  analyzePlans,
  getInitialState,
  getPlansRoot,
  getWorkspaceConfig,
  listPlans,
  onPlanChanged,
  onPlansRootChanged,
  onWorkspaceConfigChanged,
  type PlanChangeEvent,
  type PlanFileMeta,
  readPlan,
  writePlan,
} from "../tauri/api";
import type { Plan } from "../types";

const WORKER_PARSE_THRESHOLD = 5_000;
const LAGGED_PREVIEW_THRESHOLD = 50_000;
const LAGGED_PREVIEW_DEBOUNCE_MS = 650;
const ACTIVE_REMOVE_RECHECK_MS = 350;

interface UsePlanWorkspaceArgs {
  defaultReaderMode: ReaderMode;
  persistedActivePlanPath: string | null;
  planTitleSource: PlanTitleSource;
  settingsLoaded: boolean;
}

function parseDebounceForLength(length: number, mode: ReaderMode): number {
  if (mode === "split" && length >= LAGGED_PREVIEW_THRESHOLD) {
    return LAGGED_PREVIEW_DEBOUNCE_MS;
  }
  if (length < 10_000) return 60;
  if (length < 50_000) return 150;
  return 250;
}

function parseOnMain(source: string): MarkdownParseResult {
  const tree = parseMarkdown(source);
  const outline = extractOutline(tree);
  const progress = totalProgress(outline);
  return { tree, outline, progress };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isFastPlanMeta(f: PlanFileMeta): boolean {
  return (
    f.lineCount === 0 &&
    f.wordCount === 0 &&
    f.taskDone === 0 &&
    f.taskTotal === 0 &&
    f.frontmatter == null &&
    f.h1 == null
  );
}

function mergePlanFileAnalysis(
  previous: PlanFileMeta[],
  incoming: PlanFileMeta[],
): PlanFileMeta[] {
  const previousByPath = new Map(previous.map((f) => [f.path, f]));
  return incoming.map((next) => {
    const prev = previousByPath.get(next.path);
    if (!prev || !isFastPlanMeta(next)) return next;

    // Fast listings intentionally omit analysis fields. Keep the last
    // analyzed title/frontmatter/metrics visible until the background
    // analysis catches up, even when mtime/size changed.
    return {
      ...next,
      lineCount: prev.lineCount,
      wordCount: prev.wordCount,
      taskDone: prev.taskDone,
      taskTotal: prev.taskTotal,
      frontmatter: prev.frontmatter,
      h1: prev.h1,
    };
  });
}

function readInitialPlanFromGlobal(): string | null {
  const w = window as unknown as { __SR_INITIAL_PLAN__?: unknown };
  const plan = w.__SR_INITIAL_PLAN__;
  delete w.__SR_INITIAL_PLAN__;
  return typeof plan === "string" && plan.length > 0 ? plan : null;
}

export function usePlanWorkspace({
  defaultReaderMode,
  persistedActivePlanPath,
  planTitleSource,
  settingsLoaded,
}: UsePlanWorkspaceArgs) {
  const [rawFiles, setRawFiles] = useState<PlanFileMeta[]>([]);
  const rawFilesRef = useRef<PlanFileMeta[]>([]);
  const analysisRequestRef = useRef(0);
  const analysisTimerRef = useRef<number | null>(null);
  const [plansRoot, setPlansRootState] = useState<string | null>(null);
  const [plansRootLoaded, setPlansRootLoaded] = useState(false);
  const [workspaceRepos, setWorkspaceRepos] = useState<Record<string, string>>(
    {},
  );
  const workspaceRepoEntries = useMemo(
    () => Object.entries(workspaceRepos).sort(([a], [b]) => a.localeCompare(b)),
    [workspaceRepos],
  );
  const workspaceRepoHandles = useMemo(
    () => workspaceRepoEntries.map(([handle]) => handle),
    [workspaceRepoEntries],
  );
  const workspaceConfigKey = useMemo(
    () =>
      workspaceRepoEntries
        .map(([handle, path]) => `${handle}\0${path}`)
        .join("\0"),
    [workspaceRepoEntries],
  );
  const [activeId, setActiveId] = useState("");
  const activeIdRef = useRef(activeId);
  const [activeHeading, setActiveHeading] = useState("");
  const [mode, setMode] = useState<ReaderMode>(() => defaultReaderMode);
  const [rawMd, setRawMd] = useState("");
  const [parseSource, setParseSource] = useState("");
  const [parseResult, setParseResult] = useState<MarkdownParseResult>(() =>
    parseOnMain(""),
  );
  const parseRequestRef = useRef(0);
  const lastSavedRef = useRef("");
  const skipNextSaveRef = useRef(false);
  const rawMdOwnerRef = useRef("");
  const initialActiveAppliedRef = useRef(false);
  const initialModeAppliedRef = useRef(false);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const applyPlanFiles = useCallback((incoming: PlanFileMeta[]) => {
    const merged = mergePlanFileAnalysis(rawFilesRef.current, incoming);
    rawFilesRef.current = merged;
    setRawFiles(merged);
    return merged;
  }, []);

  const reloadActiveSource = useCallback(async (targetPath: string) => {
    if (!targetPath || activeIdRef.current !== targetPath) return false;
    try {
      const source = await readPlan(targetPath);
      if (activeIdRef.current !== targetPath) return false;
      if (source !== lastSavedRef.current) {
        skipNextSaveRef.current = true;
        lastSavedRef.current = source;
        rawMdOwnerRef.current = targetPath;
        setRawMd(source);
        setParseSource(source);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshPlanAnalysis = useCallback(
    (delayMs = 150) => {
      analysisRequestRef.current += 1;
      const requestId = analysisRequestRef.current;
      if (analysisTimerRef.current != null) {
        window.clearTimeout(analysisTimerRef.current);
      }
      analysisTimerRef.current = window.setTimeout(() => {
        analysisTimerRef.current = null;
        analyzePlans()
          .then((files) => {
            if (analysisRequestRef.current !== requestId) return;
            applyPlanFiles(files);
          })
          .catch((e) => console.error("analyzePlans failed:", e));
      }, delayMs);
    },
    [applyPlanFiles],
  );

  useEffect(() => {
    return () => {
      if (analysisTimerRef.current != null) {
        window.clearTimeout(analysisTimerRef.current);
      }
      analysisRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded || initialModeAppliedRef.current) return;
    initialModeAppliedRef.current = true;
    setMode(defaultReaderMode);
  }, [settingsLoaded, defaultReaderMode]);

  useEffect(() => {
    let cancelled = false;
    const refreshWorkspaceConfig = () => {
      getWorkspaceConfig(plansRoot)
        .then((snapshot) => {
          if (cancelled) return;
          setWorkspaceRepos(snapshot.config.repos ?? {});
        })
        .catch((e) => console.error("getWorkspaceConfig failed:", e));
    };

    refreshWorkspaceConfig();

    let unlisten: (() => void) | undefined;
    onWorkspaceConfigChanged(() => refreshWorkspaceConfig()).then((u) => {
      unlisten = u;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [plansRoot]);

  useEffect(() => {
    let unlistenRootChanged: (() => void) | undefined;
    let cancelled = false;
    let pendingInitialPlan: string | null = readInitialPlanFromGlobal();
    const persistedActivePlan = persistedActivePlanPath;

    const refresh = async (): Promise<void> => {
      try {
        const [root, files] = await Promise.all([getPlansRoot(), listPlans()]);
        if (cancelled) return;
        setPlansRootState(root);
        applyPlanFiles(files);
        const pending = pendingInitialPlan;
        pendingInitialPlan = null;
        if (!initialActiveAppliedRef.current) {
          const persisted =
            persistedActivePlan &&
            files.some((f) => f.path === persistedActivePlan)
              ? persistedActivePlan
              : null;
          const initial = pending ?? persisted ?? files[0]?.path ?? "";
          setActiveId(initial);
          setActiveHeading("");
          initialActiveAppliedRef.current = true;
        } else {
          setActiveId((prev) => {
            if (pending && files.some((f) => f.path === pending))
              return pending;
            if (prev && files.some((f) => f.path === prev)) return prev;
            return files[0]?.path ?? "";
          });
        }
      } catch (e) {
        console.error("listPlans failed:", e);
      } finally {
        if (!cancelled) {
          setPlansRootLoaded(true);
          refreshPlanAnalysis();
        }
      }
    };

    getInitialState()
      .then((init) => {
        if (!pendingInitialPlan && init.activePlan) {
          pendingInitialPlan = init.activePlan;
        }
      })
      .catch((e) => console.error("getInitialState:", e))
      .finally(() => {
        void refresh();
      });

    onPlansRootChanged((newRoot) => {
      setPlansRootState(newRoot);
      getInitialState()
        .then((init) => {
          if (init.activePlan) pendingInitialPlan = init.activePlan;
        })
        .catch((e) => console.error("getInitialState on root change:", e))
        .finally(() => {
          if (!cancelled) void refresh();
        });
    }).then((u) => {
      unlistenRootChanged = u;
    });

    return () => {
      cancelled = true;
      unlistenRootChanged?.();
    };
  }, [applyPlanFiles, refreshPlanAnalysis, persistedActivePlanPath]);

  const plans = useMemo(
    () =>
      rawFiles.map((f) =>
        planFromFile(f, planTitleSource, workspaceRepoHandles),
      ),
    [rawFiles, planTitleSource, workspaceRepoHandles],
  );

  const activePlan = plans.find((p) => p.id === activeId);
  const activePlanPath = activePlan?.path ?? "";

  useEffect(() => {
    if (!activePlanPath) return;
    const targetPath = activePlanPath;
    let cancelled = false;
    skipNextSaveRef.current = true;
    rawMdOwnerRef.current = "";
    readPlan(targetPath)
      .then((source) => {
        if (cancelled) return;
        lastSavedRef.current = source;
        rawMdOwnerRef.current = targetPath;
        setRawMd(source);
        setParseSource(source);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("readPlan failed:", e);
        lastSavedRef.current = "";
        rawMdOwnerRef.current = "";
        setRawMd("");
        setParseSource("");
      });
    return () => {
      cancelled = true;
    };
  }, [activePlanPath]);

  const parseDebounceMs = parseDebounceForLength(rawMd.length, mode);
  const debouncedRawMd = useDebounced(rawMd, parseDebounceMs);
  useEffect(() => {
    setParseSource(debouncedRawMd);
  }, [debouncedRawMd]);

  const debouncedSaveSource = useDebounced(rawMd, 800);
  useEffect(() => {
    const skip = skipNextSaveRef.current;
    if (skip) skipNextSaveRef.current = false;
    const snapshot = decideSaveSnapshot({
      skipNextSave: skip,
      activePlanPath: activePlanPath || null,
      rawMdOwner: rawMdOwnerRef.current,
      rawMd,
      debouncedSaveSource,
      lastSaved: lastSavedRef.current,
    });
    if (snapshot === null) return;
    const path = activePlanPath;
    if (!path) return;
    writePlan(path, snapshot)
      .then(() => {
        lastSavedRef.current = snapshot;
      })
      .catch((e) => console.error("writePlan failed:", e));
  }, [debouncedSaveSource, rawMd, activePlanPath]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let pending: PlanChangeEvent | null = null;
    let timer: number | null = null;

    const flush = async () => {
      timer = null;
      const event = pending;
      pending = null;
      if (!event) return;
      let nextPlans: Plan[] = [];
      let activeRemoveReappeared = false;
      const prevActiveId = activeIdRef.current;
      const activeEvent =
        prevActiveId.length > 0 && event.path === prevActiveId;
      const activeSourceReadable = activeEvent
        ? await reloadActiveSource(prevActiveId)
        : false;
      try {
        let updated = await listPlans();
        const activeRemoved = event.kind === "removed" && activeEvent;
        if (activeRemoved) {
          if (
            !activeSourceReadable &&
            !updated.some((f) => f.path === prevActiveId)
          ) {
            await delay(ACTIVE_REMOVE_RECHECK_MS);
            updated = await listPlans();
            if (activeIdRef.current !== prevActiveId) {
              applyPlanFiles(updated);
              refreshPlanAnalysis();
              return;
            }
          }
          activeRemoveReappeared =
            activeSourceReadable ||
            updated.some((f) => f.path === prevActiveId);
          if (
            activeSourceReadable &&
            !updated.some((f) => f.path === prevActiveId)
          ) {
            const previousActive = rawFilesRef.current.find(
              (f) => f.path === prevActiveId,
            );
            if (previousActive) {
              updated = [previousActive, ...updated];
            }
          }
        }
        const merged = applyPlanFiles(updated);
        refreshPlanAnalysis();
        nextPlans = merged.map((f) =>
          planFromFile(f, planTitleSource, workspaceRepoHandles),
        );
      } catch (e) {
        console.error("listPlans (refresh) failed:", e);
        return;
      }

      if (
        prevActiveId &&
        activeIdRef.current === prevActiveId &&
        !activeRemoveReappeared &&
        !nextPlans.find((p) => p.id === prevActiveId)
      ) {
        const prevBasename = prevActiveId.split("/").pop() ?? "";
        const renamed =
          (event.kind === "created" &&
            nextPlans.find((p) => p.id === event.path)) ||
          (prevBasename
            ? nextPlans.find((p) => p.path.endsWith(`/${prevBasename}`))
            : undefined);
        if (renamed) {
          setActiveId(renamed.id);
          skipNextSaveRef.current = true;
        } else if (nextPlans.length > 0) {
          setActiveId(nextPlans[0].id);
        }
      }

      if (
        (event.kind !== "removed" || activeRemoveReappeared) &&
        prevActiveId &&
        activeIdRef.current === prevActiveId &&
        event.path === prevActiveId &&
        nextPlans.find((p) => p.id === event.path) &&
        !activeSourceReadable
      ) {
        await reloadActiveSource(event.path);
      }
    };

    const p = onPlanChanged((event) => {
      pending = event;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 80);
    });
    p.then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [
    applyPlanFiles,
    refreshPlanAnalysis,
    reloadActiveSource,
    planTitleSource,
    workspaceRepoHandles,
  ]);

  useEffect(() => {
    const requestId = parseRequestRef.current + 1;
    parseRequestRef.current = requestId;

    const commitParseResult = (next: MarkdownParseResult) => {
      if (parseRequestRef.current !== requestId) return;
      startTransition(() => setParseResult(next));
    };

    if (parseSource.length <= WORKER_PARSE_THRESHOLD) {
      commitParseResult(parseOnMain(parseSource));
      return;
    }

    let cancelled = false;
    void parseInWorker(parseSource)
      .then((next) => {
        if (!cancelled) commitParseResult(next);
      })
      .catch((error) => {
        if (cancelled || parseRequestRef.current !== requestId) return;
        console.error(
          "parseInWorker failed; falling back to main thread:",
          error,
        );
        commitParseResult(parseOnMain(parseSource));
      });

    return () => {
      cancelled = true;
    };
  }, [parseSource]);

  const ast = parseResult.tree;
  const outline = parseResult.outline;
  const progress = parseResult.progress;
  const planForView = useMemo(
    () => (activePlan ? { ...activePlan, progress } : null),
    [activePlan, progress],
  );

  return {
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
  };
}
