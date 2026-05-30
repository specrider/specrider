import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignLanes } from "../lib/commitGraphLanes";
import type { DiffReviewTab } from "../review/diffTabs";
import { DEFAULTS } from "../settings/types";
import type {
  ChangedFile,
  CommitDetail,
  FileChange,
  GitStatus,
  GraphCommit,
  RefEntry,
} from "../tauri/api";
import { CommitHistoryPane } from "./CommitHistoryPane";
import type { CommitSelection } from "./CommitHistoryRail";
import { DiffExplorerPane } from "./DiffExplorerPane";

const virtualizerMocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
}));

const gitStatusMocks = vi.hoisted(() => ({
  status: null as GitStatus | null,
  refresh: vi.fn(),
}));

const detailMocks = vi.hoisted(() => ({
  state: {
    detail: null,
    loading: false,
    error: null,
    loadFile: vi.fn(),
    refresh: vi.fn(),
  } as {
    detail: CommitDetail | null;
    loading: boolean;
    error: string | null;
    loadFile: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  },
}));

const diffBodyMocks = vi.hoisted(() => ({
  lastProps: null as null | {
    collapsedFiles?: ReadonlySet<string>;
    filterPath?: string | null;
    softWrap?: boolean;
  },
  scrollToPath: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  gitCommit: vi.fn(),
  gitInit: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "history-test" }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    estimateSize: (index: number) => number;
    getItemKey?: (index: number) => string | number;
  }) => {
    const sizes = Array.from({ length: options.count }, (_, index) =>
      options.estimateSize(index),
    );
    return {
      getTotalSize: () => sizes.reduce((sum, size) => sum + size, 0),
      getVirtualItems: () => {
        let start = 0;
        return sizes.map((size, index) => {
          const item = {
            index,
            key: options.getItemKey?.(index) ?? index,
            size,
            start,
          };
          start += size;
          return item;
        });
      },
      scrollToIndex: virtualizerMocks.scrollToIndex,
    };
  },
}));

vi.mock("../hooks/gitStatusContext", () => ({
  useGitStatusContext: () => ({
    status: gitStatusMocks.status,
    refresh: gitStatusMocks.refresh,
  }),
}));

vi.mock("../hooks/useCommitDetail", () => ({
  useCommitDetail: () => detailMocks.state,
}));

vi.mock("../hooks/useToasts", () => ({
  useToasts: () => ({ push: toastMocks.push }),
}));

vi.mock("../tauri/api", () => ({
  gitCommit: apiMocks.gitCommit,
  gitInit: apiMocks.gitInit,
  parseGitError: (err: unknown) =>
    err && typeof err === "object" && "message" in err
      ? err
      : { code: "git", message: String(err) },
}));

vi.mock("./RailGitActions", () => ({
  RailGitActions: (props: { onRefresh: () => void }) => (
    <button type="button" onClick={props.onRefresh}>
      Refresh git
    </button>
  ),
}));

vi.mock("./CommitDiffBody", () => ({
  fileKey: (file: FileChange) => `${file.path}:${file.oldPath ?? ""}`,
  CommitDiffBody: (props: {
    detail: CommitDetail | null;
    loading: boolean;
    error: string | null;
    softWrap: boolean;
    collapsedFiles: ReadonlySet<string>;
    filterPath?: string | null;
    findApiRef?: MutableRefObject<unknown>;
    scrollToPathRef?: MutableRefObject<((path: string) => void) | null>;
  }) => {
    diffBodyMocks.lastProps = props;
    if (props.scrollToPathRef) {
      props.scrollToPathRef.current = diffBodyMocks.scrollToPath;
    }
    if (props.findApiRef) {
      props.findApiRef.current = {
        search: vi.fn(() => []),
        activate: vi.fn(),
        clear: vi.fn(),
      };
    }
    return (
      <div
        data-testid="commit-diff-body"
        data-soft-wrap={String(props.softWrap)}
        data-collapsed-count={String(props.collapsedFiles.size)}
        data-filter-path={props.filterPath ?? ""}
      >
        {props.loading ? "Loading diff" : props.error || "Diff body"}
      </div>
    );
  },
}));

