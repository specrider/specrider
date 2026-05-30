import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanFileMeta } from "../tauri/api";
import { usePlanWorkspace } from "./usePlanWorkspace";

const apiMocks = vi.hoisted(() => ({
  analyzePlans: vi.fn(),
  getInitialState: vi.fn(),
  getPlansRoot: vi.fn(),
  getWorkspaceConfig: vi.fn(),
  listPlans: vi.fn(),
  onPlanChanged: vi.fn(),
  onPlansRootChanged: vi.fn(),
  onWorkspaceConfigChanged: vi.fn(),
  readPlan: vi.fn(),
  writePlan: vi.fn(),
}));

const parseMocks = vi.hoisted(() => ({
  parseInWorker: vi.fn(),
}));

vi.mock("../tauri/api", () => ({
  analyzePlans: apiMocks.analyzePlans,
  getInitialState: apiMocks.getInitialState,
  getPlansRoot: apiMocks.getPlansRoot,
  getWorkspaceConfig: apiMocks.getWorkspaceConfig,
  listPlans: apiMocks.listPlans,
  onPlanChanged: apiMocks.onPlanChanged,
  onPlansRootChanged: apiMocks.onPlansRootChanged,
  onWorkspaceConfigChanged: apiMocks.onWorkspaceConfigChanged,
  readPlan: apiMocks.readPlan,
  writePlan: apiMocks.writePlan,
}));

vi.mock("../markdown/parseInWorker", () => ({
  parseInWorker: parseMocks.parseInWorker,
}));

let planChangedHandler:
  | ((event: {
      path: string;
      kind: "created" | "modified" | "removed";
    }) => void)
  | null = null;

function meta(path: string, h1: string): PlanFileMeta {
  return {
    path,
    modifiedSecs: 1_700_000_000,
    size: 32,
    lineCount: 2,
    wordCount: 4,
    taskDone: 0,
    taskTotal: 0,
    frontmatter: null,
    h1,
  };
}

