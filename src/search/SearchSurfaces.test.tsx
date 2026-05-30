import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiffFindApi,
  DiffSearchMatch,
} from "../components/CommitDiffBody";
import type { Plan } from "../types";
import { DiffFind } from "./DiffFind";
import { FindInDoc } from "./FindInDoc";
import { FindInProject } from "./FindInProject";
import { QuickSwitch } from "./QuickSwitch";

const apiMocks = vi.hoisted(() => ({
  searchPlans: vi.fn(),
}));

vi.mock("../tauri/api", () => ({
  searchPlans: apiMocks.searchPlans,
}));

function plan(path: string, title: string, patch: Partial<Plan> = {}): Plan {
  return {
    id: path,
    title,
    path,
    bucket: path.split("/")[0] || "active",
    modifiedAt: "just now",
    modifiedRaw: 0,
    lineCount: 10,
    wordCount: 100,
    readMinutes: 1,
    status: null,
    owner: "Jake",
    contributors: ["Ada"],
    progress: { done: 1, total: 3 },
    tags: ["coverage"],
    iterationCount: 0,
    gitBranches: [],
    gitCommits: [],
    linkedRepoLinks: [],
    frontmatterIssues: [],
    ...patch,
  };
}

const plans = [
  plan("active/alpha.md", "Alpha Plan", { tags: ["coverage", "urgent"] }),
  plan("backlog/beta.md", "Beta Launch", {
    owner: "Ada",
    contributors: ["Grace"],
    tags: ["release"],
  }),
];

describe("QuickSwitch", () => {
  it("returns null while closed", () => {
    render(
      <QuickSwitch
        open={false}
        plans={plans}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog", { name: "Quick switch" })).toBeNull();
  });

  it("selects ranked rows and completes filter suggestions", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <QuickSwitch
        open={true}
        plans={plans}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const input = screen.getByLabelText("Search documents");
    await user.type(input, "#");
    expect(screen.getByText("Tags")).toBeTruthy();
    await user.click(screen.getByRole("option", { name: "urgent" }));
    expect((input as HTMLInputElement).value).toBe("#urgent ");

    await user.clear(input);
    await user.type(input, "beta");
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith("backlog/beta.md");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("FindInProject", () => {
  beforeEach(() => {
    apiMocks.searchPlans.mockReset();
    apiMocks.searchPlans.mockResolvedValue([
      {
        path: "active/alpha.md",
        hits: [
          {
            line: 7,
            lineText: "Alpha target line",
            matchStart: 6,
            matchEnd: 12,
          },
        ],
      },
    ]);
  });

  it("debounces query/options and activates grouped result rows", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <FindInProject
        open={true}
        plans={plans}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Aa" }));
    await user.click(screen.getByRole("button", { name: "W" }));
    await user.click(screen.getByRole("button", { name: ".*" }));
    await user.type(
      screen.getByRole("textbox", { name: "Find in project" }),
      "Alpha",
    );

    await waitFor(() =>
      expect(apiMocks.searchPlans).toHaveBeenCalledWith("Alpha", {
        caseSensitive: true,
        wholeWord: true,
        useRegex: true,
      }),
    );
    expect(await screen.findByText("Alpha Plan")).toBeTruthy();

    const resultRow = screen.getByText("target").closest("button");
    expect(resultRow).toBeTruthy();
    await user.click(resultRow as HTMLButtonElement);
    expect(onSelect).toHaveBeenCalledWith("active/alpha.md", 7, "Alpha");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function FindDocHarness(props: { onClose: () => void }) {
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={scrollRef}>
      <div ref={scopeRef}>
        Alpha beta alpha.
        <span>Ignored? no, another alpha.</span>
      </div>
      <FindInDoc
        open={true}
        scopeRef={scopeRef}
        scrollRef={scrollRef}
        scanKey="doc-1"
        initialQuery="alpha"
        onClose={props.onClose}
      />
    </div>
  );
}

describe("FindInDoc", () => {
  it("counts document matches, steps next/previous, and closes from Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<FindDocHarness onClose={onClose} />);

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("1 / 3")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("DiffFind", () => {
  function match(id: string): DiffSearchMatch {
    return {
      id,
      itemIndex: id === "m1" ? 1 : 2,
      lineKey: id,
      path: "active/a.md",
      lineText: `line ${id}`,
      matchStart: 0,
      matchEnd: 4,
    };
  }

  it("searches through the diff API, activates matches, clears, and closes", async () => {
    const user = userEvent.setup();
    const matches = [match("m1"), match("m2")];
    const api: DiffFindApi = {
      search: vi.fn(() => matches),
      activate: vi.fn(),
      clear: vi.fn(),
    };
    const apiRef = { current: api };
    const onClose = vi.fn();
    const { rerender } = render(
      <DiffFind
        open={true}
        apiRef={apiRef}
        scanKey="diff-1"
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText("Find in diff"), {
      target: { value: "line" },
    });
    await waitFor(() => expect(api.search).toHaveBeenCalledWith("line"));
    expect(api.activate).toHaveBeenCalledWith(matches[0]);
    expect(screen.getByText("1 / 2")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Next match" }));
    expect(api.activate).toHaveBeenCalledWith(matches[1]);
    expect(screen.getByText("2 / 2")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close find bar" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <DiffFind
        open={false}
        apiRef={apiRef}
        scanKey="diff-1"
        onClose={onClose}
      />,
    );
    expect(api.clear).toHaveBeenCalledTimes(1);
  });
});
