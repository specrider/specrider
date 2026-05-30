import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "../lib/updater";
import { TrustPrompt } from "../security/TrustPrompt";
import { TrustShield } from "../security/TrustShield";
import { DEFAULTS } from "../settings/types";
import type { GitStatus } from "../tauri/api";
import { TitleBar } from "./TitleBar";
import { UpdateAvailable } from "./UpdateAvailable";
import { WelcomeSplash } from "./WelcomeSplash";

const trustMocks = vi.hoisted(() => ({
  status: "trusted" as "loading" | "ask" | "trusted" | "untrusted",
  set: vi.fn(),
}));

const gitStatusMocks = vi.hoisted(() => ({
  status: null as GitStatus | null,
  refresh: vi.fn(),
}));

const updaterMocks = vi.hoisted(() => ({
  state: {
    installKind: "macos",
    status: "idle",
    update: null,
    lastCheckedAt: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  } as UpdaterState,
  abandonDownload: vi.fn(),
  discardPendingUpdate: vi.fn(),
  dismissVersion: vi.fn(),
  installUpdate: vi.fn(),
  isVersionDismissed: vi.fn(() => false),
  relaunchApp: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  listRecentProjects: vi.fn(),
  setPlansRoot: vi.fn(),
}));

const openerMocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

function recentProject(index: number) {
  return {
    path: `/Users/jake/Sites/project-${index}`,
    name: `Project ${index}`,
    displayPath: `~/Sites/project-${index}`,
    openedAt: index,
  };
}

vi.mock("../security/trust", () => ({
  useWorkspaceTrust: () => ({
    status: trustMocks.status,
    rootDecision: trustMocks.status === "ask" ? null : trustMocks.status,
    linkedRepos: [],
    pendingLinkedRepos: [],
    resolved: true,
    set: trustMocks.set,
  }),
}));

vi.mock("./ContextMenu", () => ({
  ContextMenu: (props: {
    items: Array<{
      label: string;
      divider?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
    }>;
    onClose: () => void;
  }) => (
    <div role="menu">
      {props.items
        .filter((item) => !item.divider)
        .map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect?.();
              props.onClose();
            }}
          >
            {item.label}
          </button>
        ))}
    </div>
  ),
}));

vi.mock("../hooks/gitStatusContext", () => ({
  useGitStatusContext: () => ({
    status: gitStatusMocks.status,
    refresh: gitStatusMocks.refresh,
  }),
}));

vi.mock("./GitCluster", () => ({
  GitCluster: (props: { onOpenUncommitted: () => void }) => (
    <button type="button" onClick={props.onOpenUncommitted}>
      Git cluster
    </button>
  ),
}));

vi.mock("../lib/updater", () => ({
  abandonDownload: updaterMocks.abandonDownload,
  discardPendingUpdate: updaterMocks.discardPendingUpdate,
  dismissVersion: updaterMocks.dismissVersion,
  installUpdate: updaterMocks.installUpdate,
  isVersionDismissed: updaterMocks.isVersionDismissed,
  releaseNotesUrl: (version: string) =>
    `https://example.test/releases/v${version}`,
  relaunchApp: updaterMocks.relaunchApp,
  useUpdaterState: () => updaterMocks.state,
}));

vi.mock("../tauri/api", () => ({
  listRecentProjects: apiMocks.listRecentProjects,
  setPlansRoot: apiMocks.setPlansRoot,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openerMocks.openUrl,
}));

function gitStatus(): GitStatus {
  return {
    inRepo: true,
    branch: "main",
    detached: false,
    shortSha: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty: false,
    conflicts: [],
    changes: [],
    inProgress: "none",
  };
}

function updateState(patch: Partial<UpdaterState> = {}): UpdaterState {
  return {
    installKind: "macos",
    status: "available",
    update: {
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: "Release notes",
    },
    lastCheckedAt: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    ...patch,
  };
}

describe("TrustPrompt and TrustShield", () => {
  beforeEach(() => {
    trustMocks.status = "ask";
    trustMocks.set.mockReset();
  });

  it("blocks the app until the user chooses a workspace trust decision", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <TrustPrompt plansRoot="/Users/jake/Sites/specs" homeDir="/Users/jake" />,
    );

    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByText("~/Sites/specs")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Don't trust" }));
    await user.click(
      screen.getByRole("button", { name: "Trust this workspace" }),
    );

    expect(trustMocks.set).toHaveBeenCalledWith("untrusted", {
      applyRoot: true,
      applyPendingLinkedRepos: false,
    });
    expect(trustMocks.set).toHaveBeenCalledWith("trusted", {
      applyRoot: true,
      applyPendingLinkedRepos: false,
    });

    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("opens shield actions and sends trust changes", async () => {
    const user = userEvent.setup();
    trustMocks.status = "trusted";
    render(<TrustShield plansRoot="/Users/jake/Sites/specs" />);

    await user.click(screen.getByRole("button", { name: "Workspace trusted" }));

    expect(
      screen.getByRole("menuitem", { name: "Trust this workspace" }),
    ).toHaveProperty("disabled", true);
    await user.click(
      screen.getByRole("menuitem", {
        name: "Don't trust this workspace",
      }),
    );
    expect(trustMocks.set).toHaveBeenCalledWith("untrusted", {
      applyRoot: true,
      applyPendingLinkedRepos: false,
    });
  });
});

