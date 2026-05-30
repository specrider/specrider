import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../settings/types";
import type {
  BranchEntry,
  ChangedFile,
  FileChange,
  GitStatus,
} from "../tauri/api";
import { BranchPicker } from "./BranchPicker";
import { CommitFileList } from "./CommitFileList";
import { CommitPanel } from "./CommitPanel";
import { GitCluster } from "./GitCluster";
import { RailGitActions } from "./RailGitActions";

const apiMocks = vi.hoisted(() => ({
  getGitBranches: vi.fn(),
  getGitStatus: vi.fn(),
  gitAbortMerge: vi.fn(),
  gitCheckout: vi.fn(),
  gitCommit: vi.fn(),
  gitCreateBranch: vi.fn(),
  gitFetch: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
}));

const gitStatusMocks = vi.hoisted(() => ({
  status: null as GitStatus | null,
  refresh: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  ask: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: dialogMocks.ask,
}));

vi.mock("../tauri/api", () => ({
  getGitBranches: apiMocks.getGitBranches,
  getGitStatus: apiMocks.getGitStatus,
  gitAbortMerge: apiMocks.gitAbortMerge,
  gitCheckout: apiMocks.gitCheckout,
  gitCommit: apiMocks.gitCommit,
  gitCreateBranch: apiMocks.gitCreateBranch,
  gitFetch: apiMocks.gitFetch,
  gitPull: apiMocks.gitPull,
  gitPush: apiMocks.gitPush,
  parseGitError: (err: unknown) =>
    err && typeof err === "object" && "message" in err
      ? err
      : { code: "git", message: String(err) },
}));

vi.mock("../hooks/gitStatusContext", () => ({
  useGitStatusContext: () => ({
    status: gitStatusMocks.status,
    refresh: gitStatusMocks.refresh,
  }),
}));

vi.mock("../hooks/useToasts", () => ({
  useToasts: () => ({ push: toastMocks.push }),
}));

function changed(path: string, relToPlans = path): ChangedFile {
  return {
    path,
    relToPlans,
    kind: "modified",
    oldPath: null,
  };
}

function status(patch: Partial<GitStatus> = {}): GitStatus {
  const changes = patch.changes ?? [changed("active/phase-six.md")];
  return {
    inRepo: true,
    branch: "main",
    detached: false,
    shortSha: "abc1234",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty: changes.length > 0,
    conflicts: [],
    changes,
    inProgress: "none",
    ...patch,
  };
}

function branch(patch: Partial<BranchEntry>): BranchEntry {
  return {
    name: "main",
    isRemote: false,
    remote: null,
    lastCommitSecs: 1_700_000_000,
    lastCommitSubject: "Initial commit",
    aheadMain: 0,
    behindMain: 0,
    isCurrent: false,
    ...patch,
  };
}

function file(patch: Partial<FileChange> = {}): FileChange {
  return {
    status: "modified",
    path: "active/phase-six.md",
    oldPath: null,
    additions: 3,
    deletions: 1,
    hunks: [],
    binary: false,
    truncatedLines: null,
    large: false,
    ...patch,
  };
}

describe("BranchPicker", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    toastMocks.push.mockReset();
    apiMocks.getGitBranches.mockResolvedValue([
      branch({ name: "main", isCurrent: true }),
      branch({
        name: "feature/coverage",
        lastCommitSubject: "Add UI tests",
        aheadMain: 2,
      }),
    ]);
    apiMocks.gitCheckout.mockResolvedValue(undefined);
    apiMocks.gitCreateBranch.mockResolvedValue(undefined);
    apiMocks.gitAbortMerge.mockResolvedValue(undefined);
  });

  it("loads branches, switches selection, and refreshes the parent", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onChanged = vi.fn();

    render(
      <BranchPicker
        status={status({ dirty: false, changes: [] })}
        settings={DEFAULTS}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    expect(apiMocks.getGitBranches).toHaveBeenCalledWith(false);
    await user.click(
      await screen.findByRole("button", { name: /feature\/coverage/ }),
    );

    expect(apiMocks.gitCheckout).toHaveBeenCalledWith(
      "feature/coverage",
      false,
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastMocks.push).toHaveBeenCalledWith(
      "Switched to feature/coverage",
      { tone: "success" },
    );
  });

  it("creates prefixed branches and can abort in-progress operations", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onChanged = vi.fn();

    const { rerender } = render(
      <BranchPicker
        status={status({ dirty: false, changes: [] })}
        settings={{ ...DEFAULTS, gitBranchPrefix: "specs/" }}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    await screen.findByRole("button", { name: /feature\/coverage/ });
    await user.click(screen.getByRole("button", { name: "+ New branch" }));
    const input = screen.getByPlaceholderText("branch-name");
    await user.clear(input);
    await user.type(input, "specs/large-ui");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(apiMocks.gitCreateBranch).toHaveBeenCalledWith(
        "specs/large-ui",
        "main",
      ),
    );

    rerender(
      <BranchPicker
        status={status({ inProgress: "merge" })}
        settings={DEFAULTS}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Abort merge" }));

    expect(apiMocks.gitAbortMerge).toHaveBeenCalledTimes(1);
    expect(toastMocks.push).toHaveBeenCalledWith("Aborted merge", {
      tone: "info",
    });
  });
});

