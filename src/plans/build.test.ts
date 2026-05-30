import { describe, expect, it } from "vitest";
import type { PlanFileMeta } from "../tauri/api";
import { planFromFile } from "./build";

function meta(overrides: Partial<PlanFileMeta> = {}): PlanFileMeta {
  return {
    path: "active/example.md",
    modifiedSecs: Math.floor(Date.now() / 1000),
    size: 0,
    lineCount: 0,
    wordCount: 0,
    taskDone: 0,
    taskTotal: 0,
    frontmatter: null,
    h1: null,
    ...overrides,
  };
}

describe("planFromFile — title resolution", () => {
  it("frontmatter title always wins", () => {
    const p = planFromFile(
      meta({ frontmatter: { title: "From FM" }, h1: "From H1" }),
      "heading",
    );
    expect(p.title).toBe("From FM");
  });

  it("falls back to H1 when titleSource = heading and H1 exists", () => {
    const p = planFromFile(meta({ h1: "Hello World" }), "heading");
    expect(p.title).toBe("Hello World");
  });

  it("falls back to titlecased stem when titleSource = filename", () => {
    const p = planFromFile(
      meta({ path: "active/agent-prompts.md", h1: "Should Not Use" }),
      "filename",
    );
    expect(p.title).toBe("Agent Prompts");
  });

  it("falls back to titlecased stem when heading mode but no H1", () => {
    const p = planFromFile(meta({ path: "active/foo-bar.md" }), "heading");
    expect(p.title).toBe("Foo Bar");
  });
});

describe("planFromFile — status validation", () => {
  it("preserves a known status", () => {
    const p = planFromFile(meta({ frontmatter: { status: "in-progress" } }));
    expect(p.status).toBe("in-progress");
  });

  it("returns null for an unknown status", () => {
    const p = planFromFile(meta({ frontmatter: { status: "garbage" } }));
    expect(p.status).toBeNull();
  });

  it("returns null when status is missing entirely", () => {
    const p = planFromFile(meta({ frontmatter: {} }));
    expect(p.status).toBeNull();
  });
});

describe("planFromFile — bucket derivation", () => {
  it("derives bucket from the parent directory", () => {
    expect(planFromFile(meta({ path: "active/x.md" })).bucket).toBe("active");
    expect(planFromFile(meta({ path: "archive/x.md" })).bucket).toBe("archive");
  });

  it("uses 'loose' for top-level files with no parent dir", () => {
    expect(planFromFile(meta({ path: "x.md" })).bucket).toBe("loose");
  });

  it("derives bucket from the immediate parent of nested paths", () => {
    expect(
      planFromFile(meta({ path: "subprojects/auth/login.md" })).bucket,
    ).toBe("auth");
  });
});

describe("planFromFile — array fields", () => {
  it("passes through tags arrays and drops non-string entries", () => {
    const p = planFromFile(
      meta({ frontmatter: { tags: ["a", 1, null, "b"] } }),
    );
    expect(p.tags).toEqual(["a", "b"]);
  });

  it("passes through contributors arrays and drops non-strings", () => {
    const p = planFromFile(
      meta({ frontmatter: { contributors: ["jake", 42, "sam"] } }),
    );
    expect(p.contributors).toEqual(["jake", "sam"]);
  });

  it("returns empty arrays when array fields are missing", () => {
    const p = planFromFile(meta({ frontmatter: {} }));
    expect(p.tags).toEqual([]);
    expect(p.contributors).toEqual([]);
    expect(p.gitBranches).toEqual([]);
    expect(p.gitCommits).toEqual([]);
    expect(p.linkedRepoLinks).toEqual([]);
    expect(p.frontmatterIssues).toEqual([]);
  });

  it("treats a single string as a one-element array (tolerant frontmatter)", () => {
    const p = planFromFile(meta({ frontmatter: { tags: "solo" } }));
    expect(p.tags).toEqual(["solo"]);
  });
});

