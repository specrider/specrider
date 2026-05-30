import { describe, expect, it } from "vitest";
import type { ChangeSet } from "../tauri/api";
import {
  changeKindForLine,
  changeKindForRange,
  firstChangedLineInRange,
} from "./useDiff";

const EMPTY: ChangeSet = {
  added: [],
  modified: [],
  deletedAfter: [],
  hunks: [],
};

function diff(partial: Partial<ChangeSet>): ChangeSet {
  return { ...EMPTY, ...partial };
}

describe("changeKindForRange", () => {
  it("returns null when the diff is empty", () => {
    expect(changeKindForRange(EMPTY, 1, 100)).toEqual({ kind: null, count: 0 });
  });

  it("returns added when only added lines fall in range", () => {
    const d = diff({ added: [3, 4, 5] });
    expect(changeKindForRange(d, 1, 10)).toEqual({ kind: "added", count: 3 });
  });

  it("returns modified when only modified lines fall in range", () => {
    const d = diff({ modified: [4] });
    expect(changeKindForRange(d, 1, 10)).toEqual({
      kind: "modified",
      count: 1,
    });
  });

  it("returns deleted-near when only deletedAfter lines fall in range", () => {
    const d = diff({ deletedAfter: [4] });
    expect(changeKindForRange(d, 1, 10)).toEqual({
      kind: "deleted-near",
      count: 1,
    });
  });

  it("modified wins over added when both are present", () => {
    const d = diff({ added: [3], modified: [4] });
    expect(changeKindForRange(d, 1, 10).kind).toBe("modified");
  });

  it("added wins over deleted-near when both are present", () => {
    const d = diff({ added: [3], deletedAfter: [4] });
    expect(changeKindForRange(d, 1, 10).kind).toBe("added");
  });

  it("end is exclusive", () => {
    const d = diff({ added: [10] });
    // [1, 10) should NOT contain line 10
    expect(changeKindForRange(d, 1, 10).kind).toBe(null);
    // [1, 11) should
    expect(changeKindForRange(d, 1, 11).kind).toBe("added");
  });

  it("start is inclusive", () => {
    const d = diff({ added: [5] });
    expect(changeKindForRange(d, 5, 10).kind).toBe("added");
    expect(changeKindForRange(d, 6, 10).kind).toBe(null);
  });

  it("counts every hit across categories", () => {
    const d = diff({ added: [3, 4], modified: [5], deletedAfter: [6] });
    const result = changeKindForRange(d, 1, 10);
    expect(result.count).toBe(4);
    expect(result.kind).toBe("modified");
  });
});

describe("changeKindForLine", () => {
  it("returns null for an unchanged line", () => {
    expect(changeKindForLine(EMPTY, 5)).toBeNull();
  });

  it("returns modified for a modified line", () => {
    expect(changeKindForLine(diff({ modified: [5] }), 5)).toBe("modified");
  });

  it("returns added for an added line", () => {
    expect(changeKindForLine(diff({ added: [5] }), 5)).toBe("added");
  });

  it("returns deleted-near for a deletedAfter line", () => {
    expect(changeKindForLine(diff({ deletedAfter: [5] }), 5)).toBe(
      "deleted-near",
    );
  });

  it("modified takes precedence over added when both list the same line", () => {
    const d = diff({ added: [5], modified: [5] });
    expect(changeKindForLine(d, 5)).toBe("modified");
  });
});

describe("firstChangedLineInRange", () => {
  it("returns null for an empty diff", () => {
    expect(firstChangedLineInRange(EMPTY, 1, 100)).toBeNull();
  });

  it("returns the lowest changed line in the range", () => {
    const d = diff({ added: [10, 20], modified: [5, 15] });
    expect(firstChangedLineInRange(d, 1, 100)).toBe(5);
  });

  it("respects the inclusive-start, exclusive-end bounds", () => {
    const d = diff({ added: [5, 10] });
    expect(firstChangedLineInRange(d, 6, 10)).toBeNull();
    expect(firstChangedLineInRange(d, 6, 11)).toBe(10);
  });

  it("considers all three categories", () => {
    expect(firstChangedLineInRange(diff({ added: [7] }), 1, 100)).toBe(7);
    expect(firstChangedLineInRange(diff({ modified: [7] }), 1, 100)).toBe(7);
    expect(firstChangedLineInRange(diff({ deletedAfter: [7] }), 1, 100)).toBe(
      7,
    );
  });
});
