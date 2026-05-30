import { act, renderHook, waitFor } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneLayout } from "./usePaneLayout";
import {
  AUTO_HIDE_PANES_MAX_WIDTH,
  loadPaneWidths,
  loadWindowState,
  paneClamps,
  savePaneWidths,
  saveWindowState,
} from "./windowState";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "test-window" }),
}));

const WINDOW_STATE_KEY = "specrider.windowState.v1.test-window";
const PANE_WIDTHS_KEY = "specrider.paneWidths.v1.test-window";
const ACTION_SPLIT_KEY = "specrider.actionSplitRatio.v1.test-window";
const ACTION_VERTICAL_KEY = "specrider.actionVerticalRatio.v1.test-window";

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function keyEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLDivElement>;
}

describe("windowState", () => {
  beforeEach(() => {
    localStorage.clear();
    setWindowWidth(1_000);
  });

  it("loads, sanitizes, and merges persisted window state", () => {
    localStorage.setItem(
      WINDOW_STATE_KEY,
      JSON.stringify({
        browserVisible: false,
        outlineVisible: true,
        readerVisible: false,
        terminalOpen: true,
        diffOpen: true,
        activePlanPath: "active/spec.md",
      }),
    );

    expect(loadWindowState()).toEqual({
      browserVisible: false,
      outlineVisible: true,
      readerVisible: false,
      terminalOpen: true,
      diffOpen: true,
      activePlanPath: "active/spec.md",
    });

    saveWindowState({ terminalOpen: false });

    expect(JSON.parse(localStorage.getItem(WINDOW_STATE_KEY) ?? "{}")).toEqual({
      browserVisible: false,
      outlineVisible: true,
      readerVisible: false,
      terminalOpen: false,
      diffOpen: true,
      activePlanPath: "active/spec.md",
    });
  });

  it("persists pane widths and clamps from the current window width", () => {
    savePaneWidths({ left: 280, right: 340 });

    expect(loadPaneWidths()).toEqual({ left: 280, right: 340 });
    expect(paneClamps("left")).toEqual({ min: 180, max: 350 });
    expect(paneClamps("right")).toEqual({ min: 220, max: 400 });
  });
});

describe("usePaneLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    setWindowWidth(1_000);
  });

  it("auto-hides side panes on compact widths until explicit toggles override them", () => {
    setWindowWidth(AUTO_HIDE_PANES_MAX_WIDTH - 1);
    const { result } = renderHook(() => usePaneLayout());

    expect(result.current.browserVisible).toBe(false);
    expect(result.current.outlineVisible).toBe(false);

    act(() => {
      result.current.toggleBrowserPane();
    });

    expect(result.current.browserVisible).toBe(true);
  });

  it("saves visibility and action-pane state transitions", async () => {
    const { result } = renderHook(() => usePaneLayout());

    act(() => {
      result.current.setDiffPaneOpen(true);
    });

    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(WINDOW_STATE_KEY) ?? "{}"),
      ).toMatchObject({
        diffOpen: true,
      }),
    );
    expect(result.current.diffPaneHasOpened).toBe(true);
    expect(result.current.rightRailMode).toBe("commits");
  });

  it("updates side pane widths from keyboard splitters and persists them", () => {
    const { result } = renderHook(() => usePaneLayout());
    const event = keyEvent("End");

    act(() => {
      result.current.onPaneSplitterKey("left")(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.paneWidths.left).toBe(
      result.current.leftPaneClamp.max,
    );
    expect(
      JSON.parse(localStorage.getItem(PANE_WIDTHS_KEY) ?? "{}"),
    ).toMatchObject({
      left: result.current.leftPaneClamp.max,
    });
  });

  it("loads and saves action split ratios from keyboard controls", () => {
    localStorage.setItem(ACTION_SPLIT_KEY, "0.7");
    localStorage.setItem(ACTION_VERTICAL_KEY, "0.3");
    const { result } = renderHook(() => usePaneLayout());

    expect(result.current.actionSplitRatio).toBe(0.7);
    expect(result.current.actionVerticalRatio).toBe(0.3);

    const centerEvent = keyEvent("Home");
    act(() => {
      result.current.onCenterSplitterKey(centerEvent);
    });
    expect(result.current.actionSplitRatio).toBe(0.2);
    expect(localStorage.getItem(ACTION_SPLIT_KEY)).toBe("0.2");

    const verticalEvent = keyEvent("End");
    act(() => {
      result.current.onActionVerticalSplitterKey(verticalEvent);
    });
    expect(result.current.actionVerticalRatio).toBe(0.85);
    expect(localStorage.getItem(ACTION_VERTICAL_KEY)).toBe("0.85");
  });
});
