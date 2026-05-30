import { describe, expect, it } from "vitest";
import { DIFF_WIDE_LAYOUT_MIN_WIDTH, isWideDiffLayout } from "./diffLayout";

describe("diff layout breakpoint", () => {
  it("uses single-column layout below the pane-width threshold", () => {
    expect(isWideDiffLayout(DIFF_WIDE_LAYOUT_MIN_WIDTH - 1)).toBe(false);
  });

  it("uses two-column layout at and above the pane-width threshold", () => {
    expect(isWideDiffLayout(DIFF_WIDE_LAYOUT_MIN_WIDTH)).toBe(true);
    expect(isWideDiffLayout(DIFF_WIDE_LAYOUT_MIN_WIDTH + 160)).toBe(true);
  });
});
