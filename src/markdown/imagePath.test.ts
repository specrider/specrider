import { describe, expect, it } from "vitest";
import { imageSrc } from "./imagePath";

describe("imageSrc — scheme allowlist", () => {
  it("passes https URLs through", () => {
    const r = imageSrc(null, "https://example.com/x.png");
    expect(r).toEqual({
      src: "https://example.com/x.png",
      remote: true,
      blocked: false,
      reason: null,
    });
  });

  it("passes http URLs through (CSP layer drops them)", () => {
    const r = imageSrc(null, "http://example.com/x.png");
    expect(r.remote).toBe(true);
    expect(r.blocked).toBe(false);
  });

  it("passes data: through as local", () => {
    const r = imageSrc(null, "data:image/png;base64,AAAA");
    expect(r).toMatchObject({ remote: false, blocked: false });
    expect(r.src.startsWith("data:")).toBe(true);
  });

  it("passes blob: through as local", () => {
    const r = imageSrc(null, "blob:abc-123");
    expect(r).toMatchObject({ remote: false, blocked: false });
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "  javascript:alert(1)",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "ssh://example.com/x.png",
    "ftp://example.com/x.png",
  ])("blocks unsafe scheme %p", (url) => {
    const r = imageSrc(null, url);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("scheme");
    expect(r.src).toBe("");
  });
});

describe("imageSrc — workspace trust gate", () => {
  it("blocks remote refs as untrusted when remoteAllowed is false", () => {
    const r = imageSrc(null, "https://example.com/x.png", {
      remoteAllowed: false,
    });
    expect(r).toEqual({
      src: "https://example.com/x.png",
      remote: true,
      blocked: true,
      reason: "untrusted",
    });
  });

  it("preserves the original URL on untrusted block so the placeholder can re-load it", () => {
    const r = imageSrc(null, "http://example.com/x.png", {
      remoteAllowed: false,
    });
    expect(r.src).toBe("http://example.com/x.png");
    expect(r.reason).toBe("untrusted");
  });

  it("svg block still wins over the trust gate", () => {
    // The renderer should never be tricked into loading external SVG
    // even if the user later trusts the workspace, so the scheme-level
    // refusal precedes the trust check.
    const r = imageSrc(null, "https://example.com/x.svg", {
      remoteAllowed: false,
    });
    expect(r.reason).toBe("svg");
    expect(r.src).toBe("");
  });

  it("local refs are unaffected by remoteAllowed: false", () => {
    const r = imageSrc("docs/plans/foo.md", "./local.png", {
      remoteAllowed: false,
    });
    expect(r.blocked).toBe(false);
    expect(r.src.startsWith("specrider-img://")).toBe(true);
  });

  it("data: refs are unaffected by remoteAllowed: false", () => {
    const r = imageSrc(null, "data:image/png;base64,AAAA", {
      remoteAllowed: false,
    });
    expect(r.blocked).toBe(false);
  });

  it("scheme refusal beats trust gate for unsafe schemes", () => {
    const r = imageSrc(null, "javascript:alert(1)", {
      remoteAllowed: false,
    });
    expect(r.reason).toBe("scheme");
  });
});

describe("imageSrc — external SVG block", () => {
  it("blocks https .svg", () => {
    const r = imageSrc(null, "https://example.com/x.svg");
    expect(r).toMatchObject({ remote: true, blocked: true });
  });

  it("blocks https .SVG (case-insensitive)", () => {
    const r = imageSrc(null, "https://example.com/X.SVG");
    expect(r.blocked).toBe(true);
  });

  it("blocks https .svg with query string", () => {
    const r = imageSrc(null, "https://example.com/x.svg?cache=1");
    expect(r.blocked).toBe(true);
  });

  it("blocks https .svg with fragment", () => {
    const r = imageSrc(null, "https://example.com/x.svg#anchor");
    expect(r.blocked).toBe(true);
  });

  it("does NOT block local .svg (resolves via specrider-img)", () => {
    const r = imageSrc("docs/plans/foo.md", "./diagram.svg");
    expect(r.blocked).toBe(false);
    expect(r.src.startsWith("specrider-img://")).toBe(true);
  });

  it("does not false-positive on .svg-like names", () => {
    const r = imageSrc(null, "https://example.com/svgfile.png");
    expect(r.blocked).toBe(false);
    expect(r.src).toBe("https://example.com/svgfile.png");
  });
});

describe("imageSrc — plan-relative resolution", () => {
  const decodePath = (src: string) =>
    decodeURIComponent(src.replace(/^specrider-img:\/\/localhost\//, ""));

  it("resolves a relative ref against the plan's directory", () => {
    const r = imageSrc("docs/plans/active/foo.md", "./img/x.png");
    expect(decodePath(r.src)).toBe("docs/plans/active/img/x.png");
  });

  it("resolves a parent-relative ref", () => {
    const r = imageSrc("docs/plans/active/foo.md", "../shared/x.png");
    expect(decodePath(r.src)).toBe("docs/plans/shared/x.png");
  });

  it("treats a leading slash as plans-root absolute", () => {
    const r = imageSrc("docs/plans/active/foo.md", "/img/root.png");
    expect(decodePath(r.src)).toBe("img/root.png");
  });

  it("preserves leading .. so the protocol's traversal guard catches it", () => {
    // Escapes the plan directory and the plans root — the resolver
    // emits the literal `..` segments rather than silently rewriting
    // to root, so the Rust handler can refuse on canonicalize.
    const r = imageSrc("foo.md", "../../etc/passwd");
    expect(decodePath(r.src)).toBe("../../etc/passwd");
    // Extension not in the allowlist; the Rust side will 404 it.
    // We only check the path was preserved verbatim.
  });

  it("URL-encodes the path so spaces survive transport", () => {
    const r = imageSrc("foo.md", "./my pictures/cat.png");
    expect(r.src).toContain(encodeURIComponent("my pictures/cat.png"));
  });

  it("returns blocked for empty refs", () => {
    expect(imageSrc(null, "")).toEqual({
      src: "",
      remote: false,
      blocked: true,
      reason: "scheme",
    });
    expect(imageSrc(null, "   ")).toEqual({
      src: "",
      remote: false,
      blocked: true,
      reason: "scheme",
    });
  });
});
