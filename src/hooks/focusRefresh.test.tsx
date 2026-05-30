import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundFetch } from "./useBackgroundFetch";
import { useCommitGraph } from "./useCommitGraph";
import { useGitStatus } from "./useGitStatus";
import { useHasUncommittedChanges } from "./useHasUncommittedChanges";

const apiMocks = vi.hoisted(() => ({
  getCommitGraph: vi.fn(),
  getGitRefs: vi.fn(),
  getGitStatus: vi.fn(),
  getHasUncommittedChanges: vi.fn(),
  gitFetch: vi.fn(),
  onGitFetchComplete: vi.fn(),
  onPlanChanged: vi.fn(),
  onWorkspaceTrustChanged: vi.fn(),
}));

vi.mock("../tauri/api", () => ({
  getCommitGraph: apiMocks.getCommitGraph,
  getGitRefs: apiMocks.getGitRefs,
  getGitStatus: apiMocks.getGitStatus,
  getHasUncommittedChanges: apiMocks.getHasUncommittedChanges,
  gitFetch: apiMocks.gitFetch,
  onGitFetchComplete: apiMocks.onGitFetchComplete,
  onPlanChanged: apiMocks.onPlanChanged,
  onWorkspaceTrustChanged: apiMocks.onWorkspaceTrustChanged,
}));

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

describe("focus refresh behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    apiMocks.getCommitGraph.mockResolvedValue({
      commits: [],
      planRelevance: [],
    });
    apiMocks.getGitRefs.mockResolvedValue([]);
    apiMocks.getGitStatus.mockResolvedValue({});
    apiMocks.getHasUncommittedChanges.mockResolvedValue(false);
    apiMocks.gitFetch.mockResolvedValue(false);
    apiMocks.onGitFetchComplete.mockResolvedValue(vi.fn());
    apiMocks.onPlanChanged.mockResolvedValue(vi.fn());
    apiMocks.onWorkspaceTrustChanged.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentHidden(false);
  });

  it("does not refresh git hooks on window focus", () => {
    renderHook(() => useGitStatus(0));
    renderHook(() =>
      useCommitGraph({
        planRel: "active/alpha.md",
        branches: [],
        commitShas: [],
      }),
    );
    renderHook(() => useHasUncommittedChanges(true));

    expect(apiMocks.getGitStatus).toHaveBeenCalledTimes(1);
    expect(apiMocks.getCommitGraph).toHaveBeenCalledTimes(1);
    expect(apiMocks.getHasUncommittedChanges).toHaveBeenCalledTimes(1);

    apiMocks.getGitStatus.mockClear();
    apiMocks.getCommitGraph.mockClear();
    apiMocks.getHasUncommittedChanges.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(500);
    });

    expect(apiMocks.getGitStatus).not.toHaveBeenCalled();
    expect(apiMocks.getCommitGraph).not.toHaveBeenCalled();
    expect(apiMocks.getHasUncommittedChanges).not.toHaveBeenCalled();
  });

  it("resumes git status polling after visibility returns without an immediate refresh", () => {
    setDocumentHidden(true);
    renderHook(() => useGitStatus(5_000));

    expect(apiMocks.getGitStatus).toHaveBeenCalledTimes(1);
    apiMocks.getGitStatus.mockClear();

    act(() => {
      setDocumentHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(4_999);
    });
    expect(apiMocks.getGitStatus).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(apiMocks.getGitStatus).toHaveBeenCalledTimes(1);
  });

  it("resumes background fetch after visibility returns without an immediate fetch", () => {
    setDocumentHidden(true);
    renderHook(() => useBackgroundFetch(60));

    act(() => {
      setDocumentHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(59_999);
    });
    expect(apiMocks.gitFetch).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(apiMocks.gitFetch).toHaveBeenCalledTimes(1);
  });
});
