import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openDialog,
}));

import {
  createPlan,
  exportToFile,
  getCommitGraph,
  gitInit,
  onTerminalExited,
  onTerminalOutput,
  parseGitError,
  pickPlansRoot,
  searchPlans,
  terminalReplay,
  terminalWrite,
} from "./api";

type ListenCallback<T> = (event: { payload: T }) => void;

describe("tauri api bridge", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.openDialog.mockReset();
  });

  it("sets the picked plans root only when the folder dialog returns a path", async () => {
    mocks.openDialog.mockResolvedValueOnce(null);

    await expect(pickPlansRoot()).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.openDialog.mockResolvedValueOnce("/tmp/specs");
    mocks.invoke.mockResolvedValueOnce(undefined);

    await expect(pickPlansRoot()).resolves.toBe("/tmp/specs");
    expect(mocks.openDialog).toHaveBeenLastCalledWith({
      directory: true,
      multiple: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("set_plans_root", {
      path: "/tmp/specs",
    });
  });

  it("maps export options to the Rust dialog command shape", async () => {
    mocks.invoke.mockResolvedValueOnce("/tmp/out.md");

    await expect(
      exportToFile({
        defaultPath: "plan.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
        contents: "# Plan\n",
      }),
    ).resolves.toBe("/tmp/out.md");

    expect(mocks.invoke).toHaveBeenCalledWith("export_with_dialog", {
      args: {
        defaultName: "plan.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
        contents: "# Plan\n",
      },
    });
  });

  it("passes optional createPlan and search arguments with stable defaults", async () => {
    mocks.invoke.mockResolvedValueOnce("active/new.md");
    await expect(createPlan("active/new", "# New\n")).resolves.toBe(
      "active/new.md",
    );
    expect(mocks.invoke).toHaveBeenCalledWith("create_plan", {
      rel: "active/new",
      initial: "# New\n",
    });

    mocks.invoke.mockResolvedValueOnce([]);
    await searchPlans("owner:jake");
    expect(mocks.invoke).toHaveBeenLastCalledWith("search_plans", {
      query: "owner:jake",
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
  });

  it("normalizes commit graph defaults before invoking Rust", async () => {
    mocks.invoke.mockResolvedValueOnce({ commits: [], planRelevance: [] });

    await getCommitGraph({ planRel: "active/a.md" });

    expect(mocks.invoke).toHaveBeenCalledWith("git_log_graph", {
      args: {
        planRel: "active/a.md",
        branches: [],
        commitShas: [],
        repoHandle: null,
        reviewBranch: null,
        reviewBase: null,
        limit: null,
        beforeSha: null,
      },
    });
  });

  it("invokes git init without renderer-side arguments", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);

    await expect(gitInit()).resolves.toBeUndefined();

    expect(mocks.invoke).toHaveBeenCalledWith("git_init");
  });

  it("encodes terminal writes and decodes replay payloads", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    await terminalWrite("s1", "hi");
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_write", {
      args: { session_id: "s1", bytes_b64: "aGk=" },
    });

    mocks.invoke.mockResolvedValueOnce(undefined);
    await terminalWrite("s1", new Uint8Array([0, 255]));
    expect(mocks.invoke).toHaveBeenLastCalledWith("terminal_write", {
      args: { session_id: "s1", bytes_b64: "AP8=" },
    });

    mocks.invoke.mockResolvedValueOnce({ bytes_b64: "aGk=" });
    await expect(terminalReplay("s1")).resolves.toEqual(
      new Uint8Array([104, 105]),
    );
  });

  it("maps terminal event payloads from Rust snake_case to frontend camelCase", async () => {
    const unlisten = vi.fn();
    let outputCallback: ListenCallback<{
      session_id: string;
      chunk_b64: string;
    }> = () => {
      throw new Error("terminal-output listener was not registered");
    };
    let exitedCallback: ListenCallback<{
      session_id: string;
      exit_code: number | null;
    }> = () => {
      throw new Error("terminal-exited listener was not registered");
    };
    mocks.listen.mockImplementation((event: string, cb: unknown) => {
      if (event === "terminal-output") {
        outputCallback = cb as ListenCallback<{
          session_id: string;
          chunk_b64: string;
        }>;
      }
      if (event === "terminal-exited") {
        exitedCallback = cb as ListenCallback<{
          session_id: string;
          exit_code: number | null;
        }>;
      }
      return Promise.resolve(unlisten);
    });

    const onOutput = vi.fn();
    const onExited = vi.fn();

    await expect(onTerminalOutput(onOutput)).resolves.toBe(unlisten);
    await expect(onTerminalExited(onExited)).resolves.toBe(unlisten);

    outputCallback({
      payload: { session_id: "s1", chunk_b64: "aGk=" },
    });
    exitedCallback({
      payload: { session_id: "s1", exit_code: 0 },
    });

    expect(onOutput).toHaveBeenCalledWith({
      sessionId: "s1",
      chunkB64: "aGk=",
    });
    expect(onExited).toHaveBeenCalledWith({
      sessionId: "s1",
      exitCode: 0,
    });
  });

  it("keeps structured git operation errors and wraps plain failures", () => {
    const structured = { code: "dirty-tree", message: "commit first" };
    expect(parseGitError(structured)).toBe(structured);
    expect(parseGitError("boom")).toEqual({ code: "git", message: "boom" });
  });
});
