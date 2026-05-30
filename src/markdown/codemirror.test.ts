import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BlameSet, ChangeSet, Hunk } from "../tauri/api";
import {
  blameExtension,
  changeGutterExtension,
  hunkAtLine,
  hunkStartLines,
} from "./codemirror";

function hunk(partial: Partial<Hunk>): Hunk {
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 0,
    newLines: 0,
    before: "",
    after: "",
    ...partial,
  };
}

function diff(hunks: Hunk[]): ChangeSet {
  return { added: [], modified: [], deletedAfter: [], hunks };
}

describe("hunkAtLine", () => {
  it("returns null for an empty diff", () => {
    expect(hunkAtLine(diff([]), 5)).toBeNull();
  });

  it("returns the hunk that owns a line in [newStart, newStart + newLines)", () => {
    const h = hunk({ newStart: 5, newLines: 3 });
    const d = diff([h]);
    expect(hunkAtLine(d, 5)).toBe(h);
    expect(hunkAtLine(d, 6)).toBe(h);
    expect(hunkAtLine(d, 7)).toBe(h);
    expect(hunkAtLine(d, 8)).toBeNull();
    expect(hunkAtLine(d, 4)).toBeNull();
  });

  it("matches a pure-deletion hunk only at its newStart anchor", () => {
    const h = hunk({ newStart: 10, newLines: 0 });
    const d = diff([h]);
    expect(hunkAtLine(d, 10)).toBe(h);
    expect(hunkAtLine(d, 9)).toBeNull();
    expect(hunkAtLine(d, 11)).toBeNull();
  });

  it("returns the first matching hunk when multiple exist", () => {
    const h1 = hunk({ newStart: 5, newLines: 3 });
    const h2 = hunk({ newStart: 20, newLines: 2 });
    const d = diff([h1, h2]);
    expect(hunkAtLine(d, 6)).toBe(h1);
    expect(hunkAtLine(d, 21)).toBe(h2);
  });
});

describe("hunkStartLines", () => {
  it("returns an empty array for an empty diff", () => {
    expect(hunkStartLines(diff([]))).toEqual([]);
  });

  it("returns hunk newStart values in ascending order", () => {
    const d = diff([
      hunk({ newStart: 20, newLines: 1 }),
      hunk({ newStart: 5, newLines: 1 }),
      hunk({ newStart: 12, newLines: 1 }),
    ]);
    expect(hunkStartLines(d)).toEqual([5, 12, 20]);
  });

  it("filters out non-positive newStart entries", () => {
    const d = diff([
      hunk({ newStart: 0, newLines: 1 }),
      hunk({ newStart: 5, newLines: 1 }),
    ]);
    expect(hunkStartLines(d)).toEqual([5]);
  });
});

describe("CodeMirror diff and blame extensions", () => {
  it("renders change gutter markers and maps changed lines to hunks", () => {
    const onHunkClick = vi.fn();
    const targetHunk = hunk({ newStart: 2, newLines: 1 });
    const targetDiff = {
      added: [2],
      modified: [],
      deletedAfter: [],
      hunks: [targetHunk],
    };
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "one\ntwo\nthree",
        extensions: [changeGutterExtension(targetDiff, onHunkClick)],
      }),
    });

    try {
      const marker = view.dom.querySelector(".cm-change-bar.added");
      expect(marker).toBeTruthy();
      expect(hunkAtLine(targetDiff, 2)).toBe(targetHunk);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("invokes the blame SHA callback from clickable blame annotations", () => {
    const onShaClick = vi.fn();
    const blame: BlameSet = {
      lines: [
        {
          line: 1,
          sha: "abc12345",
          author: "Ada",
          authorTime: 1_700_000_000,
          summary: "Initial plan",
          uncommitted: false,
        },
      ],
      commits: {},
    };
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "one\ntwo",
        extensions: [blameExtension(blame, true, onShaClick)],
      }),
    });

    try {
      const annotation = view.dom.querySelector(".cm-blame-annotation");
      expect(annotation?.textContent).toContain("abc12345");

      fireEvent.mouseDown(annotation as Element);

      expect(onShaClick).toHaveBeenCalledWith("abc12345");
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
