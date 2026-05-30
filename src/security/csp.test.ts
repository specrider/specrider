import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Parse a CSP header value into `{ directive: [sources...] }`.
 *  Source ordering is preserved so a reordering shows up in the diff. */
function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [directive, ...sources] = trimmed.split(/\s+/);
    out[directive] = sources;
  }
  return out;
}

/** The CSP lives in `tauri.conf.json` and is injected into the
 *  bundled index.html as a `<meta http-equiv="Content-Security-Policy">`
 *  tag at build time. We read it directly from disk here so the test
 *  runs in plain vitest without needing a built bundle.
 *
 *  This test is a *snapshot* of the directive set — when intentionally
 *  loosening or tightening the policy, update the expectations below
 *  and the corresponding line in `tauri.conf.json` together. The point
 *  is that PRs can't silently widen the policy without showing up in
 *  this diff. */
describe("Tauri CSP", () => {
  const security = (() => {
    const path = resolve(__dirname, "../../src-tauri/tauri.conf.json");
    const conf = JSON.parse(readFileSync(path, "utf8"));
    const security = conf?.app?.security;
    if (typeof security?.csp !== "string") {
      throw new Error("tauri.conf.json does not contain app.security.csp");
    }
    return security;
  })();
  const cspString = security.csp as string;
  const csp = parseCsp(cspString);

  it("lets Tauri keep its asset CSP modifications enabled", () => {
    expect(security.dangerousDisableAssetCspModification).toBeUndefined();
  });

  it("default-src is 'self' only", () => {
    expect(csp["default-src"]).toEqual(["'self'"]);
  });

  it("script-src is 'self' only — no inline, no eval", () => {
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("connect-src does not allow ws: or wss:", () => {
    // The app does not open WebSockets. Wildcards on `ws:`/`wss:`
    // would be dead weight that widens the exfiltration surface for
    // any future XSS.
    expect(csp["connect-src"]).not.toContain("ws:");
    expect(csp["connect-src"]).not.toContain("wss:");
  });

  it("connect-src allowlist is the documented set", () => {
    expect(csp["connect-src"]).toEqual([
      "'self'",
      "ipc:",
      "http://ipc.localhost",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ]);
  });

  it("img-src includes the trust-gated remote https: source", () => {
    // The wildcard https: is gated by workspace-trust at the resolver
    // layer — see workspace-trust.md. Untrusted workspaces never
    // produce an https: <img src>; the CSP allowance is only reachable
    // after the user has explicitly trusted the workspace.
    expect(csp["img-src"]).toContain("'self'");
    expect(csp["img-src"]).toContain("data:");
    expect(csp["img-src"]).toContain("blob:");
    expect(csp["img-src"]).toContain("specrider-img:");
    expect(csp["img-src"]).toContain("https:");
  });

  it("style-src keeps the fallback policy narrow", () => {
    expect(csp["style-src"]).toEqual(["'self'"]);
  });

  it("style-src-elem allows app CSS, boot styles, and Google Fonts CSS", () => {
    // Tauri can still add nonces/hashes to `style-src` at build/runtime.
    // Element and attribute styling are split out so Google Fonts links,
    // the boot `<style>` tag, and JS-injected cached font CSS do not
    // require disabling Tauri's asset CSP modification.
    expect(csp["style-src-elem"]).toEqual([
      "'self'",
      "'unsafe-inline'",
      "https://fonts.googleapis.com",
    ]);
  });

  it("style-src-attr allows React's controlled style attributes", () => {
    // KNOWN GAP. The renderer relies on React `style={...}` for dynamic
    // positioning, computed widths, font-family previews, and theme
    // swatches. User-authored markdown styles are still stripped by
    // src/markdown/sanitizeHtml.ts.
    expect(csp["style-src-attr"]).toEqual(["'unsafe-inline'"]);
  });

  it("font-src allows the Google Fonts CDN and the local font cache protocol", () => {
    expect(csp["font-src"]).toContain("'self'");
    expect(csp["font-src"]).toContain("https://fonts.gstatic.com");
    expect(csp["font-src"]).toContain("specrider-font:");
  });

  it("never declares a wildcard '*' source on any directive", () => {
    for (const [directive, sources] of Object.entries(csp)) {
      expect(sources, `${directive} must not contain '*'`).not.toContain("*");
    }
  });
});
