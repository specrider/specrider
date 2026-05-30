import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../types";
import { DocumentBrowser } from "./DocumentBrowser";

const apiMocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  duplicatePlan: vi.fn(),
  getPlansRoot: vi.fn(),
  movePlan: vi.fn(),
  openPlanInNewWindow: vi.fn(),
  renamePlan: vi.fn(),
  revealPlan: vi.fn(),
}));

const pinMocks = vi.hoisted(() => ({
  pinnedPlans: [] as Array<{ planPath: string; pinnedAt: number }>,
  togglePlan: vi.fn(),
  toggleSection: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "test-window" }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: dialogMocks.ask,
  message: dialogMocks.message,
  open: dialogMocks.open,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
}));

vi.mock("../pins/store", () => ({
  usePins: () => ({
    pins: { plans: pinMocks.pinnedPlans, sections: {} },
    loaded: true,
    pinnedPlans: pinMocks.pinnedPlans,
    pinnedSections: () => [],
    isPlanPinned: (planPath: string) =>
      pinMocks.pinnedPlans.some((pin) => pin.planPath === planPath),
    isSectionPinned: () => false,
    togglePlan: pinMocks.togglePlan,
    toggleSection: pinMocks.toggleSection,
  }),
}));

vi.mock("../tauri/api", () => ({
  createFolder: apiMocks.createFolder,
  createPlan: apiMocks.createPlan,
  deletePlan: apiMocks.deletePlan,
  duplicatePlan: apiMocks.duplicatePlan,
  getPlansRoot: apiMocks.getPlansRoot,
  movePlan: apiMocks.movePlan,
  openPlanInNewWindow: apiMocks.openPlanInNewWindow,
  renamePlan: apiMocks.renamePlan,
  revealPlan: apiMocks.revealPlan,
}));

function plan(path: string, title: string): Plan {
  return {
    id: path,
    title,
    path,
    bucket: path.split("/").at(-2) ?? "loose",
    modifiedAt: "just now",
    modifiedRaw: 0,
    lineCount: 10,
    wordCount: 100,
    readMinutes: 1,
    status: null,
    owner: "",
    contributors: [],
    progress: { done: 1, total: 3 },
    tags: [],
    iterationCount: 0,
    gitBranches: [],
    gitCommits: [],
    linkedRepoLinks: [],
    frontmatterIssues: [],
  };
}

function renderBrowser(
  props: Partial<Parameters<typeof DocumentBrowser>[0]> = {},
) {
  return render(
    <DocumentBrowser
      plans={[
        plan("active/alpha.md", "Alpha Plan"),
        plan("backlog/later.md", "Later Plan"),
        plan("archive/done.md", "Done Plan"),
      ]}
      activeId="active/alpha.md"
      onSelect={vi.fn()}
      changedPlans={new Map()}
      {...props}
    />,
  );
}