function changed(path: string, relToPlans: string | null): ChangedFile {
  return {
    path,
    relToPlans,
    kind: "modified",
    oldPath: null,
  };
}

function status(patch: Partial<GitStatus> = {}): GitStatus {
  return {
    inRepo: true,
    branch: "main",
    detached: false,
    shortSha: "c2",
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    dirty: true,
    conflicts: [],
    changes: [
      changed("active/a.md", "active/a.md"),
      changed("outside.txt", null),
    ],
    inProgress: "none",
    ...patch,
  };
}

function commit(
  sha: string,
  subject: string,
  parents: string[] = [],
): GraphCommit {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    timeSecs: 1_700_000_000,
    subject,
  };
}

function ref(patch: Partial<RefEntry>): RefEntry {
  return {
    name: "main",
    kind: "branch",
    targetSha: "c2",
    isHead: false,
    isDefaultBranch: false,
    ...patch,
  };
}

function file(patch: Partial<FileChange> = {}): FileChange {
  return {
    status: "modified",
    path: "active/a.md",
    oldPath: null,
    additions: 2,
    deletions: 1,
    hunks: [],
    binary: false,
    truncatedLines: null,
    large: false,
    ...patch,
  };
}

function detail(files: FileChange[]): CommitDetail {
  return {
    sha: "c2",
    shortSha: "c2",
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    timeSecs: 1_700_000_000,
    subject: "Add tests",
    body: "Detailed body",
    files,
  };
}

