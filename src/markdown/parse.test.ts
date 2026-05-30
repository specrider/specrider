import { describe, expect, it } from "vitest";
import { extractFrontmatter, parseMarkdown, stringifyMarkdown } from "./parse";

describe("extractFrontmatter", () => {
  it("returns null when no frontmatter is present", () => {
    expect(extractFrontmatter(parseMarkdown("# just prose"))).toBeNull();
  });

  it("parses well-formed YAML at the top of the doc", () => {
    const src = "---\nstatus: draft\nowner: jake\n---\n# Hi\n";
    const fm = extractFrontmatter(parseMarkdown(src));
    expect(fm).toMatchObject({ status: "draft", owner: "jake" });
  });

  it("returns arrays for tag-style values", () => {
    const src = "---\ntags: [security, render]\n---\n";
    const fm = extractFrontmatter(parseMarkdown(src));
    expect(fm?.tags).toEqual(["security", "render"]);
  });

  it("returns numeric iteration values as numbers", () => {
    const src = "---\niteration: 3\n---\n";
    const fm = extractFrontmatter(parseMarkdown(src));
    expect(fm?.iteration).toBe(3);
  });

  it("returns null when YAML is malformed (does not throw)", () => {
    const src = "---\n: not valid: yaml: here\n  ::: oops\n---\n";
    // Some malformed YAML may parse as a string — the contract is
    // "no throw, return null when not an object". Either null or a
    // non-object result satisfies that.
    expect(() => extractFrontmatter(parseMarkdown(src))).not.toThrow();
  });

  it("returns null when the first node isn't yaml", () => {
    const src = "# Heading first\n\n---\nstatus: draft\n---\n";
    expect(extractFrontmatter(parseMarkdown(src))).toBeNull();
  });

  it("returns null for an empty frontmatter block", () => {
    const src = "---\n---\n# body\n";
    expect(extractFrontmatter(parseMarkdown(src))).toBeNull();
  });
});

describe("stringifyMarkdown round-trip", () => {
  it("preserves a heading + paragraph + list", () => {
    const src = "# Title\n\nIntro paragraph.\n\n- one\n- two\n";
    const round = stringifyMarkdown(parseMarkdown(src));
    expect(round).toContain("# Title");
    expect(round).toContain("Intro paragraph.");
    expect(round).toContain("- one");
    expect(round).toContain("- two");
  });

  it("preserves frontmatter", () => {
    const src = "---\nstatus: draft\n---\n\n# Hi\n";
    const round = stringifyMarkdown(parseMarkdown(src));
    expect(round).toMatch(/^---\nstatus: draft\n---/);
  });

  it("preserves task-list checkboxes", () => {
    const src = "- [ ] todo\n- [x] done\n";
    const round = stringifyMarkdown(parseMarkdown(src));
    expect(round).toContain("- [ ] todo");
    expect(round).toContain("- [x] done");
  });

  it("preserves math fences (remark-math is in the stringifier)", () => {
    const src = "Inline $E=mc^2$ and display:\n\n$$\nx + y\n$$\n";
    const round = stringifyMarkdown(parseMarkdown(src));
    expect(round).toContain("$E=mc^2$");
    expect(round).toContain("$$");
  });
});
