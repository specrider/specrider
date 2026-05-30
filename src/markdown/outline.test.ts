import { describe, expect, it } from "vitest";
import { extractOutline, totalProgress } from "./outline";
import { parseMarkdown } from "./parse";

function parse(src: string) {
  return parseMarkdown(src);
}

describe("extractOutline", () => {
  it("returns an empty array for a doc with no headings", () => {
    expect(extractOutline(parse("just prose, no heads"))).toEqual([]);
  });

  it("returns an empty array for a frontmatter-only doc", () => {
    const tree = parse("---\nstatus: draft\n---\n");
    expect(extractOutline(tree)).toEqual([]);
  });

  it("extracts a single H1 with no children", () => {
    const tree = parse("# Title\n");
    const outline = extractOutline(tree);
    expect(outline).toHaveLength(1);
    expect(outline[0]).toMatchObject({
      text: "Title",
      depth: 1,
      taskTotal: 0,
      taskDone: 0,
    });
  });

  it("treats H1 and H2 as visual siblings (both depth 1)", () => {
    const tree = parse("# A\n\n## B\n");
    const outline = extractOutline(tree);
    expect(outline.map((n) => n.depth)).toEqual([1, 1]);
  });

  it("nests H3 under the most recent top-level heading", () => {
    const tree = parse("# A\n\n## B\n\n### C\n");
    const outline = extractOutline(tree);
    expect(outline).toHaveLength(2);
    expect(outline[1].text).toBe("B");
    expect(outline[1].children).toHaveLength(1);
    expect(outline[1].children[0]).toMatchObject({ text: "C", depth: 2 });
  });

  it("ignores H4+ silently", () => {
    const tree = parse("# A\n\n#### invisible\n");
    const outline = extractOutline(tree);
    expect(outline).toHaveLength(1);
    expect(outline[0].children).toEqual([]);
  });

  it("counts tasks under a heading", () => {
    const tree = parse("# Plan\n\n- [ ] one\n- [x] two\n- [ ] three\n");
    const outline = extractOutline(tree);
    expect(outline[0].taskTotal).toBe(3);
    expect(outline[0].taskDone).toBe(1);
  });

  it("rolls up tasks from H3 sections into the parent H2", () => {
    const tree = parse("## Section\n\n### Sub\n\n- [ ] a\n- [x] b\n");
    const outline = extractOutline(tree);
    expect(outline).toHaveLength(1);
    expect(outline[0].text).toBe("Section");
    expect(outline[0].taskTotal).toBe(2);
    expect(outline[0].taskDone).toBe(1);
  });

  it("does NOT double-count when an H1 has its own intro tasks plus a child H2", () => {
    // H1 acts as a sibling of H2 (per the comment in outline.ts):
    // its rollup window is just [H1, next heading), so the H2's
    // tasks don't leak into the H1's totals.
    const tree = parse(
      "# Top\n\n- [ ] intro-a\n\n## Sub\n\n- [ ] sub-a\n- [x] sub-b\n",
    );
    const outline = extractOutline(tree);
    expect(outline).toHaveLength(2);
    const top = outline.find((n) => n.text === "Top");
    const sub = outline.find((n) => n.text === "Sub");
    if (!top) throw new Error("missing Top heading");
    if (!sub) throw new Error("missing Sub heading");
    expect(top.taskTotal).toBe(1);
    expect(top.taskDone).toBe(0);
    expect(sub.taskTotal).toBe(2);
    expect(sub.taskDone).toBe(1);
  });

  it("counts nested checklist children at the right depth", () => {
    const tree = parse(
      "# Plan\n\n- [ ] outer\n  - [ ] inner-1\n  - [x] inner-2\n",
    );
    const outline = extractOutline(tree);
    expect(outline[0].taskTotal).toBe(3);
    expect(outline[0].taskDone).toBe(1);
    // Direct tasks contains all three, with the children indented
    expect(outline[0].tasks.map((t) => t.depth)).toEqual([0, 1, 1]);
  });

  it("collects non-task list items separately from tasks", () => {
    const tree = parse("# Plan\n\n- plain bullet\n- [ ] real task\n");
    const outline = extractOutline(tree);
    expect(outline[0].tasks).toHaveLength(1);
    expect(outline[0].tasks[0].text).toContain("real task");
    expect(outline[0].lists).toHaveLength(1);
    expect(outline[0].lists[0].text).toContain("plain bullet");
  });

  it("assigns stable heading IDs across re-extractions", () => {
    const src = "# Same\n\n## Same\n";
    const a = extractOutline(parse(src));
    const b = extractOutline(parse(src));
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
  });
});

describe("totalProgress", () => {
  it("sums task counts across a flat outline", () => {
    const tree = parse("# A\n- [ ] a\n# B\n- [x] b\n");
    const outline = extractOutline(tree);
    expect(totalProgress(outline)).toEqual({ done: 1, total: 2 });
  });

  it("returns zeros for an empty outline", () => {
    expect(totalProgress([])).toEqual({ done: 0, total: 0 });
  });
});
