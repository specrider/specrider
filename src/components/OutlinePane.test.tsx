import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedSection } from "../tauri/api";
import type { OutlineNode } from "../types";
import { OutlinePane } from "./OutlinePane";

const settingsMocks = vi.hoisted(() => ({
  effective: {
    outlineShowTasks: true,
    outlineShowNumberedLists: true,
    outlineShowBulletedLists: true,
  },
}));

const pinMocks = vi.hoisted(() => ({
  sections: {} as Record<string, PinnedSection[]>,
  toggleSection: vi.fn(),
}));

vi.mock("../settings/store", () => ({
  useSettings: () => ({
    effective: settingsMocks.effective,
  }),
}));

vi.mock("../pins/store", () => ({
  usePins: () => ({
    pinnedSections: (planPath: string) => pinMocks.sections[planPath] ?? [],
    isSectionPinned: (planPath: string, headingId: string) =>
      (pinMocks.sections[planPath] ?? []).some(
        (section) => section.headingId === headingId,
      ),
    toggleSection: pinMocks.toggleSection,
  }),
}));

function outlineFixture(): OutlineNode[] {
  return [
    {
      id: "intro",
      text: "Intro",
      depth: 1,
      line: 1,
      endLine: 20,
      taskDone: 1,
      taskTotal: 3,
      tasks: [
        { line: 3, text: "Todo task", done: false, depth: 0 },
        { line: 4, text: "Nested todo", done: false, depth: 1 },
        { line: 5, text: "Done task", done: true, depth: 0 },
      ],
      lists: [
        {
          line: 6,
          text: "Numbered idea",
          kind: "numbered",
          marker: "1.",
        },
        {
          line: 7,
          text: "Bullet idea",
          kind: "bulleted",
          marker: "-",
        },
      ],
      children: [
        {
          id: "details",
          text: "Details",
          depth: 2,
          line: 10,
          endLine: 20,
          taskDone: 0,
          taskTotal: 0,
          tasks: [],
          lists: [],
          children: [],
        },
      ],
    },
  ];
}

function renderPane(props: Partial<Parameters<typeof OutlinePane>[0]> = {}) {
  return render(
    <OutlinePane
      outline={outlineFixture()}
      progress={{ done: 1, total: 3 }}
      activeHeading=""
      planPath="active/plan.md"
      diff={{ added: [], modified: [], deletedAfter: [], hunks: [] }}
      collapsed={new Set()}
      onToggleSection={vi.fn()}
      taskCollapsed={new Set()}
      onToggleTaskCollapse={vi.fn()}
      onJump={vi.fn()}
      onJumpToTask={vi.fn()}
      onJumpToListItem={vi.fn()}
      {...props}
    />,
  );
}

describe("OutlinePane", () => {
  beforeEach(() => {
    pinMocks.sections = {};
    pinMocks.toggleSection.mockReset();
    pinMocks.toggleSection.mockResolvedValue(false);
    settingsMocks.effective.outlineShowTasks = true;
    settingsMocks.effective.outlineShowNumberedLists = true;
    settingsMocks.effective.outlineShowBulletedLists = true;
  });

  it("filters to unfinished tasks and hides list rows in to-do mode", async () => {
    const user = userEvent.setup();
    renderPane();

    expect(screen.getByText("Todo task")).toBeTruthy();
    expect(screen.getByText("Done task")).toBeTruthy();
    expect(screen.getByText("Numbered idea")).toBeTruthy();
    expect(screen.getByText("Bullet idea")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /To do/ }));

    expect(screen.getByText("Todo task")).toBeTruthy();
    expect(screen.getByText("Nested todo")).toBeTruthy();
    expect(screen.queryByText("Done task")).toBeNull();
    expect(screen.queryByText("Numbered idea")).toBeNull();
    expect(screen.queryByText("Bullet idea")).toBeNull();
  });

  it("renders pinned headings, orphan pins, and toggles section pins from the context menu", async () => {
    const user = userEvent.setup();
    pinMocks.sections["active/plan.md"] = [
      { headingId: "intro", headingText: "Intro", pinnedAt: 2 },
      { headingId: "missing", headingText: "Old Heading", pinnedAt: 1 },
    ];
    renderPane();

    expect(screen.getByText("PINNED")).toBeTruthy();
    expect(screen.getByText("Old Heading")).toBeTruthy();
    expect(screen.getAllByRole("treeitem", { name: /Intro/ })).toHaveLength(2);

    fireEvent.contextMenu(
      screen.getAllByRole("treeitem", { name: /Intro/ })[1],
    );
    await user.click(screen.getByRole("menuitem", { name: "Unpin section" }));

    expect(pinMocks.toggleSection).toHaveBeenCalledWith(
      "active/plan.md",
      "intro",
      "Intro",
    );
  });

  it("supports keyboard navigation, heading collapse, task collapse, and jump callbacks", async () => {
    const user = userEvent.setup();
    const onToggleSection = vi.fn();
    const onToggleTaskCollapse = vi.fn();
    const onJumpToTask = vi.fn();
    renderPane({
      onToggleSection,
      onToggleTaskCollapse,
      onJumpToTask,
    });

    const intro = screen.getByRole("treeitem", { name: /Intro/ });
    intro.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onJumpToTask).toHaveBeenCalledWith(3);

    fireEvent.click(within(intro).getByRole("button", { name: "Collapse" }));
    expect(onToggleSection).toHaveBeenCalledWith("intro");

    const task = screen.getByRole("treeitem", { name: /Todo task/ });
    fireEvent.click(
      within(task).getByRole("button", { name: "Collapse children" }),
    );
    expect(onToggleTaskCollapse).toHaveBeenCalledWith(3);
  });
});
