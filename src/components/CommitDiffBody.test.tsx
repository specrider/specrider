import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps, MutableRefObject, RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CommitDetail, DiffLine, FileChange } from "../tauri/api";
import { CommitDiffBody, type DiffFindApi, fileKey } from "./CommitDiffBody";

type CommitDiffBodyProps = ComponentProps<typeof CommitDiffBody>;

const virtualizerMocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: (range: { startIndex: number; endIndex: number }) =>
    Array.from(
      { length: range.endIndex - range.startIndex + 1 },
      (_, i) => range.startIndex + i,
    ),
  useVirtualizer: (options: {
    count: number;
    estimateSize: (index: number) => number;
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
            key: index,
            size,
            start,
          };
          start += size;
          return item;
        });
      },
      measureElement: vi.fn(),
      scrollToIndex: virtualizerMocks.scrollToIndex,
    };
  },
}));

vi.mock("../markdown/highlight", () => ({
  detectLangFromPath: () => null,
  ensureLanguage: vi.fn(),
  highlightSync: vi.fn(),
  isLangReady: () => true,
}));

function line(
  text: string,
  index: number,
  kind: DiffLine["kind"] = "addition",
): DiffLine {
  return {
    kind,
    oldLine: kind === "addition" ? null : index,
    newLine: kind === "deletion" ? null : index,
    text,
  };
}

function file(partial: Partial<FileChange>): FileChange {
  return {
    status: "modified",
    path: "docs/plan.md",
    oldPath: null,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        headerText: "",
        lines: [line("target line", 1)],
      },
    ],
    binary: false,
    truncatedLines: null,
    large: false,
    ...partial,
  };
}

function detail(files: FileChange[]): CommitDetail {
  return {
    sha: "abc123",
    shortSha: "abc123",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    timeSecs: 1_700_000_000,
    subject: "Update plans",
    body: "",
    files,
  };
}

function renderDiff(props: Partial<CommitDiffBodyProps> = {}) {
  virtualizerMocks.scrollToIndex.mockReset();
  const bodyRef = {
    current: document.createElement("div"),
  } satisfies RefObject<HTMLDivElement | null>;
  return render(
    <CommitDiffBody
      detail={detail([file({})])}
      loading={false}
      error={null}
      bodyRef={bodyRef}
      {...props}
    />,
  );
}

describe("CommitDiffBody", () => {
  it("shows a large-file hint for collapsed large diffs and expands via callback", () => {
    const largeFile = file({
      path: "docs/large.md",
      additions: 350,
      deletions: 2,
      large: true,
    });
    const onToggleFile = vi.fn();

    renderDiff({
      detail: detail([largeFile]),
      collapsedFiles: new Set([fileKey(largeFile)]),
      onToggleFile,
    });

    expect(screen.getByText("docs/large.md")).toBeTruthy();
    expect(screen.getByText(/Large diff \(352 lines\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));

    expect(onToggleFile).toHaveBeenCalledWith(fileKey(largeFile));
  });

  it("requests lazy file bodies and exposes path scrolling for virtual rows", async () => {
    const lazyFile = file({
      path: "docs/lazy.md",
      bodyLoaded: false,
      hunks: [],
    });
    const onLoadFile = vi.fn();
    const scrollToPathRef: MutableRefObject<((path: string) => void) | null> = {
      current: null,
    };

    renderDiff({
      detail: detail([lazyFile]),
      onLoadFile,
      scrollToPathRef,
    });

    expect(screen.getByText("loading docs/lazy.md")).toBeTruthy();
    await waitFor(() => expect(onLoadFile).toHaveBeenCalledWith(lazyFile));

    act(() => {
      scrollToPathRef.current?.("docs/lazy.md");
    });

    expect(virtualizerMocks.scrollToIndex).toHaveBeenCalledWith(0, {
      align: "start",
    });
  });

  it("searches visible diff lines, activates matches, and clears highlights", async () => {
    const findApiRef: MutableRefObject<DiffFindApi | null> = {
      current: null,
    };
    const { container } = renderDiff({
      findApiRef,
      detail: detail([
        file({
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              headerText: "",
              lines: [line("first target", 1), line("second target", 2)],
            },
          ],
        }),
      ]),
    });

    let matches = [] as ReturnType<DiffFindApi["search"]>;
    act(() => {
      matches = findApiRef.current?.search("target") ?? [];
    });

    expect(matches).toHaveLength(2);
    await waitFor(() =>
      expect(container.querySelectorAll(".cdb-find-match")).toHaveLength(2),
    );

    act(() => {
      findApiRef.current?.activate(matches[1] ?? null);
    });

    expect(virtualizerMocks.scrollToIndex).toHaveBeenCalledWith(3, {
      align: "center",
    });
    expect(
      container.querySelector(".cdb-find-match.current")?.textContent,
    ).toBe("target");

    act(() => {
      findApiRef.current?.clear();
    });

    await waitFor(() =>
      expect(container.querySelectorAll(".cdb-find-match")).toHaveLength(0),
    );
  });

  it("selects individual diff lines for copy without native text selection", () => {
    const { container } = renderDiff({
      detail: detail([
        file({
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              headerText: "",
              lines: [line("first line", 1), line("second line", 2)],
            },
          ],
        }),
      ]),
    });

    const firstLine = screen.getByText("first line").closest(".cdb-line");
    const secondLine = screen.getByText("second line").closest(".cdb-line");
    const root = container.querySelector(".cdb-root");
    if (!firstLine || !secondLine || !root) {
      throw new Error("expected rendered diff lines");
    }

    fireEvent.click(firstLine);
    fireEvent.click(secondLine, { ctrlKey: true });

    expect(firstLine.classList.contains("selected")).toBe(true);
    expect(secondLine.classList.contains("selected")).toBe(true);

    const setData = vi.fn();
    const copyEvent = new Event("copy", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData },
    });
    root.dispatchEvent(copyEvent);

    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "first line\nsecond line",
    );
    expect(copyEvent.defaultPrevented).toBe(true);
  });

  it("expands oversized hunks and surfaces truncation messages", async () => {
    const lines = Array.from({ length: 305 }, (_, index) =>
      line(`line ${index + 1}`, index + 1),
    );
    renderDiff({
      detail: detail([
        file({
          additions: 305,
          truncatedLines: 1_200,
          hunks: [
            {
              oldStart: 1,
              oldLines: 305,
              newStart: 1,
              newLines: 305,
              headerText: "big section",
              lines,
            },
          ],
        }),
      ]),
    });

    expect(screen.queryByText("line 305")).toBeNull();
    expect(
      screen.getByText(
        "Diff truncated - 1,200 more lines not shown. Open the file directly to view the full content.",
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 5 more lines in this hunk",
      }),
    );

    await waitFor(() => expect(screen.getByText("line 305")).toBeTruthy());
  });
});
