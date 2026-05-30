// Updater state + actions shared across windows.
//
// Cross-window model:
//   - The **main** window is the sole source of truth. It runs the
//     check (30s after first paint, if the on-launch toggle is on),
//     drives the download/install flow, and broadcasts state changes
//     to mirror windows via the Tauri `updater:state` event.
//   - **Mirror** windows (Settings, `window-*`) listen for state
//     updates and surface UI based on the cached state. Their "Check
//     now" button emits `updater:check-now`, which the main window
//     listens for and translates into an actual check call. Mirrors
//     never call `check()` directly — they don't have the updater
//     capability (see `src-tauri/capabilities/updater.json`).
//   - Dismissals (per target version) are persisted in localStorage
//     in *each* window so the chip stays hidden after a relaunch
//     without going through main.
//
// Platform support:
//   - macOS (any arch) and Linux AppImage: full updater UI.
//   - Windows and Linux deb/rpm: hidden. UI surfaces a static "manual
//     update" message instead, linking to GitHub Releases. The Rust
//     `updater_install_kind` command is the source of truth.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";

export type UpdaterInstallKind =
  | "macos"
  | "linux-appimage"
  | "linux-deb-or-rpm"
  | "windows"
  | "unsupported"
  | "unknown";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "restart-pending"
  | "none"
  | "error";

export interface UpdaterInfo {
  /** Target version (e.g. "0.3.0"). */
  version: string;
  /** Version the app is currently running. */
  currentVersion: string;
  /** Release notes body, if the manifest included one. */
  body?: string;
  /** Pub date string from the manifest, if present. */
  date?: string;
}

export interface UpdaterState {
  /** Whether this binary supports auto-updates at all. */
  installKind: UpdaterInstallKind;
  status: UpdaterStatus;
  update: UpdaterInfo | null;
  /** Last check result timestamp (ms since epoch). `null` until first
   *  successful check. */
  lastCheckedAt: number | null;
  /** Bytes downloaded so far during the `downloading` state. */
  downloadedBytes: number;
  /** Total expected bytes (from the `Started` event). May be null
   *  when the server doesn't advertise Content-Length. */
  totalBytes: number | null;
  error: string | null;
}

