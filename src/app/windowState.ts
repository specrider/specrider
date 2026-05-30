import { getCurrentWindow } from "@tauri-apps/api/window";

export const WINDOW_LABEL = getCurrentWindow().label;
const PANE_WIDTHS_KEY = `specrider.paneWidths.v1.${WINDOW_LABEL}`;
const WINDOW_STATE_KEY = `specrider.windowState.v1.${WINDOW_LABEL}`;

const DEFAULT_LEFT = 260;
const DEFAULT_RIGHT = 320;

export const AUTO_HIDE_PANES_MAX_WIDTH = 860;

export interface PaneWidths {
  left: number;
  right: number;
}

export interface PersistedWindowState {
  browserVisible: boolean | null;
  outlineVisible: boolean | null;
  readerVisible: boolean;
  terminalOpen: boolean;
  diffOpen: boolean;
  activePlanPath: string | null;
}

export function loadWindowState(): PersistedWindowState {
  const empty: PersistedWindowState = {
    browserVisible: null,
    outlineVisible: null,
    readerVisible: true,
    terminalOpen: false,
    diffOpen: false,
    activePlanPath: null,
  };
  try {
    const raw = localStorage.getItem(WINDOW_STATE_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<PersistedWindowState>;
    return {
      browserVisible:
        typeof p.browserVisible === "boolean" ? p.browserVisible : null,
      outlineVisible:
        typeof p.outlineVisible === "boolean" ? p.outlineVisible : null,
      readerVisible:
        typeof p.readerVisible === "boolean" ? p.readerVisible : true,
      terminalOpen: !!p.terminalOpen,
      diffOpen: !!p.diffOpen,
      activePlanPath:
        typeof p.activePlanPath === "string" && p.activePlanPath.length > 0
          ? p.activePlanPath
          : null,
    };
  } catch {
    return empty;
  }
}

export function saveWindowState(patch: Partial<PersistedWindowState>): void {
  try {
    const merged = { ...loadWindowState(), ...patch };
    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(merged));
  } catch {
    /* localStorage full or disabled */
  }
}

export function loadPaneWidths(): PaneWidths {
  try {
    const raw = localStorage.getItem(PANE_WIDTHS_KEY);
    if (!raw) return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
    const parsed = JSON.parse(raw);
    return {
      left: typeof parsed?.left === "number" ? parsed.left : DEFAULT_LEFT,
      right: typeof parsed?.right === "number" ? parsed.right : DEFAULT_RIGHT,
    };
  } catch {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
  }
}

export function savePaneWidths(widths: PaneWidths): void {
  try {
    localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    /* ignore quota */
  }
}

export function paneClamps(side: "left" | "right") {
  const winW = window.innerWidth;
  if (side === "left") {
    return {
      min: Math.max(180, Math.round(winW * 0.12)),
      max: Math.max(220, Math.round(winW * 0.35)),
    };
  }
  return {
    min: Math.max(220, Math.round(winW * 0.14)),
    max: Math.max(260, Math.round(winW * 0.4)),
  };
}
