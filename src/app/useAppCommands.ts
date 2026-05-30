import { listen } from "@tauri-apps/api/event";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import {
  confirm as dialogConfirm,
  message as dialogMessage,
} from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { CommitSelection } from "../components/CommitHistoryRail";
import type { ReaderMode } from "../components/Reader";
import type { CollapsedSections } from "../hooks/useCollapsedSections";
import type { ToastAction, ToastTone } from "../hooks/useToasts";
import {
  checkForUpdate,
  getUpdaterState,
  supportsUpdater,
} from "../lib/updater";
import { diagnosticsSnapshot } from "../tauri/api";

type PushToast = (
  message: string,
  options?: { tone?: ToastTone; action?: ToastAction; durationMs?: number },
) => void;

interface HeadingEntry {
  id: string;
  depth: number;
}

interface UseAppCommandsArgs {
  applyZoom: (delta: number | "reset") => void;
  collapseHook: CollapsedSections;
  cycleHunk: (direction: 1 | -1) => void;
  diffPaneOpen: boolean;
  goBack: () => void;
  goForward: () => void;
  headingHierarchy: HeadingEntry[];
  mode: ReaderMode;
  pushToast: PushToast;
  setBlameSessionOverride: Dispatch<SetStateAction<boolean | null>>;
  setDiffFindOpen: Dispatch<SetStateAction<boolean>>;
  setDiffPaneOpen: Dispatch<SetStateAction<boolean>>;
  setDiffSelection: Dispatch<SetStateAction<CommitSelection | null>>;
  setFindInitialQuery: Dispatch<SetStateAction<string | undefined>>;
  setFindOpen: Dispatch<SetStateAction<boolean>>;
  setMode: Dispatch<SetStateAction<ReaderMode>>;
  setProjectSearchOpen: Dispatch<SetStateAction<boolean>>;
  setQuickSwitchOpen: Dispatch<SetStateAction<boolean>>;
  setTerminalPaneOpen: Dispatch<SetStateAction<boolean>>;
  setTerminalSpikeOpen: Dispatch<SetStateAction<boolean>>;
  setUpdateModalOpen: Dispatch<SetStateAction<boolean>>;
  showLineBlame: boolean;
  togglePopoverForCurrentHunk: () => void;
  viewerRedo: () => void;
  viewerUndo: () => void;
}

