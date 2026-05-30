import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitGraphResponse, GraphCommit, RefEntry } from "../tauri/api";
import { useCommitGraph } from "./useCommitGraph";
import { useHasUncommittedChanges } from "./useHasUncommittedChanges";

const apiMocks = vi.hoisted(() => ({
  getCommitGraph: vi.fn(),
  getGitRefs: vi.fn(),
  getHasUncommittedChanges: vi.fn(),
  onPlanChanged: vi.fn(),
  onWorkspaceTrustChanged: vi.fn(),
}));

vi.mock("../tauri/api", () => ({
  getCommitGraph: apiMocks.getCommitGraph,
  getGitRefs: apiMocks.getGitRefs,
  getHasUncommittedChanges: apiMocks.getHasUncommittedChanges,
  onPlanChanged: apiMocks.onPlanChanged,
  onWorkspaceTrustChanged: apiMocks.onWorkspaceTrustChanged,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function commit(sha: string): GraphCommit {
  return {
    sha,
    shortSha: sha.slice(0, 8),
    parents: [],
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    timeSecs: 1_700_000_000,
    subject: `Commit ${sha}`,
  };
}

describe("git async hooks", () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    apiMocks.getGitRefs.mockResolvedValue([] satisfies RefEntry[]);
    apiMocks.onPlanChanged.mockResolvedValue(vi.fn());
    apiMocks.onWorkspaceTrustChanged.mockResolvedValue(vi.fn());
  });

  it("hides stale commit graph rows while a new repo target is loading", async () => {
    const docsCommit = commit("docs-sha");
    const codeCommit = commit("code-sha");
    const codeGraph = deferred<CommitGraphResponse>();

    apiMocks.getCommitGraph.mockImplementation(
      (args: { repoHandle?: string | null }) => {
        if (args.repoHandle === "code") return codeGraph.promise;
        return Promise.resolve({
          commits: [docsCommit],
          planRelevance: [],
        });
      },
    );

    const initialProps: { repoHandle: string | null } = { repoHandle: null };
    const { result, rerender } = renderHook(
      ({ repoHandle }: { repoHandle: string | null }) =>
        useCommitGraph({
          planRel: null,
          branches: [],
          commitShas: [],
          repoHandle,
        }),
      { initialProps },
    );

    await waitFor(() => expect(result.current.commits).toEqual([docsCommit]));

    rerender({ repoHandle: "code" });

    expect(result.current.commits).toEqual([]);
    expect(result.current.loaded).toBe(false);

    await act(async () => {
      codeGraph.resolve({ commits: [codeCommit], planRelevance: [] });
      await codeGraph.promise;
    });

    await waitFor(() => expect(result.current.commits).toEqual([codeCommit]));
  });

  it("returns null instead of stale uncommitted state after the repo target changes", async () => {
    const codeDirty = deferred<boolean>();

    apiMocks.getHasUncommittedChanges.mockImplementation(
      (repoHandle?: string | null) => {
        if (repoHandle === "code") return codeDirty.promise;
        return Promise.resolve(false);
      },
    );

    const initialProps: { repoHandle: string | null } = { repoHandle: null };
    const { result, rerender } = renderHook(
      ({ repoHandle }: { repoHandle: string | null }) =>
        useHasUncommittedChanges(true, repoHandle),
      { initialProps },
    );

    await waitFor(() => expect(result.current).toBe(false));

    rerender({ repoHandle: "code" });

    expect(result.current).toBeNull();

    await act(async () => {
      codeDirty.resolve(true);
      await codeDirty.promise;
    });

    await waitFor(() => expect(result.current).toBe(true));
  });
});