describe("WelcomeSplash", () => {
  beforeEach(() => {
    apiMocks.listRecentProjects.mockReset();
    apiMocks.listRecentProjects.mockResolvedValue([
      {
        path: "/Users/jake/Sites/specs",
        name: "Specs",
        displayPath: "~/Sites/specs",
        openedAt: 1,
      },
    ]);
    apiMocks.setPlansRoot.mockReset();
    apiMocks.setPlansRoot.mockResolvedValue(undefined);
  });

  it("opens folders, files, and recent projects", async () => {
    const user = userEvent.setup();
    const onChooseFolder = vi.fn();
    const onChooseFile = vi.fn();

    render(
      <WelcomeSplash
        onChooseFolder={onChooseFolder}
        onChooseFile={onChooseFile}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Open a folder/ }));
    await user.click(
      screen.getByRole("button", { name: /Open a single file/ }),
    );
    await user.click(await screen.findByRole("button", { name: /Specs/ }));

    expect(onChooseFolder).toHaveBeenCalledTimes(1);
    expect(onChooseFile).toHaveBeenCalledTimes(1);
    expect(apiMocks.setPlansRoot).toHaveBeenCalledWith(
      "/Users/jake/Sites/specs",
    );
  });

  it("shows up to nine recent projects and opens them with number keys", async () => {
    apiMocks.listRecentProjects.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => recentProject(i + 1)),
    );

    render(<WelcomeSplash onChooseFolder={vi.fn()} onChooseFile={vi.fn()} />);

    expect(
      await screen.findByRole("button", { name: /Project 9/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Project 10/ })).toBeNull();

    fireEvent.keyDown(window, { key: "2" });

    expect(apiMocks.setPlansRoot).toHaveBeenCalledWith(
      "/Users/jake/Sites/project-2",
    );
  });
});

describe("TitleBar", () => {
  beforeEach(() => {
    trustMocks.status = "trusted";
    gitStatusMocks.status = gitStatus();
    updaterMocks.state = updateState();
    updaterMocks.isVersionDismissed.mockReset();
    updaterMocks.isVersionDismissed.mockReturnValue(false);
  });

  it("surfaces path, trust, git, update, and pane action controls", async () => {
    const user = userEvent.setup();
    const callbacks = {
      onToggleBrowser: vi.fn(),
      onOpenSearch: vi.fn(),
      onToggleOutline: vi.fn(),
      onToggleMarkdown: vi.fn(),
      onToggleTerminal: vi.fn(),
      onToggleDiff: vi.fn(),
      onOpenUncommitted: vi.fn(),
      onOpenUpdate: vi.fn(),
    };

    render(
      <TitleBar
        plansRoot="/Users/jake/Sites/specs"
        homeDir="/Users/jake"
        settings={DEFAULTS}
        browserVisible={true}
        outlineVisible={false}
        markdownOpen={false}
        terminalOpen={false}
        diffOpen={true}
        {...callbacks}
      />,
    );

    expect(screen.getByText("~/Sites/specs")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Update to v0.2.0/ }));
    await user.click(
      screen.getByRole("button", { name: "Search across documents" }),
    );
    await user.click(screen.getByRole("button", { name: "Toggle browser" }));
    await user.click(
      screen.getByRole("button", { name: "Toggle Markdown pane" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Toggle agent terminal" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Toggle diff explorer" }),
    );
    await user.click(screen.getByRole("button", { name: "Toggle outline" }));
    await user.click(screen.getByRole("button", { name: "Git cluster" }));

    expect(callbacks.onOpenUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenSearch).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleBrowser).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleMarkdown).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleDiff).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleOutline).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenUncommitted).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateAvailable", () => {
  beforeEach(() => {
    for (const mock of [
      updaterMocks.abandonDownload,
      updaterMocks.discardPendingUpdate,
      updaterMocks.dismissVersion,
      updaterMocks.installUpdate,
      updaterMocks.relaunchApp,
      openerMocks.openUrl,
    ]) {
      mock.mockReset();
    }
    updaterMocks.discardPendingUpdate.mockResolvedValue(undefined);
    updaterMocks.installUpdate.mockResolvedValue(undefined);
    updaterMocks.relaunchApp.mockResolvedValue(undefined);
    openerMocks.openUrl.mockResolvedValue(undefined);
  });

  it("opens release notes, installs, delays, and skips available updates", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <UpdateAvailable state={updateState()} onClose={onClose} />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /View full release notes on GitHub/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(openerMocks.openUrl).toHaveBeenCalledWith(
      "https://example.test/releases/v0.2.0",
    );
    expect(updaterMocks.installUpdate).toHaveBeenCalledTimes(1);

    rerender(<UpdateAvailable state={updateState()} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(updaterMocks.discardPendingUpdate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<UpdateAvailable state={updateState()} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Skip this version" }));
    expect(updaterMocks.dismissVersion).toHaveBeenCalledWith("0.2.0");
  });

  it("shows progress, abandons downloads on close, and restarts installed updates", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <UpdateAvailable
        state={updateState({
          status: "downloading",
          downloadedBytes: 512,
          totalBytes: 1024,
        })}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "50% downloaded",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(updaterMocks.abandonDownload).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <UpdateAvailable
        state={updateState({ status: "restart-pending" })}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    expect(updaterMocks.relaunchApp).toHaveBeenCalledTimes(1);
  });

  it("renders failed update recovery", async () => {
    const user = userEvent.setup();
    render(
      <UpdateAvailable
        state={updateState({ status: "error", error: "network failed" })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("network failed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(updaterMocks.installUpdate).toHaveBeenCalledTimes(1);
  });
});
