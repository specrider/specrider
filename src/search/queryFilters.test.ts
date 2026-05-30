import { describe, expect, it } from "vitest";
import type { Plan } from "../types";
import { applyFilters, parseQuery, suggestValues } from "./queryFilters";

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "p",
    title: "P",
    path: "active/p.md",
    bucket: "active",
    modifiedAt: "2026-01-01",
    modifiedRaw: 0,
    lineCount: 0,
    wordCount: 0,
    readMinutes: 0,
    status: null,
    owner: "",
    contributors: [],
    progress: { done: 0, total: 0 },
    tags: [],
    iterationCount: 0,
    gitBranches: [],
    gitCommits: [],
    linkedRepoLinks: [],
    frontmatterIssues: [],
    ...overrides,
  };
}

describe("parseQuery", () => {
  it("returns empty results for an empty string", () => {
    expect(parseQuery("")).toEqual({
      filters: [],
      freeText: "",
      inProgress: null,
    });
  });

  it("parses a single tag: filter once committed by whitespace", () => {
    // Trailing space moves the cursor past the token so it commits to
    // `filters` instead of being reported as `inProgress`.
    const out = parseQuery("tag:a11y ");
    expect(out.filters).toEqual([
      { kind: "tag", value: "a11y", tokenStart: 0, tokenEnd: 8 },
    ]);
    expect(out.freeText).toBe("");
    expect(out.inProgress).toBeNull();
  });

  it("treats #foo as a tag alias once committed", () => {
    const out = parseQuery("#a11y ");
    expect(out.filters).toHaveLength(1);
    expect(out.filters[0]).toMatchObject({ kind: "tag", value: "a11y" });
  });

  it("treats @name as an assignee alias and keeps trailing free text", () => {
    const out = parseQuery("@jake review");
    expect(out.filters).toEqual([
      { kind: "assignee", value: "jake", tokenStart: 0, tokenEnd: 5 },
    ]);
    expect(out.freeText).toBe("review");
  });

  it("distinguishes owner: from @assignee", () => {
    // Pin current behavior — owner: is the strict variant, @ resolves
    // to assignee (owner OR contributors). Trailing space commits the
    // last token.
    const out = parseQuery("owner:jake @jake ");
    const kinds = out.filters.map((f) => f.kind).sort();
    expect(kinds).toEqual(["assignee", "owner"]);
  });

  it("reports a trailing tag: with no value as inProgress when cursor is at end", () => {
    const q = "tag:";
    const out = parseQuery(q, q.length);
    expect(out.filters).toEqual([]);
    expect(out.inProgress).toEqual({
      kind: "tag",
      partial: "",
      tokenStart: 0,
      tokenEnd: 4,
    });
  });

  it("reports a partially-typed value as inProgress and keeps it out of filters", () => {
    const q = "tag:a11";
    const out = parseQuery(q, q.length);
    expect(out.filters).toEqual([]);
    expect(out.inProgress).toMatchObject({ kind: "tag", partial: "a11" });
  });

  it("treats a committed token as a filter when the cursor is past it", () => {
    const q = "tag:a11y other";
    const out = parseQuery(q, q.length);
    expect(out.filters).toHaveLength(1);
    expect(out.filters[0]).toMatchObject({ kind: "tag", value: "a11y" });
    expect(out.inProgress).toBeNull();
    expect(out.freeText).toBe("other");
  });

  it("ANDs multiple recognized filters once committed", () => {
    const out = parseQuery("tag:a bucket:active ");
    expect(out.filters.map((f) => f.kind).sort()).toEqual(["bucket", "tag"]);
    expect(out.inProgress).toBeNull();
  });

  it("treats unknown prefixes as free text", () => {
    const out = parseQuery("mystery:foo");
    expect(out.filters).toEqual([]);
    expect(out.freeText).toBe("mystery:foo");
  });

  it("recognizes mixed-case prefixes (TAG: → tag:)", () => {
    const out = parseQuery("TAG:a ");
    expect(out.filters).toHaveLength(1);
    expect(out.filters[0]).toMatchObject({ kind: "tag" });
  });
});

describe("applyFilters", () => {
  const plans = [
    plan({
      id: "x",
      bucket: "active",
      tags: ["a11y", "perf"],
      owner: "Jake",
      contributors: ["Sam"],
    }),
    plan({
      id: "y",
      bucket: "backlog",
      tags: ["security"],
      owner: "Sam",
      contributors: [],
    }),
    plan({
      id: "z",
      bucket: "active",
      tags: ["security", "a11y"],
      owner: "Sam",
      contributors: ["Jake"],
    }),
  ];

  it("returns the input unchanged when there are no filters", () => {
    expect(applyFilters(plans, [])).toBe(plans);
  });

  it("matches a tag exactly", () => {
    const ids = applyFilters(plans, [
      { kind: "tag", value: "perf", tokenStart: 0, tokenEnd: 0 },
    ]).map((p) => p.id);
    expect(ids).toEqual(["x"]);
  });

  it("matches tags case-insensitively against frontmatter casing", () => {
    const ids = applyFilters(plans, [
      { kind: "tag", value: "A11Y", tokenStart: 0, tokenEnd: 0 },
    ]).map((p) => p.id);
    expect(ids.sort()).toEqual(["x", "z"]);
  });

  it("matches @assignee against owner OR contributors", () => {
    const ids = applyFilters(plans, [
      { kind: "assignee", value: "jake", tokenStart: 0, tokenEnd: 0 },
    ]).map((p) => p.id);
    expect(ids.sort()).toEqual(["x", "z"]);
  });

  it("matches owner: against owner only", () => {
    const ids = applyFilters(plans, [
      { kind: "owner", value: "jake", tokenStart: 0, tokenEnd: 0 },
    ]).map((p) => p.id);
    expect(ids).toEqual(["x"]);
  });

  it("matches bucket exactly", () => {
    const ids = applyFilters(plans, [
      { kind: "bucket", value: "active", tokenStart: 0, tokenEnd: 0 },
    ]).map((p) => p.id);
    expect(ids.sort()).toEqual(["x", "z"]);
  });

  it("ANDs multiple filters", () => {
    const ids = applyFilters(plans, [
      { kind: "bucket", value: "active", tokenStart: 0, tokenEnd: 0 },
      { kind: "tag", value: "security", tokenStart: 0, tokenEnd: 0 },
    ]).map((p) => p.id);
    expect(ids).toEqual(["z"]);
  });
});

describe("suggestValues", () => {
  const plans = [
    plan({ tags: ["a11y", "perf"], owner: "Jake" }),
    plan({ tags: ["a11y"], owner: "Sam", contributors: ["Jake"] }),
    plan({ tags: ["security"], owner: "Jake" }),
  ];

  it("returns tag values sorted by frequency then alpha", () => {
    expect(suggestValues(plans, "tag", "")).toEqual([
      "a11y",
      "perf",
      "security",
    ]);
  });

  it("filters by partial substring (case-insensitive)", () => {
    expect(suggestValues(plans, "tag", "SEC")).toEqual(["security"]);
  });

  it("for assignee, merges owner + contributors", () => {
    const out = suggestValues(plans, "assignee", "");
    // Jake appears as owner (×2) + contributor (×1) = 3, Sam owner = 1.
    expect(out[0]).toBe("Jake");
    expect(out).toContain("Sam");
  });
});
