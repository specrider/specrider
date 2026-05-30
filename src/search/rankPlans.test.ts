import { describe, expect, it } from "vitest";
import { comparePlanRecency } from "../plans/sort";
import type { Plan } from "../types";
import { rankPlans } from "./rankPlans";

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: overrides.path ?? "p",
    title: "P",
    path: "active/p.md",
    bucket: "active",
    modifiedAt: "",
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

describe("comparePlanRecency", () => {
  it("sorts smaller modifiedRaw values first because they are newer", () => {
    const plans = [
      plan({ id: "old", modifiedRaw: 10_000 }),
      plan({ id: "new", modifiedRaw: 5 }),
      plan({ id: "mid", modifiedRaw: 100 }),
    ];
    expect(plans.sort(comparePlanRecency).map((p) => p.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });
});

describe("rankPlans", () => {
  it("returns the most-recent plans when query is empty", () => {
    const plans = [
      plan({ id: "old", modifiedRaw: 10_000 }),
      plan({ id: "new", modifiedRaw: 5 }),
      plan({ id: "mid", modifiedRaw: 100 }),
    ];
    const ranked = rankPlans("", plans).map((r) => r.plan.id);
    expect(ranked).toEqual(["new", "mid", "old"]);
  });

  it("filters out plans the scorer rejects", () => {
    const plans = [
      plan({ id: "match", title: "auth flow", path: "active/auth.md" }),
      plan({ id: "noop", title: "totally unrelated", path: "x/y.md" }),
    ];
    const ranked = rankPlans("auth", plans).map((r) => r.plan.id);
    expect(ranked).toEqual(["match"]);
  });

  it("orders matches by descending score", () => {
    const plans = [
      plan({ id: "weak", title: "Pre Auth", path: "x/y.md" }),
      plan({ id: "strong", title: "Auth flow", path: "x/y.md" }),
    ];
    const ranked = rankPlans("auth", plans).map((r) => r.plan.id);
    expect(ranked[0]).toBe("strong");
  });

  it("breaks score ties by modifiedRaw", () => {
    const plans = [
      plan({ id: "old-tie", title: "Auth", path: "x/y.md", modifiedRaw: 5000 }),
      plan({ id: "new-tie", title: "Auth", path: "x/y.md", modifiedRaw: 50 }),
    ];
    const ranked = rankPlans("auth", plans).map((r) => r.plan.id);
    expect(ranked[0]).toBe("new-tie");
  });

  it("returns title and path highlight spans", () => {
    const ranked = rankPlans("auth", [
      plan({ title: "Other", path: "active/auth-flow.md" }),
    ]);
    expect(ranked[0]?.titleSpans).toEqual([]);
    expect(ranked[0]?.pathSpans).toEqual([{ start: 7, end: 11 }]);
  });
});
