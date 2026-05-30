import { describe, expect, it } from "vitest";
import { insertTaskAfter, moveTaskBlock, removeTaskBlock } from "./taskOps";

const sample = [
  "# Tasks",
  "",
  "- [ ] alpha",
  "- [ ] beta",
  "  - [ ] beta-1",
  "  - [ ] beta-2",
  "- [x] gamma",
  "",
].join("\n");

describe("insertTaskAfter", () => {
  it("inserts a sibling task after the target's subtree", () => {
    // beta runs lines 4..6 (1-based: header,blank,alpha,beta,b1,b2,gamma,_)
    const result = insertTaskAfter(sample, 4, 6);
    if (!result) throw new Error("insertTaskAfter returned null");
    const lines = result.next.split("\n");
    // New task should appear at line 7 (between beta-2 and gamma)
    expect(lines[6]).toBe("- [ ] ");
    expect(result?.newTaskLine).toBe(7);
    // gamma must still be present, just shifted down
    expect(lines).toContain("- [x] gamma");
  });

  it("inherits the indent and bullet marker", () => {
    // Insert after beta-1 (a nested task)
    const result = insertTaskAfter(sample, 5, 5);
    if (!result) throw new Error("insertTaskAfter returned null");
    const lines = result.next.split("\n");
    expect(lines[5]).toBe("  - [ ] ");
  });

  it("returns null when the target line isn't a task row", () => {
    expect(insertTaskAfter(sample, 1, 1)).toBeNull(); // heading
    expect(insertTaskAfter(sample, 2, 2)).toBeNull(); // blank
  });

  it("returns null for out-of-range lines", () => {
    expect(insertTaskAfter(sample, 0, 0)).toBeNull();
    expect(insertTaskAfter(sample, 99, 99)).toBeNull();
    expect(insertTaskAfter(sample, 4, 3)).toBeNull(); // end < start
  });

  it("works with `*` bullet marker", () => {
    const src = "* [ ] one\n";
    const result = insertTaskAfter(src, 1, 1);
    expect(result).not.toBeNull();
    expect(result?.next.split("\n")[1]).toBe("* [ ] ");
  });

  it("works with `+` bullet marker", () => {
    const src = "+ [ ] one\n";
    const result = insertTaskAfter(src, 1, 1);
    expect(result).not.toBeNull();
    expect(result?.next.split("\n")[1]).toBe("+ [ ] ");
  });
});

describe("removeTaskBlock", () => {
  it("removes a leaf task without touching neighbors", () => {
    // alpha is line 3
    const next = removeTaskBlock(sample, 3, 3);
    const lines = next.split("\n");
    expect(lines).not.toContain("- [ ] alpha");
    expect(lines).toContain("- [ ] beta");
    expect(lines).toContain("- [x] gamma");
  });

  it("removes a parent task and its entire subtree", () => {
    // beta + children = lines 4..6
    const next = removeTaskBlock(sample, 4, 6);
    const lines = next.split("\n");
    expect(lines).not.toContain("- [ ] beta");
    expect(lines).not.toContain("  - [ ] beta-1");
    expect(lines).not.toContain("  - [ ] beta-2");
    expect(lines).toContain("- [ ] alpha");
    expect(lines).toContain("- [x] gamma");
  });

  it("is a no-op for invalid ranges", () => {
    expect(removeTaskBlock(sample, 0, 0)).toBe(sample);
    expect(removeTaskBlock(sample, 99, 99)).toBe(sample);
    expect(removeTaskBlock(sample, 5, 3)).toBe(sample); // end < start
  });

  it("removes the last line when range hits EOF", () => {
    const src = "- [ ] only\n";
    const next = removeTaskBlock(src, 1, 1);
    expect(next).toBe("");
  });
});