export function useAppCommands({
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
  showLineBlame,
  togglePopoverForCurrentHunk,
  viewerRedo,
  viewerUndo,
}: UseAppCommandsArgs): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (cmd && e.key.toLowerCase() === "r") {
        claim();
        window.location.reload();
        return;
      }
      if (cmd && e.key.toLowerCase() === "e") {
        claim();
        setMode((m) =>
          m === "read" ? "edit" : m === "edit" ? "split" : "read",
        );
        return;
      }
      if (cmd && e.key === "[") {
        claim();
        goBack();
        return;
      }
      if (cmd && e.key === "]") {
        claim();
        goForward();
        return;
      }
      if (
        cmd &&
        !e.shiftKey &&
        (e.key.toLowerCase() === "t" || e.key.toLowerCase() === "p")
      ) {
        const target = e.target as HTMLElement | null;
        const insideTerminal = !!target?.closest?.(".terminal-pane");
        const insideField =
          !insideTerminal && !!target?.closest?.("input, textarea");
        if (insideField) return;
        claim();
        setQuickSwitchOpen((v) => !v);
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "f") {
        claim();
        setProjectSearchOpen(true);
        return;
      }
      if (cmd && e.key.toLowerCase() === "f") {
        const target = e.target as HTMLElement | null;
        const insideEditor = !!target?.closest?.(".cm-editor");
        if (insideEditor) return;
        const insideDiffExplorer = !!target?.closest?.(".diff-explorer-pane");
        if (insideDiffExplorer) {
          if (!diffPaneOpen) return;
          claim();
          setDiffFindOpen(true);
          return;
        }
        if (mode !== "read") return;
        claim();
        setFindInitialQuery(undefined);
        setFindOpen(true);
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "j") {
        claim();
        cycleHunk(1);
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "k") {
        claim();
        cycleHunk(-1);
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "d") {
        claim();
        togglePopoverForCurrentHunk();
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "b") {
        claim();
        setBlameSessionOverride((cur) =>
          cur === null ? !showLineBlame : !cur,
        );
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "t") {
        claim();
        setTerminalSpikeOpen((v) => !v);
        return;
      }
      if (cmd && e.code === "Backquote") {
        claim();
        if (e.shiftKey) setDiffPaneOpen((v) => !v);
        else setTerminalPaneOpen((v) => !v);
        return;
      }
      if (cmd && e.key.toLowerCase() === "z") {
        if (mode !== "read") return;
        const target = e.target as HTMLElement | null;
        const insideEditor = !!target?.closest?.(".cm-editor");
        const insideTerminal = !!target?.closest?.(".terminal-pane");
        const insideField = !!target?.closest?.(
          "input, textarea, select, [contenteditable='true']",
        );
        if (insideEditor || insideTerminal || insideField) return;
        claim();
        if (e.shiftKey) viewerRedo();
        else viewerUndo();
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "g") {
        claim();
        setDiffPaneOpen(true);
        setDiffSelection({ kind: "unstaged" });
        return;
      }
      if (cmd && e.altKey && e.key === ".") {
        if (mode !== "read") return;
        claim();
        if (collapseHook.collapsed.size > 0) {
          collapseHook.expandAll();
        } else {
          collapseHook.collapseAll(headingHierarchy.map((h) => h.id));
        }
        return;
      }
      if (cmd && !e.altKey && (e.key === "=" || e.key === "+")) {
        claim();
        applyZoom(1);
        return;
      }
      if (cmd && !e.altKey && e.key === "-") {
        claim();
        applyZoom(-1);
        return;
      }
      if (cmd && !e.altKey && !e.shiftKey && e.key === "0") {
        claim();
        applyZoom("reset");
        return;
      }
    };

    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [
    goBack,
    goForward,
    mode,
    cycleHunk,
    togglePopoverForCurrentHunk,
    showLineBlame,
    collapseHook,
    headingHierarchy,
    viewerUndo,
    viewerRedo,
    applyZoom,
    diffPaneOpen,
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
  ]);

  const runMenuAction = useCallback(
    (action: string) => {
      switch (action) {
        case "cycle-mode":
          setMode((m) =>
            m === "read" ? "edit" : m === "edit" ? "split" : "read",
          );
          return;
        case "mode-read":
          setMode("read");
          return;
        case "mode-edit":
          setMode("edit");
          return;
        case "mode-split":
          setMode("split");
          return;
        case "back":
          goBack();
          return;
        case "forward":
          goForward();
          return;
        case "next-hunk":
          cycleHunk(1);
          return;
        case "prev-hunk":
          cycleHunk(-1);
          return;
        case "quick-switch":
          setQuickSwitchOpen((v) => !v);
          return;
        case "find-in-doc":
          setFindInitialQuery(undefined);
          setFindOpen(true);
          if (mode === "edit") setMode("read");
          return;
        case "find-in-project":
          setProjectSearchOpen(true);
          return;
        case "toggle-popover":
          togglePopoverForCurrentHunk();
          return;
        case "toggle-blame":
          setBlameSessionOverride((cur) =>
            cur === null ? !showLineBlame : !cur,
          );
          return;
        case "toggle-terminal":
          setTerminalPaneOpen((v) => !v);
          return;
        case "toggle-diff":
          setDiffPaneOpen((v) => !v);
          return;
        case "uncommitted":
          setDiffPaneOpen(true);
          setDiffSelection({ kind: "unstaged" });
          return;
        case "fold-toggle":
          if (collapseHook.collapsed.size > 0) {
            collapseHook.expandAll();
          } else {
            collapseHook.collapseAll(headingHierarchy.map((h) => h.id));
          }
          return;
        case "zoom-in":
          applyZoom(1);
          return;
        case "zoom-out":
          applyZoom(-1);
          return;
        case "zoom-reset":
          applyZoom("reset");
          return;
        case "open-help":
          openUrl("https://specrider.ai/docs").catch((e) =>
            console.error("openUrl help:", e),
          );
          return;
        case "check-for-updates":
          void (async () => {
            const kind = getUpdaterState().installKind;
            if (!supportsUpdater(kind)) {
              const open = await dialogConfirm(
                "Auto-updates aren't enabled on this build of SpecRider. " +
                  "Visit the GitHub Releases page to check for newer versions?",
                {
                  title: "SpecRider",
                  kind: "info",
                  okLabel: "Open Releases",
                  cancelLabel: "Not now",
                },
              );
              if (open) {
                openUrl(
                  "https://github.com/specrider/specrider/releases",
                ).catch((e) => console.error("[updater] openUrl releases:", e));
              }
              return;
            }
            try {
              await checkForUpdate({ silent: false });
            } catch {
              /* state machine captured the error */
            }
            const final = getUpdaterState();
            if (final.status === "available") {
              setUpdateModalOpen(true);
            } else if (final.status === "none") {
              void dialogMessage(
                `SpecRider is up to date (v${final.update?.currentVersion ?? ""}).`,
                { title: "SpecRider", kind: "info" },
              );
            } else if (final.status === "error") {
              void dialogMessage(
                `Update check failed: ${final.error ?? "unknown error"}`,
                { title: "SpecRider", kind: "error" },
              );
            }
          })();
          return;
        case "copy-diagnostics":
          void diagnosticsSnapshot()
            .then(async (snap) => {
              await writeClipboardText(snap.markdown);
              pushToast("Diagnostics copied for support issue", {
                tone: "success",
                durationMs: 2000,
              });
            })
            .catch((e) => {
              console.error("copy diagnostics:", e);
              pushToast("Could not copy diagnostics", { tone: "error" });
            });
          return;
      }
    },
    [
      goBack,
      goForward,
      mode,
      cycleHunk,
      togglePopoverForCurrentHunk,
      showLineBlame,
      collapseHook,
      headingHierarchy,
      applyZoom,
      pushToast,
      setBlameSessionOverride,
      setDiffPaneOpen,
      setDiffSelection,
      setFindInitialQuery,
      setFindOpen,
      setMode,
      setProjectSearchOpen,
      setQuickSwitchOpen,
      setTerminalPaneOpen,
      setUpdateModalOpen,
    ],
  );

  const runMenuActionRef = useRef(runMenuAction);
  useEffect(() => {
    runMenuActionRef.current = runMenuAction;
  }, [runMenuAction]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const fn = await listen<string>("menu-action", (event) => {
        runMenuActionRef.current(event.payload);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
