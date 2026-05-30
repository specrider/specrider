import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import type { Theme } from "./themes";
import { DEFAULTS, type ResolvedSettings } from "./types";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

const openerMocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

const updaterMocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdater: vi.fn(),
  releaseNotesUrl: vi.fn(),
  supportsUpdater: vi.fn(),
  useUpdaterState: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  diagnosticsSnapshot: vi.fn(),
  readWorkspaceConfigSource: vi.fn(),
  writeWorkspaceConfigSource: vi.fn(),
}));

const cssMocks = vi.hoisted(() => ({
  useApplyCss: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  effective: {} as ResolvedSettings,
  customThemes: [] as Theme[],
  loaded: true,
  reset: vi.fn(),
  themes: [
    { id: "paper", name: "Paper", type: "light", variables: {} },
    { id: "sepia", name: "Sepia", type: "light", variables: {} },
    { id: "ink", name: "Ink", type: "dark", variables: {} },
  ] as Theme[],
  update: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: coreMocks.invoke,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: clipboardMocks.writeText,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.open,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openerMocks.openUrl,
}));

vi.mock("../lib/updater", () => ({
  checkForUpdate: updaterMocks.checkForUpdate,
  installUpdater: updaterMocks.installUpdater,
  releaseNotesUrl: updaterMocks.releaseNotesUrl,
  supportsUpdater: updaterMocks.supportsUpdater,
  useUpdaterState: updaterMocks.useUpdaterState,
}));

vi.mock("../tauri/api", () => ({
  diagnosticsSnapshot: apiMocks.diagnosticsSnapshot,
  readWorkspaceConfigSource: apiMocks.readWorkspaceConfigSource,
  writeWorkspaceConfigSource: apiMocks.writeWorkspaceConfigSource,
}));

vi.mock("./applyCss", () => ({
  useApplyCss: cssMocks.useApplyCss,
}));

vi.mock("./store", () => ({
  useSettings: () => storeMocks,
}));

function diagnosticsSnapshot(markdown = "## Diagnostics") {
  return {
    appVersion: "0.1.0",
    tauriVersion: "2.0.0",
    os: "macOS",
    osVersion: "15.0",
    arch: "arm64",
    targetTriple: "aarch64-apple-darwin",
    webview: "WebKit",
    locale: "en-US",
    plansRootBound: true,
    workspaceTrust: "trusted",
    windowsOpen: 1,
    settings: {},
    featureFlags: [],
    markdown,
  };
}