function fastMeta(path: string): PlanFileMeta {
  return {
    ...meta(path, ""),
    lineCount: 0,
    wordCount: 0,
    taskDone: 0,
    taskTotal: 0,
    frontmatter: null,
    h1: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderWorkspace(
  args: Partial<Parameters<typeof usePlanWorkspace>[0]> = {},
) {
  return renderHook(() =>
    usePlanWorkspace({
      defaultReaderMode: "read",
      persistedActivePlanPath: null,
      planTitleSource: "heading",
      settingsLoaded: true,
      ...args,
    }),
  );
}

describe("usePlanWorkspace", () => {
  beforeEach(() => {
    planChangedHandler = null;
    delete (window as Window & { __SR_INITIAL_PLAN__?: string })
      .__SR_INITIAL_PLAN__;
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    parseMocks.parseInWorker.mockReset();
    parseMocks.parseInWorker.mockResolvedValue({
      tree: parseTreeStub(),
      outline: [],
      progress: { done: 0, total: 0 },
    });
    apiMocks.getInitialState.mockResolvedValue({
      plansRoot: "/plans",
      activePlan: null,
    });
    apiMocks.getPlansRoot.mockResolvedValue("/plans");
    apiMocks.getWorkspaceConfig.mockResolvedValue({
      config: { repos: {} },
    });
    apiMocks.listPlans.mockResolvedValue([
      meta("active/alpha.md", "Alpha"),
      meta("active/beta.md", "Beta"),
    ]);
    apiMocks.analyzePlans.mockResolvedValue([
      meta("active/alpha.md", "Alpha"),
      meta("active/beta.md", "Beta"),
    ]);
    apiMocks.readPlan.mockImplementation((path: string) =>
      Promise.resolve(`# ${path}\n`),
    );
    apiMocks.writePlan.mockResolvedValue(undefined);
    apiMocks.onPlansRootChanged.mockImplementation(() => {
      return Promise.resolve(vi.fn());
    });
    apiMocks.onWorkspaceConfigChanged.mockImplementation(() => {
      return Promise.resolve(vi.fn());
    });
    apiMocks.onPlanChanged.mockImplementation((handler) => {
      planChangedHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("selects the persisted plan when it is still present", async () => {
    const { result } = renderWorkspace({
      persistedActivePlanPath: "active/beta.md",
    });

    await waitFor(() => expect(result.current.plansRootLoaded).toBe(true));
    expect(result.current.plansRoot).toBe("/plans");
    expect(result.current.activeId).toBe("active/beta.md");
    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/beta.md\n"),
    );
  });

  it("lets the one-shot initial plan override persisted state", async () => {
    (window as Window & { __SR_INITIAL_PLAN__?: string }).__SR_INITIAL_PLAN__ =
      "active/beta.md";

    const { result } = renderWorkspace({
      persistedActivePlanPath: "active/alpha.md",
    });

    await waitFor(() => expect(result.current.activeId).toBe("active/beta.md"));
    expect(
      (window as Window & { __SR_INITIAL_PLAN__?: string }).__SR_INITIAL_PLAN__,
    ).toBeUndefined();
  });

  it("falls back to the newest listed plan when persisted state is stale", async () => {
    const { result } = renderWorkspace({
      persistedActivePlanPath: "archive/missing.md",
    });

    await waitFor(() => expect(result.current.plansRootLoaded).toBe(true));

    expect(result.current.activeId).toBe("active/alpha.md");
  });

  it("merges delayed analysis fields into fast startup metadata", async () => {
    apiMocks.listPlans.mockResolvedValueOnce([fastMeta("active/deep-dive.md")]);
    apiMocks.analyzePlans.mockResolvedValueOnce([
      {
        ...meta("active/deep-dive.md", "Hydrated Title"),
        wordCount: 440,
      },
    ]);

    const { result } = renderWorkspace();

    await waitFor(() =>
      expect(result.current.plans[0]?.title).toBe("Deep Dive"),
    );
    await waitFor(() =>
      expect(result.current.plans[0]?.title).toBe("Hydrated Title"),
    );
    expect(result.current.plans[0]?.readMinutes).toBe(2);
  });

  it("keeps analyzed titles during fast refreshes for changed files", async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const analyzed = {
      ...meta("active/specrider-cloud.md", "SpecRider Cloud Canonical"),
      modifiedSecs: nowSecs - 120,
      size: 1_000,
    };
    const fastChanged = {
      ...fastMeta(analyzed.path),
      modifiedSecs: nowSecs,
      size: analyzed.size + 10,
    };
    apiMocks.listPlans.mockResolvedValue([analyzed]);
    apiMocks.analyzePlans.mockResolvedValue([analyzed]);
    const { result } = renderWorkspace({
      persistedActivePlanPath: analyzed.path,
    });

    await waitFor(() =>
      expect(result.current.plans[0]?.title).toBe("SpecRider Cloud Canonical"),
    );

    apiMocks.listPlans.mockResolvedValue([fastChanged]);
    act(() => {
      planChangedHandler?.({ path: analyzed.path, kind: "modified" });
    });

    await waitFor(() =>
      expect(result.current.plans[0]?.modifiedAt).toBe("just now"),
    );
    expect(result.current.plans[0]?.title).toBe("SpecRider Cloud Canonical");
  });

  it("refreshes the active document when a watcher modified event arrives", async () => {
    const sources: Record<string, string> = {
      "active/alpha.md": "# active/alpha.md\n",
      "active/beta.md": "# active/beta.md\n",
    };
    apiMocks.readPlan.mockImplementation((path: string) =>
      Promise.resolve(sources[path] ?? ""),
    );
    const { result } = renderWorkspace({
      persistedActivePlanPath: "active/alpha.md",
    });

    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/alpha.md\n"),
    );

    sources["active/alpha.md"] = "# active/alpha.md\n\nExternal edit\n";
    act(() => {
      planChangedHandler?.({ path: "active/alpha.md", kind: "modified" });
    });

    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/alpha.md\n\nExternal edit\n"),
    );
  });

  it("reloads the active document before a slow watcher list refresh finishes", async () => {
    const sources: Record<string, string> = {
      "active/alpha.md": "# active/alpha.md\n",
      "active/beta.md": "# active/beta.md\n",
    };
    apiMocks.readPlan.mockImplementation((path: string) =>
      Promise.resolve(sources[path] ?? ""),
    );
    const { result } = renderWorkspace({
      persistedActivePlanPath: "active/alpha.md",
    });

    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/alpha.md\n"),
    );

    const listRefresh = deferred<PlanFileMeta[]>();
    apiMocks.listPlans.mockReturnValue(listRefresh.promise);
    sources["active/alpha.md"] = "# active/alpha.md\n\nExternal edit\n";
    act(() => {
      planChangedHandler?.({ path: "active/alpha.md", kind: "modified" });
    });

    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/alpha.md\n\nExternal edit\n"),
    );

    await act(async () => {
      listRefresh.resolve([
        meta("active/alpha.md", "Alpha"),
        meta("active/beta.md", "Beta"),
      ]);
      await Promise.resolve();
    });
  });

  it("reloads the active document when an external save emits remove but the file is already back", async () => {
    const cloud = meta("active/specrider-cloud.md", "Cloud");
    const web = meta("archive/specrider-web.md", "Web");
    apiMocks.listPlans.mockResolvedValue([cloud, web]);
    apiMocks.analyzePlans.mockResolvedValue([cloud, web]);
    const sources: Record<string, string> = {
      [cloud.path]: "# cloud old\n",
      [web.path]: "# web\n",
    };
    apiMocks.readPlan.mockImplementation((path: string) =>
      Promise.resolve(sources[path] ?? ""),
    );
    const { result } = renderWorkspace({
      persistedActivePlanPath: cloud.path,
    });

    await waitFor(() => expect(result.current.rawMd).toBe("# cloud old\n"));

    sources[cloud.path] = "# cloud new\n";
    act(() => {
      planChangedHandler?.({ path: cloud.path, kind: "removed" });
    });

    await waitFor(() => {
      expect(result.current.activeId).toBe(cloud.path);
      expect(result.current.rawMd).toBe("# cloud new\n");
    });
  });

  it("keeps the active document selected when an external atomic save briefly removes it", async () => {
    const cloud = meta("active/specrider-cloud.md", "Cloud");
    const web = meta("archive/specrider-web.md", "Web");
    apiMocks.listPlans.mockResolvedValue([cloud, web]);
    apiMocks.analyzePlans.mockResolvedValue([cloud, web]);
    const sources: Record<string, string> = {
      [cloud.path]: "# cloud old\n",
      [web.path]: "# web\n",
    };
    apiMocks.readPlan.mockImplementation((path: string) =>
      Promise.resolve(sources[path] ?? ""),
    );
    const { result } = renderWorkspace({
      persistedActivePlanPath: cloud.path,
    });

    await waitFor(() => expect(result.current.rawMd).toBe("# cloud old\n"));

    sources[cloud.path] = "# cloud new\n";
    let refreshListCalls = 0;
    apiMocks.listPlans.mockImplementation(() => {
      refreshListCalls += 1;
      return Promise.resolve(refreshListCalls === 1 ? [web] : [cloud, web]);
    });
    act(() => {
      planChangedHandler?.({ path: cloud.path, kind: "removed" });
    });

    await waitFor(
      () => {
        expect(result.current.activeId).toBe(cloud.path);
        expect(result.current.rawMd).toBe("# cloud new\n");
      },
      { timeout: 1_200 },
    );
  });

  it("falls back when the active document is actually removed", async () => {
    const cloud = meta("active/specrider-cloud.md", "Cloud");
    const web = meta("archive/specrider-web.md", "Web");
    apiMocks.listPlans.mockResolvedValue([cloud, web]);
    apiMocks.analyzePlans.mockResolvedValue([cloud, web]);
    const sources: Record<string, string> = {
      [cloud.path]: "# cloud\n",
      [web.path]: "# web\n",
    };
    apiMocks.readPlan.mockImplementation((path: string) => {
      const source = sources[path];
      if (source !== undefined) return Promise.resolve(source);
      return Promise.reject(new Error("missing"));
    });
    const { result } = renderWorkspace({
      persistedActivePlanPath: cloud.path,
    });

    await waitFor(() => expect(result.current.rawMd).toBe("# cloud\n"));

    apiMocks.listPlans.mockResolvedValue([web]);
    delete sources[cloud.path];
    act(() => {
      planChangedHandler?.({ path: cloud.path, kind: "removed" });
    });

    await waitFor(
      () => {
        expect(result.current.activeId).toBe(web.path);
        expect(result.current.rawMd).toBe("# web\n");
      },
      { timeout: 1_200 },
    );
  });

  it("falls back to main-thread parsing when the worker rejects", async () => {
    parseMocks.parseInWorker.mockRejectedValueOnce(new Error("worker failed"));
    const source = `# Huge\n\n${"body ".repeat(1_300)}`;
    const { result } = renderWorkspace();

    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/alpha.md\n"),
    );
    await waitFor(() => expect(apiMocks.analyzePlans).toHaveBeenCalled());
    expect(apiMocks.readPlan).toHaveBeenCalledWith("active/alpha.md");
    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/alpha.md\n"),
    );

    act(() => {
      result.current.setRawMd(source);
    });

    await waitFor(() => expect(parseMocks.parseInWorker).toHaveBeenCalled());
    await waitFor(() => expect(result.current.outline[0]?.text).toBe("Huge"));
  });

  it("ignores stale read results after the active plan changes", async () => {
    const alpha = deferred<string>();
    apiMocks.readPlan.mockImplementation((path: string) => {
      if (path === "active/alpha.md") return alpha.promise;
      return Promise.resolve("# beta\n");
    });
    const { result } = renderWorkspace({
      persistedActivePlanPath: "active/alpha.md",
    });

    await waitFor(() =>
      expect(result.current.activeId).toBe("active/alpha.md"),
    );

    act(() => {
      result.current.setActiveId("active/beta.md");
    });

    await waitFor(() => expect(result.current.rawMd).toBe("# beta\n"));

    act(() => {
      alpha.resolve("# stale alpha\n");
    });

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(result.current.rawMd).toBe("# beta\n");
  });

  it("autosaves edited content after the initial load guard has cleared", async () => {
    const { result } = renderWorkspace({
      persistedActivePlanPath: "active/alpha.md",
    });

    await waitFor(() =>
      expect(result.current.rawMd).toBe("# active/alpha.md\n"),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    apiMocks.writePlan.mockClear();

    act(() => {
      result.current.setRawMd("# active/alpha.md\n\nUpdated body\n");
    });

    await waitFor(
      () =>
        expect(apiMocks.writePlan).toHaveBeenCalledWith(
          "active/alpha.md",
          "# active/alpha.md\n\nUpdated body\n",
        ),
      { timeout: 1_500 },
    );
  });
});

function parseTreeStub() {
  return { type: "root", children: [] };
}
