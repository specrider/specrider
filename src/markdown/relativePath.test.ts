import { describe, expect, it } from "vitest";
import { resolveRelativePath } from "./relativePath";

describe("resolveRelativePath", () => {
  it("resolves a same-dir reference", () => {
    expect(resolveRelativePath("docs/plans/foo.md", "./bar.md")).toBe(
      "docs/plans/bar.md",
    );
  });

  it("resolves a sibling reference without ./", () => {
    expect(resolveRelativePath("docs/plans/foo.md", "bar.md")).toBe(
      "docs/plans/bar.md",
    );
  });

  it("resolves a parent-dir reference", () => {
    expect(resolveRelativePath("docs/plans/active/foo.md", "../bar.md")).toBe(
      "docs/plans/bar.md",
    );
  });

  it("collapses multi-segment .. paths", () => {
    expect(resolveRelativePath("a/b/c/d.md", "../../shared/x.md")).toBe(
      "a/shared/x.md",
    );
  });

  it("returns null when traversal walks above the root", () => {
    // d.md is at depth 1 (parent dir is empty after .slice(0, -1));
    // a single .. exhausts the dir stack, then the next non-`..` seg
    // pushes onto an empty list. Two ..s in a depth-1 doc fail.
    expect(resolveRelativePath("d.md", "../../escape.md")).toBeNull();
  });

  it("returns null for an empty href", () => {
    expect(resolveRelativePath("a/b.md", "")).toBeNull();
  });

  it("ignores empty segments and `.` segments", () => {
    expect(resolveRelativePath("a/b/c.md", "./././d.md")).toBe("a/b/d.md");
    expect(resolveRelativePath("a/b/c.md", "d//e.md")).toBe("a/b/d/e.md");
  });

  it("handles a top-level current path (no parent dir)", () => {
    expect(resolveRelativePath("foo.md", "bar.md")).toBe("bar.md");
    expect(resolveRelativePath("foo.md", "./bar.md")).toBe("bar.md");
  });

  it("preserves nested target paths", () => {
    expect(
      resolveRelativePath("docs/plans/foo.md", "subfolder/inner/x.md"),
    ).toBe("docs/plans/subfolder/inner/x.md");
  });
});