describe("Settings", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of [
      ...Object.values(coreMocks),
      ...Object.values(clipboardMocks),
      ...Object.values(dialogMocks),
      ...Object.values(openerMocks),
      ...Object.values(updaterMocks),
      ...Object.values(apiMocks),
      ...Object.values(cssMocks),
      storeMocks.reset,
      storeMocks.update,
    ]) {
      mock.mockReset();
    }
    Object.assign(storeMocks.effective, {
      ...DEFAULTS,
      theme: "system",
      themeLightId: "paper",
      themeDarkId: "ink",
    });
    storeMocks.customThemes = [];
    storeMocks.loaded = true;
    storeMocks.update.mockResolvedValue(undefined);
    storeMocks.reset.mockResolvedValue(undefined);
    coreMocks.invoke.mockResolvedValue(undefined);
    clipboardMocks.writeText.mockResolvedValue(undefined);
    dialogMocks.open.mockResolvedValue(null);
    openerMocks.openUrl.mockResolvedValue(undefined);
    updaterMocks.checkForUpdate.mockResolvedValue(undefined);
    updaterMocks.installUpdater.mockResolvedValue(vi.fn());
    updaterMocks.releaseNotesUrl.mockImplementation(
      (version: string) =>
        `https://github.com/specrider/specrider/releases/tag/v${version}`,
    );
    updaterMocks.supportsUpdater.mockReturnValue(true);
    updaterMocks.useUpdaterState.mockReturnValue({
      installKind: "macos",
      status: "none",
      update: { currentVersion: "0.1.0", version: "0.1.0" },
      lastCheckedAt: null,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
    });
    apiMocks.diagnosticsSnapshot.mockResolvedValue(diagnosticsSnapshot());
    apiMocks.readWorkspaceConfigSource.mockResolvedValue({
      exists: false,
      path: "/plans/.specrider/workspace.json",
      source:
        '{\n  "schema_version": "1",\n  "statuses": [],\n  "review_required_signoffs": 0,\n  "default_status": "draft",\n  "repos": {}\n}\n',
    });
    apiMocks.writeWorkspaceConfigSource.mockResolvedValue({
      exists: true,
      path: "/plans/.specrider/workspace.json",
      source: "file",
      config: {
        schema_version: "1",
        statuses: [],
        review_required_signoffs: 0,
        default_status: "draft",
        repos: {},
      },
    });
  });

  it("navigates sections and resets the active section", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole("tab", { name: "Appearance" }));

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reset section" }));

    expect(storeMocks.reset).toHaveBeenCalledWith("appearance");
  });

  it("updates theme selection and common form controls", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole("radio", { name: "Sepia" }));
    expect(storeMocks.update).toHaveBeenCalledWith("themeLightId", "sepia");

    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    fireEvent.change(screen.getByPlaceholderText("default"), {
      target: { value: "#112233" },
    });
    expect(storeMocks.update).toHaveBeenCalledWith("accent", "#112233");

    await user.click(screen.getByRole("radio", { name: "Dense" }));
    expect(storeMocks.update).toHaveBeenCalledWith("density", "dense");

    await user.click(screen.getByRole("tab", { name: "Editor & Outline" }));
    await user.click(screen.getByRole("switch", { name: "Line numbers" }));
    expect(storeMocks.update).toHaveBeenCalledWith("editorLineNumbers", false);
  });

  it("runs updater controls from the System & Updates section", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole("tab", { name: "System & Updates" }));
    await user.click(
      screen.getByRole("switch", { name: "Check for updates on launch" }),
    );
    expect(storeMocks.update).toHaveBeenCalledWith(
      "checkForUpdatesOnLaunch",
      false,
    );

    await user.click(screen.getByRole("radio", { name: "Pre-release" }));
    expect(storeMocks.update).toHaveBeenCalledWith("updateChannel", "pre");

    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(updaterMocks.checkForUpdate).toHaveBeenCalledWith({
      silent: false,
    });
  });

  it("copies diagnostics from the System & Updates section", async () => {
    const user = userEvent.setup();
    apiMocks.diagnosticsSnapshot
      .mockResolvedValueOnce(diagnosticsSnapshot("initial"))
      .mockResolvedValueOnce(diagnosticsSnapshot("fresh"));
    render(<Settings />);

    await user.click(screen.getByRole("tab", { name: "System & Updates" }));
    await waitFor(() =>
      expect(screen.getByText("0.1.0 (Tauri 2.0.0)")).toBeTruthy(),
    );

    await user.click(screen.getByRole("button", { name: "Copy diagnostics" }));

    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenCalledWith("fresh"),
    );
    expect(screen.getByRole("status").textContent).toContain("Copied");
  });

  it("loads and saves workspace config JSON from the active workspace", async () => {
    const user = userEvent.setup();
    localStorage.setItem("specrider.activePlansRoot.v1", "/plans");
    render(<Settings />);

    await user.click(screen.getByRole("tab", { name: "Workspace" }));

    await waitFor(() =>
      expect(apiMocks.readWorkspaceConfigSource).toHaveBeenCalledWith("/plans"),
    );
    expect(screen.getByText("/plans/.specrider/workspace.json")).toBeTruthy();
    expect(screen.getByText("Not created yet")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Create config" }));

    await waitFor(() =>
      expect(apiMocks.writeWorkspaceConfigSource).toHaveBeenCalledWith(
        expect.stringContaining('"repos": {}'),
        "/plans",
      ),
    );
  });
});