describe("CommitHistoryPane and CommitHistoryRail", () => {
  beforeEach(() => {
    virtualizerMocks.scrollToIndex.mockReset();
    gitStatusMocks.refresh.mockReset();
    gitStatusMocks.status = status();
    apiMocks.gitInit.mockReset();
    apiMocks.gitInit.mockResolvedValue(undefined);
  });

  it("renders unstaged state, unpushed dividers, refs, refresh, and keyboard selection", async () => {
    const commits = [
      commit("c2", "Add surface tests", ["c1"]),
      commit("c1", "Base commit"),
    ];
    const layout = assignLanes(commits);
    const onSelect = vi.fn();
    const onRefresh = vi.fn();
    const refsByCommit = new Map<string, RefEntry[]>([
      ["c2", [ref({ isHead: true, targetSha: "c2" })]],
      [
        "c1",
        [
          ref({
            name: "origin/main",
            kind: "remote",
            targetSha: "c1",
          }),
        ],
      ],
    ]);

    const { container } = render(
      <CommitHistoryPane
        commits={commits}
        layout={layout}
        derivedBySha={
          new Map([
            ["c2", { rel: "now", initials: "AL" }],
            ["c1", { rel: "yesterday", initials: "AL" }],
          ])
        }
        relevanceBySha={new Map()}
        refsByCommit={refsByCommit}
        displayRefsByCommit={refsByCommit}
        loading={false}
        loaded={true}
        error={null}
        hasUnstaged={true}
        selected={{ kind: "unstaged" }}
        onSelect={onSelect}
        onRefresh={onRefresh}
        showLanes={true}
        settings={DEFAULTS}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh git" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: /Uncommitted changes/ }),
    );
    expect(onSelect).toHaveBeenCalledWith({ kind: "unstaged" });
    expect(screen.getByText("↑ Unpushed · 1 commit")).toBeTruthy();
    expect(screen.getByText("origin/main")).toBeTruthy();

    const graph = container.querySelector(".ch-graph") as HTMLElement;
    screen.getByRole("button", { name: /1 of 2: Add surface tests/ }).focus();
    fireEvent.keyDown(graph, { key: "End" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /2 of 2: Base commit/ })
          .getAttribute("tabindex"),
      ).toBe("0"),
    );
    fireEvent.keyDown(graph, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ kind: "commit", sha: "c1" });
    expect(virtualizerMocks.scrollToIndex).toHaveBeenCalled();
  });

  it("surfaces loading, empty, no-repo init, and error graph states", async () => {
    const user = userEvent.setup();
    const props = {
      commits: [] as GraphCommit[],
      layout: { rows: [], laneCount: 0 },
      derivedBySha: new Map(),
      relevanceBySha: new Map(),
      refsByCommit: new Map(),
      displayRefsByCommit: new Map(),
      hasUnstaged: false,
      selected: null,
      onSelect: vi.fn(),
      onRefresh: vi.fn(),
      showLanes: true,
      settings: DEFAULTS,
    };

    const { rerender } = render(
      <CommitHistoryPane
        {...props}
        loading={true}
        loaded={false}
        error={null}
      />,
    );
    expect(screen.getByText("Loading...")).toBeTruthy();

    rerender(
      <CommitHistoryPane
        {...props}
        loading={false}
        loaded={true}
        error={null}
      />,
    );
    expect(screen.getByText("No commits yet.")).toBeTruthy();

    gitStatusMocks.status = status({ inRepo: false });
    rerender(
      <CommitHistoryPane
        {...props}
        loading={false}
        loaded={true}
        error={null}
      />,
    );
    expect(screen.getByText("No Git repository yet")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Initialize Git repository" }),
    );
    expect(apiMocks.gitInit).toHaveBeenCalledTimes(1);
    expect(gitStatusMocks.refresh).toHaveBeenCalledTimes(1);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <CommitHistoryPane
        {...props}
        loading={false}
        loaded={true}
        error="git log failed"
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("git log failed");
  });

  it("renders four review tabs as a readable 2x2 repo grid", () => {
    const tabs: DiffReviewTab[] = [
      { id: "docs", kind: "docs", label: "docs", repoPath: "/docs" },
      {
        id: "code",
        kind: "linked",
        label: "code @ main",
        repo: "code",
        branch: "main",
        base: "main",
        repoPath: "/code",
      },
      {
        id: "lander",
        kind: "linked",
        label: "lander @ main",
        repo: "lander",
        branch: "main",
        base: "main",
        repoPath: "/lander",
      },
      {
        id: "integrations",
        kind: "linked",
        label: "integrations @ main",
        repo: "integrations",
        branch: "main",
        base: "main",
        repoPath: "/integrations",
      },
    ];

    render(
      <CommitHistoryPane
        commits={[]}
        layout={{ rows: [], laneCount: 0 }}
        derivedBySha={new Map()}
        relevanceBySha={new Map()}
        refsByCommit={new Map()}
        displayRefsByCommit={new Map()}
        loading={false}
        loaded={true}
        error={null}
        hasUnstaged={false}
        selected={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        showLanes={true}
        settings={DEFAULTS}
        tabs={tabs}
        activeTabId="lander"
      />,
    );

    expect(
      screen
        .getByRole("tablist", { name: "Review repository" })
        .classList.contains("commit-review-tabs-2"),
    ).toBe(true);
    expect(screen.getByRole("tab", { name: "code/main" }).title).toBe(
      "code/main",
    );
    expect(screen.getByRole("tab", { name: "integrations/main" }).title).toBe(
      "integrations/main",
    );
  });
});

