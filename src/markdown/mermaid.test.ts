import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Mermaid is too heavy to load in unit tests (it pulls in d3, which
// touches DOMRect APIs jsdom only half-implements), so the regression
// here is a source-level invariant: `securityLevel: "strict"` MUST be
// part of the initialize call. A silent flip to `loose` would let
// user-authored Mermaid blocks execute embedded HTML — this test is
// the canary that catches it.

const here = dirname(fileURLToPath(import.meta.url));
const mermaidSource = readFileSync(resolve(here, "mermaid.ts"), "utf-8");

describe("mermaid security configuration", () => {
  it("pins securityLevel to strict", () => {
    expect(mermaidSource).toMatch(/securityLevel:\s*"strict"/);
    expect(mermaidSource).not.toMatch(/securityLevel:\s*"loose"/);
    expect(mermaidSource).not.toMatch(/securityLevel:\s*"antiscript"/);
  });

  it("disables startOnLoad so nothing auto-renders against arbitrary DOM", () => {
    expect(mermaidSource).toMatch(/startOnLoad:\s*false/);
  });
});
