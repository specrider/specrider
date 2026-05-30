/**
 * Updater module tests.
 *
 * The plugin (`@tauri-apps/plugin-updater`) and Tauri core invoke / emit
 * are mocked at the module-boundary level so the tests exercise our
 * state machine + persistence without touching real IPC. The plugin's
 * `Update` class isn't exported as a constructable type — we substitute
 * a duck-typed stand-in shaped to match the `download` / `install` /
 * `close` API we actually call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────

const checkMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

const invokeMock = vi.fn();
const emitMock = vi.fn();
const listenMock = vi.fn();
const getCurrentWindowMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => emitMock(...args),
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => getCurrentWindowMock(),
}));

// ─── Test helpers ────────────────────────────────────────────────────

import {
  __resetUpdaterForTests,
  __setPendingUpdateForTests,
  abandonDownload,
  checkForUpdate,
  dismissVersion,
  installUpdate,
  installUpdater,
  isVersionDismissed,
  subscribeUpdater,
  supportsUpdater,
  type UpdaterState,
} from "./updater";

type StubUpdate = {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  download: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeStubUpdate(opts: {
  version?: string;
  currentVersion?: string;
}): StubUpdate {
  return {
    version: opts.version ?? "0.3.0",
    currentVersion: opts.currentVersion ?? "0.1.0",
    body: undefined,
    date: undefined,
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function collectStates(): {
  snapshots: UpdaterState[];
  unsubscribe: () => void;
} {
  const snapshots: UpdaterState[] = [];
  const unsubscribe = subscribeUpdater((s) => snapshots.push({ ...s }));
  // Drop the initial synchronous emit so tests focus on transitions.
  snapshots.shift();
  return { snapshots, unsubscribe };
}

beforeEach(() => {
  window.localStorage.clear();
  checkMock.mockReset();
  invokeMock.mockReset();
  emitMock.mockReset();
  listenMock.mockReset();
  getCurrentWindowMock.mockReset();
  // Default: tests run as main window; install platform = macOS.
  getCurrentWindowMock.mockReturnValue({ label: "main" });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "updater_install_kind") return Promise.resolve("macos");
    if (cmd === "relaunch_app") return Promise.resolve(undefined);
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  listenMock.mockResolvedValue(() => {});
  emitMock.mockResolvedValue(undefined);
  __resetUpdaterForTests({ role: "main" });
});

afterEach(() => {
  __resetUpdaterForTests({ role: "main" });
});

// ─── Tests ───────────────────────────────────────────────────────────

describe("supportsUpdater", () => {
  it("greenlights macOS and Linux AppImage", () => {
    expect(supportsUpdater("macos")).toBe(true);
    expect(supportsUpdater("linux-appimage")).toBe(true);
  });

  it("blocks the platforms we don't auto-update on", () => {
    expect(supportsUpdater("windows")).toBe(false);
    expect(supportsUpdater("linux-deb-or-rpm")).toBe(false);
    expect(supportsUpdater("unsupported")).toBe(false);
    expect(supportsUpdater("unknown")).toBe(false);
  });
});

describe("checkForUpdate (main role)", () => {
  it("transitions idle → checking → available when an update is returned", async () => {
    await installUpdater({ checkOnLaunch: false });
    const stub = makeStubUpdate({ version: "0.3.0", currentVersion: "0.1.0" });
    checkMock.mockResolvedValue(stub);

    const { snapshots, unsubscribe } = collectStates();
    await checkForUpdate({ silent: true });
    unsubscribe();

    const statuses = snapshots.map((s) => s.status);
    expect(statuses).toContain("checking");
    expect(statuses.at(-1)).toBe("available");
    const last = snapshots.at(-1);
    if (!last) throw new Error("missing final updater snapshot");
    expect(last.update).toMatchObject({
      version: "0.3.0",
      currentVersion: "0.1.0",
    });
    expect(last.lastCheckedAt).not.toBeNull();
  });

  it("transitions to `none` when the plugin returns null", async () => {
    await installUpdater({ checkOnLaunch: false });
    checkMock.mockResolvedValue(null);

    const { snapshots, unsubscribe } = collectStates();
    await checkForUpdate({ silent: true });
    unsubscribe();

    expect(snapshots.at(-1)?.status).toBe("none");
    expect(snapshots.at(-1)?.update).toBeNull();
  });

  it("transitions to `error` when the plugin throws", async () => {
    await installUpdater({ checkOnLaunch: false });
    checkMock.mockRejectedValue(new Error("network unreachable"));

    const { snapshots, unsubscribe } = collectStates();
    await checkForUpdate({ silent: true });
    unsubscribe();

    const final = snapshots.at(-1);
    if (!final) throw new Error("missing final updater snapshot");
    expect(final.status).toBe("error");
    expect(final.error).toContain("network unreachable");
  });

  it("is a no-op on unsupported platforms", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "updater_install_kind") return Promise.resolve("windows");
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await installUpdater({ checkOnLaunch: false });

    await checkForUpdate({ silent: true });
    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe("dismissals", () => {
  it("round-trips a dismiss through localStorage", () => {
    expect(isVersionDismissed("0.3.0")).toBe(false);
    dismissVersion("0.3.0");
    expect(isVersionDismissed("0.3.0")).toBe(true);
  });

  it("is keyed per target version — newer versions still surface", () => {
    dismissVersion("0.3.0");
    expect(isVersionDismissed("0.3.0")).toBe(true);
    expect(isVersionDismissed("0.4.0")).toBe(false);
  });
});

describe("installUpdate", () => {
  it("drives download → install → restart-pending on the happy path", async () => {
    await installUpdater({ checkOnLaunch: false });
    const stub = makeStubUpdate({});
    stub.download.mockImplementation(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 1024 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 512 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 512 } });
      onEvent?.({ event: "Finished" });
    });
    checkMock.mockResolvedValue(stub);
    await checkForUpdate({ silent: true });
    // Carry the pending Update over — production code stashes this
    // automatically inside checkForUpdate, but the test harness
    // re-uses the stub directly.
    __setPendingUpdateForTests(
      stub as unknown as Parameters<typeof __setPendingUpdateForTests>[0],
    );

    const { snapshots, unsubscribe } = collectStates();
    await installUpdate();
    unsubscribe();

    const statuses = snapshots.map((s) => s.status);
    expect(statuses).toContain("downloading");
    expect(statuses).toContain("installing");
    expect(statuses.at(-1)).toBe("restart-pending");
    expect(stub.install).toHaveBeenCalled();
    // Look at the last downloading snapshot — the initial transition
    // resets totalBytes to null; the Started event populates it.
    const downloadSnapshots = snapshots.filter(
      (s) => s.status === "downloading",
    );
    const last = downloadSnapshots.at(-1);
    expect(last?.totalBytes).toBe(1024);
    expect(last?.downloadedBytes).toBe(1024);
  });

  it("abandons the install when the user cancels during download", async () => {
    await installUpdater({ checkOnLaunch: false });
    const stub = makeStubUpdate({});
    stub.download.mockImplementation(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 1024 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 256 } });
      // User clicks Cancel mid-download.
      abandonDownload();
      onEvent?.({ event: "Progress", data: { chunkLength: 768 } });
      onEvent?.({ event: "Finished" });
    });
    checkMock.mockResolvedValue(stub);
    await checkForUpdate({ silent: true });
    __setPendingUpdateForTests(
      stub as unknown as Parameters<typeof __setPendingUpdateForTests>[0],
    );

    await installUpdate();

    expect(stub.install).not.toHaveBeenCalled();
    expect(stub.close).toHaveBeenCalled();
  });
});

describe("mirror role", () => {
  beforeEach(() => {
    getCurrentWindowMock.mockReturnValue({ label: "settings" });
    __resetUpdaterForTests({ role: "main" }); // reset; installUpdater will flip role
  });

  it("subscribes to state events instead of running its own check", async () => {
    const listener: {
      stateHandler?: (evt: { payload: UpdaterState }) => void;
    } = {};
    listenMock.mockImplementation(async (channel: string, handler: unknown) => {
      if (channel === "updater:state") {
        listener.stateHandler = handler as typeof listener.stateHandler;
      }
      return () => {};
    });

    await installUpdater({ checkOnLaunch: true });
    const { stateHandler } = listener;
    if (!stateHandler) throw new Error("mirror listener was not registered");

    // Simulate main broadcasting an "available" state.
    const main: UpdaterState = {
      installKind: "macos",
      status: "available",
      update: {
        version: "0.4.0",
        currentVersion: "0.2.0",
      },
      lastCheckedAt: Date.now(),
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
    };
    stateHandler({ payload: main });

    const { snapshots, unsubscribe } = collectStates();
    // Re-trigger by sending another event so the new subscriber sees it.
    stateHandler({ payload: { ...main, status: "downloading" } });
    unsubscribe();

    expect(snapshots.at(-1)?.status).toBe("downloading");
  });

  it("forwards `Check now` via an event instead of calling check()", async () => {
    listenMock.mockResolvedValue(() => {});
    await installUpdater({ checkOnLaunch: false });

    await checkForUpdate({ silent: false });
    expect(emitMock).toHaveBeenCalledWith("updater:check-now");
    expect(checkMock).not.toHaveBeenCalled();
  });
});
