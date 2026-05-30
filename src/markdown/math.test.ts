import { describe, expect, it } from "vitest";
import { renderMath } from "./math";

describe("renderMath — KaTeX trust", () => {
  it("does NOT honor \\href to a javascript: URL", () => {
    // KaTeX's `trust: false` (default, but pinned explicitly) refuses
    // to emit an `<a>` tag for `\href`. We render some math that calls
    // `\href` and verify the output never carries a `javascript:`
    // attribute. KaTeX's behavior on a refused trust call is to fall
    // back to rendering the math inert (a `?` or similar marker), not
    // to emit the link.
    const out = renderMath("\\href{javascript:alert(1)}{x}", false);
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out).not.toMatch(/href=["']javascript/i);
  });

  it("does NOT emit anchors for \\url either", () => {
    const out = renderMath("\\url{javascript:alert(1)}", false);
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("renders well-formed math without throwing", () => {
    const out = renderMath("E = mc^2", false);
    expect(out).toContain("katex");
  });

  it("renders malformed math as a katex-error span instead of throwing", () => {
    // `throwOnError: false` keeps the document standing on a typo.
    const out = renderMath("\\frac{", false);
    expect(out).toContain("katex-error");
  });

  it("display mode produces a display-styled wrapper", () => {
    const inline = renderMath("x", false);
    const display = renderMath("x", true);
    expect(inline).not.toContain("katex-display");
    expect(display).toContain("katex-display");
  });
});
