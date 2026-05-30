import { act, renderHook, waitFor } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSelection } from "../components/CommitHistoryRail";
import type { ReaderMode } from "../components/Reader";
import type { CollapsedSections } from "../hooks/useCollapsedSections";
import { useAppCommands } from "./useAppCommands";

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  message: vi.fn(),
}));

const openerMocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

const updaterMocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  getUpdaterState: vi.fn(),
  supportsUpdater: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  diagnosticsSnapshot: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: clipboardMocks.writeText,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: dialogMocks.confirm,
  message: dialogMocks.message,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openerMocks.openUrl,
}));

vi.mock("../lib/updater", () => ({
  checkForUpdate: updaterMocks.checkForUpdate,
  getUpdaterState: updaterMocks.getUpdaterState,
  supportsUpdater: updaterMocks.supportsUpdater,
}));

vi.mock("../tauri/api", () => ({
  diagnosticsSnapshot: apiMocks.diagnosticsSnapshot,
}));

let menuActionHandler: ((event: { payload: string }) => void) | null = null;

function dispatchSetter<T>() {
  return vi.fn() as unknown as Dispatch<SetStateAction<T>>;
}

function keydown(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function defaultArgs() {
  const collapseHook = {
    collapsed: new Set<string>(),
    collapseAll: vi.fn(),
    expandAll: vi.fn(),
    isCollapsed: vi.fn(),
    toggle: vi.fn(),
  } as unknown as CollapsedSections;

  return {
    applyZoom: vi.fn(),
    collapseHook,
    cycleHunk: vi.fn(),
    diffPaneOpen: true,
    goBack: vi.fn(),
    goForward: vi.fn(),
    headingHierarchy: [
      { id: "intro", depth: 1 },
      { id: "details", depth: 2 },
    ],
    mode: "read" as const,
    pushToast: vi.fn(),
    setBlameSessionOverride: dispatchSetter<boolean | null>(),
    setDiffFindOpen: dispatchSetter<boolean>(),
    setDiffPaneOpen: dispatchSetter<boolean>(),
    setDiffSelection: dispatchSetter<CommitSelection | null>(),
    setFindInitialQuery: dispatchSetter<string | undefined>(),
    setFindOpen: dispatchSetter<boolean>(),
    setMode: dispatchSetter<ReaderMode>(),
    setProjectSearchOpen: dispatchSetter<boolean>(),
    setQuickSwitchOpen: dispatchSetter<boolean>(),
    setTerminalPaneOpen: dispatchSetter<boolean>(),
    setTerminalSpikeOpen: dispatchSetter<boolean>(),
    setUpdateModalOpen: dispatchSetter<boolean>(),
    showLineBlame: false,
    togglePopoverForCurrentHunk: vi.fn(),
    viewerRedo: vi.fn(),
    viewerUndo: vi.fn(),
  };
}

describe("useAppCommands", () => {
  beforeEach(() => {
    menuActionHandler = null;
    for (const mock of [
      ...Object.values(eventMocks),
      ...Object.values(clipboardMocks),
      ...Object.values(dialogMocks),
      ...Object.values(openerMocks),
      ...Object.values(updaterMocks),
      ...Object.values(apiMocks),
    ]) {
      mock.mockReset();
    }
    eventMocks.listen.mockImplementation((_event, handler) => {
      menuActionHandler = handler;
      return Promise.resolve(vi.fn());
    });
    openerMocks.openUrl.mockResolvedValue(undefined);
    clipboardMocks.writeText.mockResolvedValue(undefined);
    dialogMocks.confirm.mockResolvedValue(false);
    dialogMocks.message.mockResolvedValue(undefined);
    updaterMocks.checkForUpdate.mockResolvedValue(undefined);
    updaterMocks.getUpdaterState.mockReturnValue({
      installKind: "dev",
      status: "idle",
      update: null,
    });
    updaterMocks.supportsUpdater.mockReturnValue(false);
    apiMocks.diagnosticsSnapshot.mockResolvedValue({ markdown: "diagnostics" });
  });

  it("handles global shortcuts while respecting field and editor escape hatches", () => {
    const args = defaultArgs();
    renderHook(() => useAppCommands(args));

    const input = document.createElement("input");
    document.body.append(input);
    keydown(input, { key: "p", metaKey: true });
    expect(args.setQuickSwitchOpen).not.toHaveBeenCalled();

    keydown(document.body, { key: "p", metaKey: true });
    expect(args.setQuickSwitchOpen).toHaveBeenCalledWith(expect.any(Function));

    const editor = document.createElement("div");
    editor.className = "cm-editor";
    document.body.append(editor);
    keydown(editor, { key: "f", metaKey: true });
    expect(args.setFindOpen).not.toHaveBeenCalled();

    const diff = document.createElement("div");
    diff.className = "diff-explorer-pane";
    document.body.append(diff);
    keydown(diff, { key: "f", metaKey: true });
    expect(args.setDiffFindOpen).toHaveBeenCalledWith(true);

    keydown(input, { key: "z", metaKey: true });
    expect(args.viewerUndo).not.toHaveBeenCalled();

    keydown(document.body, { key: "z", metaKey: true });
    expect(args.viewerUndo).toHaveBeenCalled();
  });

  it("dispatches menu actions from the Tauri listener", async () => {
    const args = defaultArgs();
    renderHook(() => useAppCommands(args));

    await waitFor(() =>
      expect(eventMocks.listen).toHaveBeenCalledWith(
        "menu-action",
        expect.any(Function),
      ),
    );

    act(() => {
      menuActionHandler?.({ payload: "uncommitted" });
    });
    expect(args.setDiffPaneOpen).toHaveBeenCalledWith(true);
    expect(args.setDiffSelection).toHaveBeenCalledWith({ kind: "unstaged" });

    act(() => {
      menuActionHandler?.({ payload: "fold-toggle" });
    });
    expect(args.collapseHook.collapseAll).toHaveBeenCalledWith([
      "intro",
      "details",
    ]);

    act(() => {
      menuActionHandler?.({ payload: "mode-split" });
    });
    expect(args.setMode).toHaveBeenCalledWith("split");
  });

  it("copies diagnostics through the clipboard and reports success", async () => {
    const args = defaultArgs();
    apiMocks.diagnosticsSnapshot.mockResolvedValueOnce({
      markdown: "## Diagnostics",
    });
    renderHook(() => useAppCommands(args));

    await waitFor(() => expect(menuActionHandler).toBeTruthy());
    act(() => {
      menuActionHandler?.({ payload: "copy-diagnostics" });
    });

    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenCalledWith("## Diagnostics"),
    );
    expect(args.pushToast).toHaveBeenCalledWith(
      "Diagnostics copied for support issue",
      { tone: "success", durationMs: 2000 },
    );
  });

  it("routes unsupported update checks to releases when confirmed", async () => {
    const args = defaultArgs();
    dialogMocks.confirm.mockResolvedValueOnce(true);
    renderHook(() => useAppCommands(args));

    await waitFor(() => expect(menuActionHandler).toBeTruthy());
    act(() => {
      menuActionHandler?.({ payload: "check-for-updates" });
    });

    await waitFor(() =>
      expect(openerMocks.openUrl).toHaveBeenCalledWith(
        "https://github.com/specrider/specrider/releases",
      ),
    );
  });
});