const INITIAL_STATE: UpdaterState = {
  installKind: "unknown",
  status: "idle",
  update: null,
  lastCheckedAt: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

const STATE_EVENT = "updater:state";
const CHECK_NOW_EVENT = "updater:check-now";
const RELAUNCH_COMMAND = "relaunch_app";
const PLATFORM_COMMAND = "updater_install_kind";
const DISMISS_PREFIX = "specrider.updater.dismissed:";

// Module-level state shared across hook subscribers in the same window.
let state: UpdaterState = { ...INITIAL_STATE };
const listeners = new Set<(s: UpdaterState) => void>();

/** The currently-tracked Update resource, kept alive between download
 *  and install. Reset when the modal is dismissed without installing
 *  or when we transition back to `available` from `error`. */
let pendingUpdate: Update | null = null;
/** Set when the user closes the modal during download — short-
 *  circuits the auto-install that would otherwise follow. */
let downloadAbandoned = false;

function setState(patch: Partial<UpdaterState>) {
  state = { ...state, ...patch };
  for (const cb of listeners) cb(state);
  // Mirror windows hear about state changes via Tauri events. Only the
  // main window broadcasts; mirrors set state from incoming events.
  if (role === "main") {
    void emit(STATE_EVENT, serializableState()).catch((e) => {
      console.error("[updater] emit state failed:", e);
    });
  }
}

function serializableState(): Omit<UpdaterState, "installKind"> & {
  installKind: UpdaterInstallKind;
} {
  // installKind is host-specific; main can't know the mirror's kind, so
  // we send it but mirrors reconcile against their own detection. In
  // practice both windows are inside the same binary, so it always
  // matches — broadcasting it just keeps the payload self-contained.
  return state;
}

type WindowRole = "main" | "mirror";
let role: WindowRole = "mirror";

export function subscribeUpdater(cb: (s: UpdaterState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => {
    listeners.delete(cb);
  };
}

/** Snapshot of the current state. Use the `useUpdaterState` hook for
 *  reactive reads; this getter exists for one-shot consumers (menu
 *  actions that need to look at state immediately after triggering
 *  an action and don't want to plumb a subscription). */
export function getUpdaterState(): UpdaterState {
  return state;
}

/** React hook: subscribe to updater state. Re-renders whenever state
 *  changes. Stateless on its own — call `installUpdater()` once at
 *  app start to wire up the listeners and check timer. */
export function useUpdaterState(): UpdaterState {
  const [snapshot, setSnapshot] = useState<UpdaterState>(() => state);
  useEffect(() => subscribeUpdater(setSnapshot), []);
  return snapshot;
}

let installed = false;

/** Call once per window after mount. Determines role from the window
 *  label, wires platform-appropriate listeners, and schedules the 30s
 *  background check on the main window if `checkOnLaunch` is on. */
export async function installUpdater(opts: {
  checkOnLaunch: boolean;
}): Promise<UnlistenFn> {
  if (installed) {
    // Hot-reload guard: tests + dev fast refresh shouldn't double-wire.
    return () => {};
  }
  installed = true;

  const win = getCurrentWindow();
  role = win.label === "main" ? "main" : "mirror";

  // Look up platform support. On error we degrade to "unknown" rather
  // than blocking the UI — the chip just won't show.
  let kind: UpdaterInstallKind = "unknown";
  try {
    kind = (await invoke<string>(PLATFORM_COMMAND)) as UpdaterInstallKind;
  } catch (e) {
    console.error("[updater] platform detection failed:", e);
  }
  setState({ installKind: kind });

  const unlisteners: UnlistenFn[] = [];

  if (role === "mirror") {
    // Mirror windows: passive — listen for state from main.
    const unlisten = await listen<UpdaterState>(STATE_EVENT, (event) => {
      const incoming = event.payload;
      // Re-apply the local installKind: it's host-specific but mirrors
      // run inside the same process so it should always match. Keeping
      // the local value avoids any payload-shape mismatch surprise.
      setLocal({ ...incoming, installKind: state.installKind });
    });
    unlisteners.push(unlisten);
  } else {
    // Main window: own the state; respond to mirror-side requests.
    const unlisten = await listen(CHECK_NOW_EVENT, () => {
      void checkForUpdate({ silent: false });
    });
    unlisteners.push(unlisten);

    if (supportsUpdater(kind) && opts.checkOnLaunch) {
      // 30s delay keeps startup snappy and gives the user a moment to
      // adjust the toggle from Settings → System & Updates before the first
      // background hit lands.
      const timer = window.setTimeout(() => {
        void checkForUpdate({ silent: true });
      }, 30_000);
      unlisteners.push(() => window.clearTimeout(timer));
    }
  }

  return () => {
    for (const u of unlisteners) {
      try {
        u();
      } catch (e) {
        console.error("[updater] unlisten failed:", e);
      }
    }
    installed = false;
  };
}

// State setter that only mutates locally — used by mirror windows when
// receiving an event from main, so we don't bounce the event back.
function setLocal(next: UpdaterState) {
  state = next;
  for (const cb of listeners) cb(state);
}

export function supportsUpdater(kind: UpdaterInstallKind): boolean {
  return kind === "macos" || kind === "linux-appimage";
}

/** Trigger a check from the main window. If called from a mirror,
 *  forwards the request via a Tauri event. */
export async function checkForUpdate(opts?: {
  silent?: boolean;
}): Promise<void> {
  const silent = opts?.silent ?? false;
  if (role === "mirror") {
    await emit(CHECK_NOW_EVENT);
    return;
  }
  if (!supportsUpdater(state.installKind)) {
    return;
  }
  setState({ status: "checking", error: null });
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      setState({
        status: "available",
        update: {
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body,
          date: update.date,
        },
        lastCheckedAt: Date.now(),
      });
    } else {
      setState({
        status: "none",
        update: null,
        lastCheckedAt: Date.now(),
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[updater] check failed:", e);
    setState({
      status: "error",
      error: message,
      lastCheckedAt: Date.now(),
    });
    if (!silent) {
      throw e;
    }
  }
}

/** User clicked Install in the modal. Downloads + installs + flips
 *  state to `restart-pending`. From a mirror window, no-op — install
 *  flow only runs on main. */
export async function installUpdate(): Promise<void> {
  if (role !== "main") {
    console.warn("[updater] installUpdate called from mirror — ignored");
    return;
  }
  if (!pendingUpdate) {
    console.warn("[updater] installUpdate called with no pending update");
    return;
  }
  downloadAbandoned = false;
  setState({
    status: "downloading",
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  });
  try {
    let downloaded = 0;
    let total: number | null = null;
    await pendingUpdate.download((event: DownloadEvent) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        setState({ totalBytes: total, downloadedBytes: 0 });
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        setState({ downloadedBytes: downloaded });
      } else if (event.event === "Finished") {
        setState({ downloadedBytes: total ?? downloaded });
      }
    });
    if (downloadAbandoned) {
      // User closed the modal mid-download. The download finished in
      // the background, but they explicitly told us not to install —
      // drop the resource and return to idle.
      await safeClose(pendingUpdate);
      pendingUpdate = null;
      setState({
        status: "idle",
        downloadedBytes: 0,
        totalBytes: null,
      });
      return;
    }
    setState({ status: "installing" });
    await pendingUpdate.install();
    setState({ status: "restart-pending" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[updater] install failed:", e);
    setState({ status: "error", error: message });
  }
}

/** Abandon a download in progress. The download itself can't be
 *  cancelled mid-flight (Tauri 2's plugin doesn't expose abort), so
 *  this flag tells the installer to discard the result when it
 *  completes. */
export function abandonDownload() {
  if (state.status !== "downloading") return;
  downloadAbandoned = true;
}

/** Restart into the freshly-installed binary. The Rust command calls
 *  `app.restart()` — kills the current process, re-launches the new
 *  bundle. Mirror windows can call this too; restart is app-wide. */
export async function relaunchApp(): Promise<void> {
  try {
    await invoke(RELAUNCH_COMMAND);
  } catch (e) {
    console.error("[updater] relaunch failed:", e);
  }
}

/** Drop the in-memory update reference. Used when the modal closes
 *  before a download starts (Later button). On the next check the
 *  fresh Update resource is fetched again. */
export async function discardPendingUpdate(): Promise<void> {
  if (pendingUpdate) {
    await safeClose(pendingUpdate);
    pendingUpdate = null;
  }
  if (state.status === "available") {
    setState({ status: "none", update: null });
  }
}

async function safeClose(update: Update): Promise<void> {
  try {
    await update.close();
  } catch (e) {
    console.error("[updater] update.close failed:", e);
  }
}

// ─── Dismissals (per target version) ─────────────────────────────────

export function dismissVersion(version: string) {
  try {
    window.localStorage.setItem(DISMISS_PREFIX + version, "1");
  } catch (e) {
    console.error("[updater] dismiss persist failed:", e);
  }
}

export function isVersionDismissed(version: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_PREFIX + version) === "1";
  } catch {
    return false;
  }
}

// ─── Release notes link ──────────────────────────────────────────────

export function releaseNotesUrl(version: string): string {
  // Mirrors the endpoint pattern in tauri.conf.json — keep them in
  // sync if the repo coordinates ever change.
  return `https://github.com/specrider/specrider/releases/tag/v${version}`;
}

// ─── Test helpers ────────────────────────────────────────────────────

/** Reset internal state for tests. Not exported from the package
 *  index; tests import directly. */
export function __resetUpdaterForTests(opts?: { role?: WindowRole }) {
  state = { ...INITIAL_STATE };
  listeners.clear();
  pendingUpdate = null;
  downloadAbandoned = false;
  installed = false;
  if (opts?.role) role = opts.role;
}

export function __setPendingUpdateForTests(u: Update | null) {
  pendingUpdate = u;
}
