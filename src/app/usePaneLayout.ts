import type { KeyboardEvent, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_HIDE_PANES_MAX_WIDTH,
  loadPaneWidths,
  loadWindowState,
  type PaneWidths,
  paneClamps,
  savePaneWidths,
  saveWindowState,
  WINDOW_LABEL,
} from "./windowState";

const ACTION_SPLIT_KEY = `specrider.actionSplitRatio.v1.${WINDOW_LABEL}`;
const ACTION_VERTICAL_KEY = `specrider.actionVerticalRatio.v1.${WINDOW_LABEL}`;

function loadRatio(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0.1 && n < 0.95) return n;
  } catch {
    /* ignore */
  }
  return fallback;
}

function saveRatio(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function beginResize(cursor: string): void {
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  document.body.classList.add("resizing-panes");
}

function endResize(): void {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.body.classList.remove("resizing-panes");
}

export function usePaneLayout() {
  const persistedWindowStateRef = useRef(loadWindowState());
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(loadPaneWidths);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [paneVisibilityOverride, setPaneVisibilityOverride] = useState<{
    left: boolean | null;
    right: boolean | null;
  }>({
    left: persistedWindowStateRef.current.browserVisible,
    right: persistedWindowStateRef.current.outlineVisible,
  });
  const [readerVisible, setReaderVisible] = useState(
    persistedWindowStateRef.current.readerVisible,
  );
  const [terminalPaneOpen, setTerminalPaneOpen] = useState(
    persistedWindowStateRef.current.terminalOpen,
  );
  const [terminalPaneHasOpened, setTerminalPaneHasOpened] = useState(
    persistedWindowStateRef.current.terminalOpen,
  );
  const [diffPaneOpen, setDiffPaneOpen] = useState(
    persistedWindowStateRef.current.diffOpen,
  );
  const [diffPaneHasOpened, setDiffPaneHasOpened] = useState(
    persistedWindowStateRef.current.diffOpen,
  );
  const [rightRailMode, setRightRailMode] = useState<"outline" | "commits">(
    "outline",
  );
  const prevDiffOpenRef = useRef(diffPaneOpen);
  const [actionSplitRatio, setActionSplitRatio] = useState<number>(() =>
    loadRatio(ACTION_SPLIT_KEY, 0.6),
  );
  const [actionVerticalRatio, setActionVerticalRatio] = useState<number>(() =>
    loadRatio(ACTION_VERTICAL_KEY, 0.5),
  );
  const [zenStateRun, setZenStateRun] = useState(0);
  const wasZenStateActiveRef = useRef(false);

  useEffect(() => {
    if (terminalPaneOpen) setTerminalPaneHasOpened(true);
  }, [terminalPaneOpen]);

  useEffect(() => {
    if (diffPaneOpen) setDiffPaneHasOpened(true);
  }, [diffPaneOpen]);

  useEffect(() => {
    const prev = prevDiffOpenRef.current;
    prevDiffOpenRef.current = diffPaneOpen;
    if (!prev && diffPaneOpen) {
      setRightRailMode("commits");
    } else if (prev && !diffPaneOpen) {
      setRightRailMode("outline");
    }
  }, [diffPaneOpen]);

  useEffect(() => {
    const onResize = () => {
      setWindowWidth(window.innerWidth);
      setPaneWidths((cur) => {
        const lc = paneClamps("left");
        const rc = paneClamps("right");
        const left = Math.min(lc.max, Math.max(lc.min, cur.left));
        const right = Math.min(rc.max, Math.max(rc.min, cur.right));
        return left !== cur.left || right !== cur.right ? { left, right } : cur;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    saveWindowState({
      browserVisible: paneVisibilityOverride.left,
      outlineVisible: paneVisibilityOverride.right,
      readerVisible,
      terminalOpen: terminalPaneOpen,
      diffOpen: diffPaneOpen,
    });
  }, [
    paneVisibilityOverride.left,
    paneVisibilityOverride.right,
    readerVisible,
    terminalPaneOpen,
    diffPaneOpen,
  ]);

  const compactAutoHidePanes = windowWidth < AUTO_HIDE_PANES_MAX_WIDTH;
  const browserVisible = paneVisibilityOverride.left ?? !compactAutoHidePanes;
  const outlineVisible = paneVisibilityOverride.right ?? !compactAutoHidePanes;
  const anyActionOpen = terminalPaneOpen || diffPaneOpen;
  const bothActionOpen = terminalPaneOpen && diffPaneOpen;
  const zenStateActive =
    !browserVisible &&
    !outlineVisible &&
    !readerVisible &&
    !terminalPaneOpen &&
    !diffPaneOpen;

  useEffect(() => {
    if (zenStateActive && !wasZenStateActiveRef.current) {
      setZenStateRun((run) => run + 1);
    }
    wasZenStateActiveRef.current = zenStateActive;
  }, [zenStateActive]);

  const leftPaneClamp = paneClamps("left");
  const rightPaneClamp = paneClamps("right");

  const toggleBrowserPane = useCallback(() => {
    setPaneVisibilityOverride((cur) => ({
      ...cur,
      left: !(cur.left ?? !compactAutoHidePanes),
    }));
  }, [compactAutoHidePanes]);

  const toggleOutlinePane = useCallback(() => {
    setPaneVisibilityOverride((cur) => ({
      ...cur,
      right: !(cur.right ?? !compactAutoHidePanes),
    }));
  }, [compactAutoHidePanes]);

  const startPaneResize =
    (side: "left" | "right") => (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = paneWidths;
      let raf = 0;
      let latest = start;
      const onMove = (ev: globalThis.MouseEvent) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const delta = ev.clientX - startX;
          const clamps = paneClamps(side);
          if (side === "left") {
            const w = Math.min(
              clamps.max,
              Math.max(clamps.min, start.left + delta),
            );
            latest = { ...latest, left: w };
            setPaneWidths(latest);
          } else {
            const w = Math.min(
              clamps.max,
              Math.max(clamps.min, start.right - delta),
            );
            latest = { ...latest, right: w };
            setPaneWidths(latest);
          }
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        endResize();
        savePaneWidths(latest);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      beginResize("col-resize");
    };

  const startCenterResize = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const containerEl =
        (e.currentTarget.parentElement as HTMLElement) || null;
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      let raf = 0;
      let latest = actionSplitRatio;
      const onMove = (ev: globalThis.MouseEvent) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (rect.width <= 0) return;
          const desired = (ev.clientX - rect.left) / rect.width;
          const clamped = Math.max(0.2, Math.min(0.85, desired));
          latest = clamped;
          setActionSplitRatio(clamped);
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        endResize();
        saveRatio(ACTION_SPLIT_KEY, latest);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      beginResize("col-resize");
    },
    [actionSplitRatio],
  );

  const startActionVerticalResize = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const containerEl =
        (e.currentTarget.parentElement as HTMLElement) || null;
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      let raf = 0;
      let latest = actionVerticalRatio;
      const onMove = (ev: globalThis.MouseEvent) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (rect.height <= 0) return;
          const desired = (ev.clientY - rect.top) / rect.height;
          const clamped = Math.max(0.2, Math.min(0.85, desired));
          latest = clamped;
          setActionVerticalRatio(clamped);
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        endResize();
        saveRatio(ACTION_VERTICAL_KEY, latest);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      beginResize("row-resize");
    },
    [actionVerticalRatio],
  );

  const onPaneSplitterKey =
    (side: "left" | "right") => (e: KeyboardEvent<HTMLDivElement>) => {
      const clamps = paneClamps(side);
      const nudge = e.shiftKey ? 48 : 12;
      const cur = paneWidths[side];
      let next: number | null = null;
      if (e.key === "ArrowLeft") {
        next =
          side === "left"
            ? Math.max(clamps.min, cur - nudge)
            : Math.min(clamps.max, cur + nudge);
      } else if (e.key === "ArrowRight") {
        next =
          side === "left"
            ? Math.min(clamps.max, cur + nudge)
            : Math.max(clamps.min, cur - nudge);
      } else if (e.key === "Home") {
        next = clamps.min;
      } else if (e.key === "End") {
        next = clamps.max;
      }
      if (next === null) return;
      e.preventDefault();
      const updated = { ...paneWidths, [side]: next };
      setPaneWidths(updated);
      savePaneWidths(updated);
    };

  const onCenterSplitterKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const min = 0.2;
    const max = 0.85;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(min, actionSplitRatio - step);
    else if (e.key === "ArrowRight")
      next = Math.min(max, actionSplitRatio + step);
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    setActionSplitRatio(next);
    saveRatio(ACTION_SPLIT_KEY, next);
  };

  const onActionVerticalSplitterKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const min = 0.2;
    const max = 0.85;
    let next: number | null = null;
    if (e.key === "ArrowUp") next = Math.max(min, actionVerticalRatio - step);
    else if (e.key === "ArrowDown")
      next = Math.min(max, actionVerticalRatio + step);
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    setActionVerticalRatio(next);
    saveRatio(ACTION_VERTICAL_KEY, next);
  };

  return {
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
    persistedActivePlanPath: persistedWindowStateRef.current.activePlanPath,
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
  };
}
