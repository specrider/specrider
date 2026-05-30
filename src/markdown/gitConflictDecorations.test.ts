import { describe, expect, it } from "vitest";
import { findConflictBlocks } from "./gitConflictDecorations";

describe("findConflictBlocks", () => {
  it("returns no blocks for clean text", () => {
    expect(findConflictBlocks("just prose\nmore prose\n")).toEqual([]);
  });

  it("parses a single well-formed block", () => {
    const doc = [
      "before",
      "<<<<<<< HEAD",
      "ours line",
      "=======",
      "theirs line",
      ">>>>>>> branch",
      "after",
    ].join("\n");
    const blocks = findConflictBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].oursText).toBe("ours line\n");
    expect(blocks[0].theirsText).toBe("theirs line\n");
    expect(blocks[0].oursStartLine).toBe(2);
    expect(blocks[0].theirsEndLine).toBe(5);
  });

  it("blockStart / blockEnd cover the full marker range", () => {
    const doc = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> branch"].join(
      "\n",
    );
    const blocks = findConflictBlocks(doc);
    // blockStart is offset 0; blockEnd is just past the trailing
    // ">>>>>>> branch" line (no newline after, since it's the last).
    expect(blocks[0].blockStart).toBe(0);
    expect(doc.slice(blocks[0].blockStart, blocks[0].blockEnd)).toBe(doc);
  });

  it("skips a block missing its `=======` divider", () => {
    const doc = ["<<<<<<< HEAD", "ours", "ours2", ">>>>>>> branch"].join("\n");
    expect(findConflictBlocks(doc)).toEqual([]);
  });

  it("skips a block missing its closing `>>>>>>>`", () => {
    const doc = ["<<<<<<< HEAD", "a", "=======", "b"].join("\n");
    expect(findConflictBlocks(doc)).toEqual([]);
  });

  it("aborts parsing when a nested `<<<<<<<` appears before the divider", () => {
    const doc = [
      "<<<<<<< HEAD",
      "ours",
      "<<<<<<< nested",
      "=======",
      "theirs",
      ">>>>>>> branch",
    ].join("\n");
    // Outer block has no divider before the nested marker → aborted.
    // The inner well-formed block IS detected starting at line 3.
    const blocks = findConflictBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].oursStartLine).toBe(3);
  });

  it("handles two consecutive blocks", () => {
    const doc = [
      "<<<<<<< HEAD",
      "a",
      "=======",
      "b",
      ">>>>>>> branch",
      "<<<<<<< HEAD",
      "c",
      "=======",
      "d",
      ">>>>>>> branch",
    ].join("\n");
    const blocks = findConflictBlocks(doc);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].oursText).toBe("a\n");
    expect(blocks[1].oursText).toBe("c\n");
  });

  it("handles a marker at the very end of the file", () => {
    // The closing `>>>>>>> branch` has no trailing newline. Parser must
    // still pick it up.
    const doc = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch";
    const blocks = findConflictBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockEnd).toBe(doc.length);
  });
});