describe("moveTaskBlock", () => {
  it("moves a task before another at the same indent", () => {
    // Move gamma (line 7) to before alpha (line 3)
    const next = moveTaskBlock(sample, 7, 7, 3, "before", 0);
    const lines = next.split("\n");
    // After move: heading, blank, gamma, alpha, beta, b1, b2, blank
    expect(lines[2]).toBe("- [x] gamma");
    expect(lines[3]).toBe("- [ ] alpha");
  });

  it("moves a subtree, preserving children's relative indent", () => {
    // Move beta + its children (lines 4..6) to after gamma (line 7)
    const next = moveTaskBlock(sample, 4, 6, 7, "after", 0);
    const lines = next.split("\n");
    // Order: heading, blank, alpha, gamma, beta, b1, b2, blank
    expect(lines[2]).toBe("- [ ] alpha");
    expect(lines[3]).toBe("- [x] gamma");
    expect(lines[4]).toBe("- [ ] beta");
    expect(lines[5]).toBe("  - [ ] beta-1");
    expect(lines[6]).toBe("  - [ ] beta-2");
  });

  it("indents a moved task when newIndent > old", () => {
    // Move alpha into beta's subtree as a child of beta-2
    const next = moveTaskBlock(sample, 3, 3, 6, "after", 4);
    const lines = next.split("\n");
    // Find the relocated alpha
    const idx = lines.findIndex((l) => l.includes("alpha"));
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx]).toBe("    - [ ] alpha");
  });

  it("outdents a moved task when newIndent < old", () => {
    // Move beta-1 (indent 2) up to top-level (indent 0) before beta
    const next = moveTaskBlock(sample, 5, 5, 4, "before", 0);
    const lines = next.split("\n");
    const idx = lines.findIndex((l) => l.includes("beta-1"));
    expect(lines[idx]).toBe("- [ ] beta-1");
  });

  it("never produces an empty line when outdenting more spaces than exist", () => {
    // Source with only 2 leading spaces; ask for outdent of 10
    const src = "  - [ ] tiny\n- [ ] anchor\n";
    const next = moveTaskBlock(src, 1, 1, 2, "before", -8);
    const lines = next.split("\n");
    // Strip went down to 0; line is preserved without leading spaces.
    expect(lines[0]).toBe("- [ ] tiny");
    expect(lines[1]).toBe("- [ ] anchor");
  });

  it("is a no-op when the anchor is inside the moved range", () => {
    // Try to drop beta inside its own subtree
    expect(moveTaskBlock(sample, 4, 6, 5, "before", 0)).toBe(sample);
    expect(moveTaskBlock(sample, 4, 6, 6, "after", 0)).toBe(sample);
    expect(moveTaskBlock(sample, 4, 6, 4, "after", 0)).toBe(sample);
  });

  it("is a no-op for invalid ranges", () => {
    expect(moveTaskBlock(sample, 0, 0, 3, "before", 0)).toBe(sample);
    expect(moveTaskBlock(sample, 99, 99, 3, "before", 0)).toBe(sample);
    expect(moveTaskBlock(sample, 4, 3, 3, "before", 0)).toBe(sample);
    expect(moveTaskBlock(sample, 3, 3, 0, "before", 0)).toBe(sample);
    expect(moveTaskBlock(sample, 3, 3, 99, "before", 0)).toBe(sample);
  });

  it("returns the original source when destination ends up identical", () => {
    // Drop alpha right before itself with no indent change → no-op.
    // (anchor is alpha itself, but anchor === fromStart is excluded
    // by the in-range guard.) Use a same-position non-range setup:
    const src = "- [ ] a\n- [ ] b\n";
    // Move b to after a (its current position) — same-place identity.
    const next = moveTaskBlock(src, 2, 2, 1, "after", 0);
    expect(next).toBe(src);
  });

  it("preserves blank lines inside a moved subtree", () => {
    const src = ["- [ ] outer", "", "  - [ ] inner", "- [ ] anchor"].join("\n");
    const next = moveTaskBlock(src, 1, 3, 4, "after", 0);
    const lines = next.split("\n");
    expect(lines).toEqual(["- [ ] anchor", "- [ ] outer", "", "  - [ ] inner"]);
  });
});
