import { describe, expect, it } from "vitest";
import {
  buildDiffReviewTabs,
  DOCS_REVIEW_TAB_ID,
  hasDiffReviewTab,
} from "./diffTabs";

describe("buildDiffReviewTabs", () => {
  it("returns only the docs tab when there are no linked repo links", () => {
    expect(buildDiffReviewTabs([])).toEqual([
      {
        id: DOCS_REVIEW_TAB_ID,
        kind: "docs",
        label: "docs",
        repoPath: null,
      },
    ]);
  });

  it("keeps docs leftmost and adds one linked tab per frontmatter link", () => {
    const tabs = buildDiffReviewTabs([
      { repo: "code", branch: "feature/x", base: "main" },
      { repo: "landing", branch: "feature/y", base: "release" },
    ]);

    expect(tabs.map((tab) => tab.label)).toEqual([
      "docs",
      "code @ feature/x",
      "landing @ feature/y",
    ]);
    expect(tabs[0].id).toBe(DOCS_REVIEW_TAB_ID);
    expect(tabs[1]).toMatchObject({
      kind: "linked",
      repo: "code",
      branch: "feature/x",
      base: "main",
    });
  });

  it("resolves linked repo paths for hover titles", () => {
    const tabs = buildDiffReviewTabs(
      [{ repo: "code", branch: "feature/x", base: "main" }],
      {
        plansRoot: "/Users/jake/Sites/specrider-plans",
        workspaceRepos: { code: "../specrider" },
      },
    );

    expect(tabs[0].repoPath).toBe("/Users/jake/Sites/specrider-plans");
    expect(tabs[1]).toMatchObject({
      kind: "linked",
      repoPath: "/Users/jake/Sites/specrider",
    });
  });

  it("gives duplicate links distinct ids so tabs stay addressable", () => {
    const tabs = buildDiffReviewTabs([
      { repo: "code", branch: "feature/x", base: "main" },
      { repo: "code", branch: "feature/x", base: "main" },
    ]);

    expect(tabs[1].id).not.toBe(tabs[2].id);
    expect(hasDiffReviewTab(tabs, tabs[1].id)).toBe(true);
    expect(hasDiffReviewTab(tabs, "linked:missing")).toBe(false);
  });
});