describe("planFromFile — linked repo links", () => {
  it("parses valid links and defaults base to main", () => {
    const p = planFromFile(
      meta({
        frontmatter: {
          links: [
            { repo: "code", branch: "feature/x" },
            { repo: "self", branch: "plans/x", base: "trunk" },
          ],
        },
      }),
      "heading",
      ["code"],
    );

    expect(p.linkedRepoLinks).toEqual([
      { repo: "code", branch: "feature/x", base: "main" },
      { repo: "self", branch: "plans/x", base: "trunk" },
    ]);
    expect(p.frontmatterIssues).toEqual([]);
  });

  it("omits links that reference unknown workspace repo handles", () => {
    const p = planFromFile(
      meta({
        frontmatter: {
          links: [
            { repo: "code", branch: "feature/x" },
            { repo: "missing", branch: "feature/y" },
          ],
        },
      }),
      "heading",
      ["code"],
    );

    expect(p.linkedRepoLinks).toEqual([
      { repo: "code", branch: "feature/x", base: "main" },
    ]);
    expect(p.frontmatterIssues).toContainEqual({
      field: "links[1].repo",
      message: 'Unknown linked repo handle "missing".',
    });
  });

  it("omits malformed links without throwing", () => {
    expect(() =>
      planFromFile(
        meta({ frontmatter: { links: ["nope", { repo: "code" }, 42] } }),
        "heading",
        ["code"],
      ),
    ).not.toThrow();

    const p = planFromFile(
      meta({ frontmatter: { links: ["nope", { repo: "code" }, 42] } }),
      "heading",
      ["code"],
    );
    expect(p.linkedRepoLinks).toEqual([]);
    expect(p.frontmatterIssues.map((issue) => issue.field)).toEqual([
      "links[0]",
      "links[1].branch",
      "links[2]",
    ]);
  });

  it("reports a non-list links value as a frontmatter issue", () => {
    const p = planFromFile(
      meta({ frontmatter: { links: { repo: "code", branch: "feature/x" } } }),
      "heading",
      ["code"],
    );

    expect(p.linkedRepoLinks).toEqual([]);
    expect(p.frontmatterIssues).toEqual([
      {
        field: "links",
        message: "`links` must be a list of repo/branch objects.",
      },
    ]);
  });
});

describe("planFromFile — read-minutes math", () => {
  it("returns 0 minutes for a 0-word document (no divide-by-zero, no minimum-of-one)", () => {
    const p = planFromFile(meta({ wordCount: 0 }));
    expect(p.readMinutes).toBe(0);
  });

  it("rounds up partial minutes", () => {
    const p = planFromFile(meta({ wordCount: 221 }));
    expect(p.readMinutes).toBe(2);
  });

  it("uses a minimum of 1 minute for any non-zero word count", () => {
    const p = planFromFile(meta({ wordCount: 1 }));
    expect(p.readMinutes).toBe(1);
  });
});

describe("planFromFile — owner / iteration / progress passthrough", () => {
  it("passes owner through verbatim", () => {
    const p = planFromFile(meta({ frontmatter: { owner: "Jake" } }));
    expect(p.owner).toBe("Jake");
  });

  it("defaults owner to empty string when missing", () => {
    expect(planFromFile(meta()).owner).toBe("");
  });

  it("accepts iteration as a number or numeric string", () => {
    expect(
      planFromFile(meta({ frontmatter: { iteration: 3 } })).iterationCount,
    ).toBe(3);
    expect(
      planFromFile(meta({ frontmatter: { iteration: "5" } })).iterationCount,
    ).toBe(5);
  });

  it("defaults iteration to 0 when malformed", () => {
    expect(
      planFromFile(meta({ frontmatter: { iteration: "abc" } })).iterationCount,
    ).toBe(0);
  });

  it("populates progress from taskDone / taskTotal", () => {
    const p = planFromFile(meta({ taskDone: 2, taskTotal: 5 }));
    expect(p.progress).toEqual({ done: 2, total: 5 });
  });
});
