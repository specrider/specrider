import { describe, expect, it } from "vitest";
import { scoreMatch, splitByMatches } from "./score";

describe("scoreMatch", () => {
  it("returns score 0 / no spans for an empty query", () => {
    expect(scoreMatch("", "Title", "active/x.md")).toEqual({
      score: 0,
      spans: [],
    });
  });

  it("returns null when nothing matches at all", () => {
    expect(scoreMatch("xyzzy", "Title", "active/x.md")).toBeNull();
  });

  it("ranks an exact title substring at index 0 highest", () => {
    const a = scoreMatch("plan", "Plan A", "active/p.md");
    const b = scoreMatch("plan", "My Plan", "active/p.md");
    if (!a) throw new Error("expected title match at index 0");
    if (!b) throw new Error("expected title match after index 0");
    // Both are tier-1 substring matches; closer to start wins.
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("ranks a title substring above a path substring", () => {
    const titleMatch = scoreMatch("plan", "Plan A", "x/y.md");
    const pathMatch = scoreMatch("plan", "Other", "active/plan.md");
    if (!titleMatch) throw new Error("expected title match");
    if (!pathMatch) throw new Error("expected path match");
    expect(titleMatch.score).toBeGreaterThan(pathMatch.score);
  });

  it("places spans on the correct field", () => {
    const titleMatch = scoreMatch("plan", "Plan A", "x/y.md");
    expect(titleMatch?.spans[0].field).toBe("title");
    const pathMatch = scoreMatch("plan", "Other", "active/plan.md");
    expect(pathMatch?.spans[0].field).toBe("path");
  });

  it("uses fuzzy matching as a last resort and coalesces consecutive chars", () => {
    // "abc" appears as consecutive chars in "abcdef" — single span.
    const out = scoreMatch("abc", "abcdef", "x.md");
    expect(out).not.toBeNull();
    expect(out?.spans).toHaveLength(1);
    expect(out?.spans[0]).toMatchObject({
      field: "title",
      start: 0,
      end: 3,
    });
  });

  it("returns null when fuzzy can't cover every query char", () => {
    // No 'z' in haystack → fuzzy fails.
    expect(scoreMatch("xz", "alphabet", "x.md")).toBeNull();
  });

  it("ranks word-boundary title matches above path-only matches", () => {
    // "auth" is at a word boundary inside the title (after `-`), and a
    // plain substring inside the path. The title boundary tier (700)
    // should beat the path substring tier (400).
    const out = scoreMatch("auth", "user-auth flow", "lib/auth-helpers.md");
    expect(out).not.toBeNull();
    expect(out?.spans[0].field).toBe("title");
  });
});

describe("splitByMatches", () => {
  it("returns a single unmatched chunk when there are no spans", () => {
    expect(splitByMatches("hello", [])).toEqual([
      { text: "hello", matched: false },
    ]);
  });

  it("interleaves matched and unmatched chunks", () => {
    expect(splitByMatches("abcdef", [{ start: 1, end: 3 }])).toEqual([
      { text: "a", matched: false },
      { text: "bc", matched: true },
      { text: "def", matched: false },
    ]);
  });

  it("emits no leading unmatched chunk when the first span starts at 0", () => {
    expect(splitByMatches("abc", [{ start: 0, end: 1 }])).toEqual([
      { text: "a", matched: true },
      { text: "bc", matched: false },
    ]);
  });

  it("emits no trailing unmatched chunk when the last span ends at length", () => {
    expect(splitByMatches("abc", [{ start: 1, end: 3 }])).toEqual([
      { text: "a", matched: false },
      { text: "bc", matched: true },
    ]);
  });

  it("supports multiple non-overlapping spans", () => {
    expect(
      splitByMatches("a-b-c", [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
        { start: 4, end: 5 },
      ]),
    ).toEqual([
      { text: "a", matched: true },
      { text: "-", matched: false },
      { text: "b", matched: true },
      { text: "-", matched: false },
      { text: "c", matched: true },
    ]);
  });
});
