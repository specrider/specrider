import { describe, expect, it } from "vitest";
import { assignHeadingIds } from "./headingIds";
import { parseMarkdown } from "./parse";

function ids(src: string): string[] {
  const map = assignHeadingIds(parseMarkdown(src));
  // Iterate in line-number order so the assertion is stable.
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

describe("assignHeadingIds", () => {
  it("returns an empty map for a heading-less doc", () => {
    expect(assignHeadingIds(parseMarkdown("just prose")).size).toBe(0);
  });

  it("slugifies a single heading", () => {
    expect(ids("# Hello World")).toEqual(["hello-world"]);
  });

  it("suffixes duplicates with -2, -3, ...", () => {
    expect(ids("# Same\n\n## Same\n\n### Same\n")).toEqual([
      "same",
      "same-2",
      "same-3",
    ]);
  });

  it("falls back to 'section' when slug is empty", () => {
    // A heading with only punctuation slugs to "" — the helper
    // substitutes "section" so the id is still routable.
    expect(ids("# !!!")).toEqual(["section"]);
  });

  it("dedupes empty-slug fallbacks", () => {
    expect(ids("# !!!\n## ???\n")).toEqual(["section", "section-2"]);
  });

  it("is stable across re-parses of the same source", () => {
    const src = "# A\n## B\n## A\n";
    expect(ids(src)).toEqual(ids(src));
  });

  it("keys by source line so the outline can look up by line", () => {
    const tree = parseMarkdown("# First\n\n## Second\n");
    const map = assignHeadingIds(tree);
    expect(map.get(1)).toBe("first");
    expect(map.get(3)).toBe("second");
  });

  it("handles non-ASCII heading text via slugify", () => {
    // Just verify it doesn't throw and produces a non-empty slug for
    // each entry. The exact slug shape is owned by `slugify`.
    const result = ids("# Café\n## 漢字\n");
    expect(result).toHaveLength(2);
    for (const id of result) {
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
