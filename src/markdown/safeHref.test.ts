import { describe, expect, it } from "vitest";
import { safeHref } from "./safeHref";

describe("safeHref", () => {
  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "  javascript:alert(1)",
    "\tjavascript:alert(1)",
    "vbscript:msgbox",
    "VBScript:msgbox",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html,foo",
  ])("blocks %p", (url) => {
    expect(safeHref(url)).toBeUndefined();
  });

  it.each([
    "https://example.com/page",
    "http://example.com/page",
    "mailto:foo@bar.com",
    "tel:+15551234567",
    "ftp://example.com/file",
    "#section-anchor",
    "./relative.md",
    "../sibling.md",
    "plain-text-not-a-url",
  ])("permits %p", (url) => {
    expect(safeHref(url)).toBe(url);
  });

  it("does NOT match when 'javascript' appears mid-string", () => {
    // The URL scheme is anchored at the start; a path containing the
    // word `javascript` is fine.
    expect(safeHref("https://example.com/blog/javascript-tips")).toBe(
      "https://example.com/blog/javascript-tips",
    );
  });
});