describe("DiffExplorerPane", () => {
  beforeEach(() => {
    localStorage.clear();
    gitStatusMocks.status = status();
    gitStatusMocks.refresh.mockReset();
    detailMocks.state = {
      detail: detail([
        file({ path: "active/a.md" }),
        file({ path: "outside.txt", large: true }),
      ]),
      loading: false,
      error: null,
      loadFile: vi.fn(),
      refresh: vi.fn(),
    };
    diffBodyMocks.lastProps = null;
    diffBodyMocks.scrollToPath.mockReset();
    apiMocks.gitCommit.mockReset();
    apiMocks.gitCommit.mockResolvedValue({ sha: "c3", shortSha: "c3" });
  });

  it("refreshes the unstaged diff after committing selected files", async () => {
    const user = userEvent.setup();

    render(
      <DiffExplorerPane
        open={true}
        selection={{ kind: "unstaged" }}
        commits={[]}
        findOpen={false}
        onCloseFind={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("1 of 2 files staged")).toBeTruthy(),
    );
    await user.type(screen.getByLabelText("Commit message"), "Save active doc");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() =>
      expect(apiMocks.gitCommit).toHaveBeenCalledWith("Save active doc", [
        "active/a.md",
      ]),
    );
    expect(gitStatusMocks.refresh).toHaveBeenCalledTimes(1);
    expect(detailMocks.state.refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("commit-diff-body").getAttribute("data-filter-path"),
    ).toBe("");
  });

  it("lazy-mounts, stages inside-plan files, filters, wraps, collapses, resizes, and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCloseFind = vi.fn();
    const selection = { kind: "unstaged" } satisfies CommitSelection;
    const commitSummary = commit("c2", "Add tests");

    const { container, rerender } = render(
      <DiffExplorerPane
        open={false}
        selection={selection}
        commits={[commitSummary]}
        findOpen={false}
        onCloseFind={onCloseFind}
        onClose={onClose}
      />,
    );

    expect(screen.queryByLabelText("Diff explorer")).toBeNull();

    rerender(
      <DiffExplorerPane
        open={true}
        selection={selection}
        commits={[commitSummary]}
        findOpen={true}
        onCloseFind={onCloseFind}
        onClose={onClose}
      />,
    );

    expect(screen.getByLabelText("Diff explorer")).toBeTruthy();
    expect(screen.getByLabelText("Find in diff")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("1 of 2 files staged")).toBeTruthy(),
    );

    await user.click(screen.getByRole("button", { name: /active\/a.md/ }));
    expect(detailMocks.state.loadFile).toHaveBeenCalledWith(
      detailMocks.state.detail?.files[0],
    );
    expect(diffBodyMocks.scrollToPath).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("commit-diff-body").getAttribute("data-filter-path"),
    ).toBe("active/a.md");
    expect(screen.getByRole("status").textContent).toContain("Showing 1 file");

    const fileList = container.querySelector<HTMLElement>(
      ".diff-explorer-files",
    );
    if (!fileList) throw new Error("expected diff explorer file list");
    await user.click(fileList);
    expect(
      screen.getByTestId("commit-diff-body").getAttribute("data-filter-path"),
    ).toBe("");

    await user.click(screen.getByLabelText("Wrap"));
    expect(
      screen.getByTestId("commit-diff-body").getAttribute("data-soft-wrap"),
    ).toBe("true");

    await user.click(
      screen.getByRole("button", { name: "Collapse all files" }),
    );
    await waitFor(() =>
      expect(diffBodyMocks.lastProps?.collapsedFiles?.size).toBe(2),
    );

    await user.click(screen.getByRole("button", { name: /active\/a.md/ }));
    await waitFor(() => {
      expect(diffBodyMocks.lastProps?.collapsedFiles?.size).toBe(1);
      expect(diffBodyMocks.lastProps?.collapsedFiles?.has("active/a.md:")).toBe(
        false,
      );
    });

    const splitter = screen.getByLabelText("Resize file list / diff body");
    expect(splitter.getAttribute("aria-valuenow")).toBe("30");
    fireEvent.keyDown(splitter, { key: "ArrowDown" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("32");
    expect(
      localStorage.getItem("specrider.diffExplorerSplit.v1.history-test"),
    ).toBe("0.32");

    await user.click(
      screen.getByRole("button", { name: "Close diff explorer" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