describe("DocumentBrowser", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    for (const mock of Object.values(dialogMocks)) mock.mockReset();
    pinMocks.pinnedPlans.length = 0;
    pinMocks.togglePlan.mockReset();
    pinMocks.togglePlan.mockResolvedValue(false);
    pinMocks.toggleSection.mockReset();
  });

  it("renders open well-known buckets while archive starts collapsed", () => {
    renderBrowser();

    expect(screen.getByRole("treeitem", { name: /Alpha Plan/ })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /Later Plan/ })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /Done Plan/ })).toBeNull();
  });

  it("selects a visible document row", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderBrowser({ onSelect });

    await user.click(screen.getByRole("treeitem", { name: /Later Plan/ }));

    expect(onSelect).toHaveBeenCalledWith("backlog/later.md");
  });

  it("creates a new document at the workspace root", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    apiMocks.createPlan.mockResolvedValueOnce("new-idea.md");
    renderBrowser({ onCreate });

    await user.click(
      screen.getByRole("button", { name: "New plan or folder" }),
    );
    await user.click(screen.getByRole("button", { name: /New doc/ }));
    await user.type(
      screen.getByPlaceholderText("new-plan (.md is added)"),
      "New Idea",
    );
    await user.keyboard("{Enter}");

    expect(apiMocks.createPlan).toHaveBeenCalledWith("New Idea");
    expect(onCreate).toHaveBeenCalledWith("new-idea.md");
  });

  it("creates the first document from an empty folder", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    apiMocks.createPlan.mockResolvedValueOnce("first-plan.md");
    renderBrowser({ plans: [], activeId: "", onCreate });

    await user.click(
      screen.getByRole("button", { name: "New plan or folder" }),
    );
    await user.click(screen.getByRole("button", { name: /New doc/ }));
    await user.type(
      screen.getByPlaceholderText("new-plan (.md is added)"),
      "first-plan",
    );
    await user.keyboard("{Enter}");

    expect(apiMocks.createPlan).toHaveBeenCalledWith("first-plan");
    expect(onCreate).toHaveBeenCalledWith("first-plan.md");
  });

  it("moves focus through visible rows with tree keyboard navigation", async () => {
    const user = userEvent.setup();
    renderBrowser();

    const alpha = screen.getByRole("treeitem", { name: /Alpha Plan/ });
    alpha.focus();

    await user.keyboard("{ArrowDown}");

    expect(document.activeElement?.textContent).toContain("BACKLOG");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("Later Plan");
  });

  it("renames a plan from the context menu", async () => {
    const user = userEvent.setup();
    apiMocks.renamePlan.mockResolvedValueOnce("active/renamed.md");
    renderBrowser();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /Alpha Plan/ }));
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));

    const input = screen.getByDisplayValue("alpha");
    await user.clear(input);
    await user.type(input, "renamed");
    await user.keyboard("{Enter}");

    expect(apiMocks.renamePlan).toHaveBeenCalledWith(
      "active/alpha.md",
      "renamed",
    );
  });

  it("confirms destructive deletes before invoking the API", async () => {
    const user = userEvent.setup();
    dialogMocks.ask.mockResolvedValueOnce(true);
    apiMocks.deletePlan.mockResolvedValueOnce(undefined);
    renderBrowser();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /Alpha Plan/ }));
    await user.click(screen.getByRole("menuitem", { name: /Delete/ }));

    expect(dialogMocks.ask).toHaveBeenCalledWith(
      'Move "Alpha Plan" to Trash?',
      {
        title: "Delete plan",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    await waitFor(() =>
      expect(apiMocks.deletePlan).toHaveBeenCalledWith("active/alpha.md"),
    );
  });

  it("renders pinned plans and toggles pins from the row menu", async () => {
    const user = userEvent.setup();
    pinMocks.pinnedPlans.push({
      planPath: "active/alpha.md",
      pinnedAt: 2,
    });
    renderBrowser();

    expect(screen.getByRole("treeitem", { name: /PINNED/ })).toBeTruthy();
    expect(
      screen.getAllByRole("treeitem", { name: /Alpha Plan/ }),
    ).toHaveLength(2);

    fireEvent.contextMenu(
      screen.getAllByRole("treeitem", { name: /Alpha Plan/ })[1],
    );
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));

    expect(pinMocks.togglePlan).toHaveBeenCalledWith("active/alpha.md");
  });

  it("moves a dragged plan into the target row's folder", async () => {
    const data = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "",
      effectAllowed: "",
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value);
      }),
    };
    apiMocks.movePlan.mockResolvedValueOnce(undefined);
    renderBrowser();

    const alpha = screen.getByRole("treeitem", { name: /Alpha Plan/ });
    const later = screen.getByRole("treeitem", { name: /Later Plan/ });

    fireEvent.dragStart(alpha, { dataTransfer });
    fireEvent.drop(later, { dataTransfer });

    await waitFor(() =>
      expect(apiMocks.movePlan).toHaveBeenCalledWith(
        "active/alpha.md",
        "backlog/alpha.md",
      ),
    );
  });
});
