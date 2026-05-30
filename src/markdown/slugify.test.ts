import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
  it("lowercases ASCII", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("collapses runs of separator chars to one hyphen", () => {
    expect(slugify("Hello   World")).toBe("hello-world");
    expect(slugify("a---b")).toBe("a-b");
  });

  it("strips punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("preserves underscores (treated as word chars)", () => {
    expect(slugify("foo_bar")).toBe("foo_bar");
  });

  it("strips non-ASCII letters and produces empty string for diacritic-only input", () => {
    // The current regex `[^\w\s-]` strips non-ASCII letters entirely.
    // Pin the behavior so a future Unicode-aware refactor lands as a
    // visible change.
    expect(slugify("café")).toBe("caf");
    expect(slugify("éé")).toBe("");
  });

  it("returns empty string for an empty input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});