describe("GitCluster", () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    gitStatusMocks.refresh.mockReset();
    apiMocks.getGitBranches.mockResolvedValue([
      branch({ name: "main", isCurrent: true }),
    ]);
  });

  it("summarizes dirty, ahead, behind, conflict, and no-upstream states", async () => {
    const user = userEvent.setup();
    const onOpenUncommitted = vi.fn();
    gitStatusMocks.status = status({
      upstream: null,
      ahead: 2,
      behind: 1,
      conflicts: [{ path: "active/conflict.md", relToPlans: "conflict.md" }],
    });

    render(
      <GitCluster settings={DEFAULTS} onOpenUncommitted={onOpenUncommitted} />,
    );

    expect(screen.getByText("no upstream")).toBeTruthy();
    expect(screen.getByText("⚠ 1 conflict")).toBeTruthy();
    expect(screen.getByText("↑2")).toBeTruthy();
    expect(screen.getByText("↓1")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Open uncommitted changes" }),
    );
    expect(onOpenUncommitted).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: /Branch main. Click to switch./ }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Switch branch" }),
    ).toBeTruthy();
  });
});

describe("RailGitActions", () => {
  beforeEach(() => {
    gitStatusMocks.status = status({ ahead: 1, dirty: false, changes: [] });
    gitStatusMocks.refresh.mockReset();
    toastMocks.push.mockReset();
    dialogMocks.ask.mockReset();
    for (const mock of [
      apiMocks.getGitStatus,
      apiMocks.gitFetch,
      apiMocks.gitPull,
      apiMocks.gitPush,
    ]) {
      mock.mockReset();
    }
    dialogMocks.ask.mockResolvedValue(true);
    apiMocks.gitPush.mockResolvedValue(undefined);
    apiMocks.gitPull.mockResolvedValue({ commits: [], upToDate: true });
    apiMocks.gitFetch.mockResolvedValue(true);
  });

  it("confirms before pushing directly to main and then lets git push run", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(<RailGitActions settings={DEFAULTS} onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Push" }));

    expect(dialogMocks.ask).toHaveBeenCalledWith("Push directly to main?", {
      title: "Push to main",
      kind: "warning",
      okLabel: "Push",
      cancelLabel: "Cancel",
    });
    await waitFor(() =>
      expect(apiMocks.gitPush).toHaveBeenCalledWith(true, null, null),
    );
    expect(gitStatusMocks.refresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(toastMocks.push).toHaveBeenCalledWith("Pushed upstream to main.", {
      tone: "success",
    });
  });

  it("does not push when the direct-main confirmation is cancelled", async () => {
    const user = userEvent.setup();
    dialogMocks.ask.mockResolvedValueOnce(false);

    render(<RailGitActions settings={DEFAULTS} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Push" }));

    await waitFor(() => expect(dialogMocks.ask).toHaveBeenCalledTimes(1));
    expect(apiMocks.gitPush).not.toHaveBeenCalled();
  });

  it("can still enforce the local hard block setting", async () => {
    const user = userEvent.setup();

    render(
      <RailGitActions
        settings={{ ...DEFAULTS, gitAllowDirectPushToMain: false }}
        onRefresh={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Push" }));

    expect(dialogMocks.ask).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(apiMocks.gitPush).toHaveBeenCalledWith(false, null, null),
    );
  });
});

describe("CommitPanel", () => {
  beforeEach(() => {
    apiMocks.gitCommit.mockReset();
    apiMocks.gitCommit.mockResolvedValue({ sha: "abcdef", shortSha: "abcdef" });
    toastMocks.push.mockReset();
  });

  it("commits only selected files and clears the message after success", async () => {
    const user = userEvent.setup();
    const onCommitted = vi.fn();

    render(
      <CommitPanel
        files={[file({ path: "active/a.md" }), file({ path: "active/b.md" })]}
        selectedForCommit={new Set(["active/b.md", "missing.md"])}
        onCommitted={onCommitted}
      />,
    );

    expect(screen.getByText("1 of 2 files staged")).toBeTruthy();
    await user.type(
      screen.getByLabelText("Commit message"),
      "Add phase six coverage",
    );
    await user.click(screen.getByRole("button", { name: "Commit" }));

    expect(apiMocks.gitCommit).toHaveBeenCalledWith("Add phase six coverage", [
      "active/b.md",
    ]);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(toastMocks.push).toHaveBeenCalledWith(
      "Committed abcdef: Add phase six coverage",
      { tone: "success" },
    );
    await waitFor(() => {
      const message = screen.getByLabelText(
        "Commit message",
      ) as HTMLTextAreaElement;
      expect(message.value).toBe("");
    });
  });
});

describe("CommitFileList", () => {
  it("supports staging, selecting, and clearing file rows", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClearSelection = vi.fn();
    const onToggleCommit = vi.fn();
    const onToggleCommitAll = vi.fn();

    const { rerender } = render(
      <CommitFileList
        files={[
          file({ path: "active/a.md", additions: 2, deletions: 0 }),
          file({
            path: "very/deep/nested/path/renamed.md",
            oldPath: "very/deep/nested/path/old.md",
            status: "renamed",
          }),
        ]}
        selectedPath="active/a.md"
        onSelect={onSelect}
        onClearSelection={onClearSelection}
        selectedForCommit={new Set(["active/a.md"])}
        onToggleCommit={onToggleCommit}
        onToggleCommitAll={onToggleCommitAll}
      />,
    );

    await user.click(screen.getByLabelText("Toggle all"));
    expect(onToggleCommitAll).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText("Include active/a.md in commit"));
    expect(onToggleCommit).toHaveBeenCalledWith("active/a.md");

    await user.click(screen.getByRole("button", { name: /active\/a.md/ }));
    expect(onSelect).toHaveBeenCalledWith("active/a.md");

    rerender(
      <CommitFileList
        files={[file({ path: "active/a.md" })]}
        selectedPath="active/a.md"
        onSelect={onSelect}
        onClearSelection={onClearSelection}
      />,
    );

    await user.click(screen.getByRole("button", { name: "clear" }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});
