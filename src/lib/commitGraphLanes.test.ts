import { describe, expect, it } from "vitest";
import { assignLanes, type GraphCommitLite } from "./commitGraphLanes";

// Tiny helper so fixtures read like `[sha, parents]` tuples instead of
// object literals. Commit order is newest → oldest (display order),
// matching how the rail receives them.
function commits(
  spec: ReadonlyArray<readonly [string, readonly string[]]>,
): GraphCommitLite[] {
  return spec.map(([sha, parents]) => ({ sha, parents: [...parents] }));
}

describe("assignLanes", () => {
  it("returns an empty layout for no commits", () => {
    expect(assignLanes([])).toEqual({ rows: [], laneCount: 0 });
  });

  it("places a single rootless commit on lane 0 and frees the slot", () => {
    const layout = assignLanes(commits([["A", []]]));
    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0]).toMatchObject({
      laneIndex: 0,
      mergedLanes: [],
      isMerge: false,
      nextLanes: [],
    });
    expect(layout.laneCount).toBe(1);
  });

  it("keeps a linear history on lane 0", () => {
    const layout = assignLanes(
      commits([
        ["C", ["B"]],
        ["B", ["A"]],
        ["A", []],
      ]),
    );
    expect(layout.rows.map((r) => r.laneIndex)).toEqual([0, 0, 0]);
    expect(layout.laneCount).toBe(1);
    // Final commit (root) frees its lane.
    expect(layout.rows[2].nextLanes).toEqual([]);
  });

  it("handles a 2-parent merge", () => {
    // M is a merge of A and B; both parents are rootless.
    const layout = assignLanes(
      commits([
        ["M", ["A", "B"]],
        ["B", []],
        ["A", []],
      ]),
    );
    expect(layout.rows[0]).toMatchObject({ laneIndex: 0, isMerge: true });
    // After M, lane 0 expects A and lane 1 expects B.
    expect(layout.rows[0].nextLanes).toEqual(["A", "B"]);
    // B is on the lane allocated for it (lane 1)…
    expect(layout.rows[1].laneIndex).toBe(1);
    // …and A finishes on lane 0.
    expect(layout.rows[2].laneIndex).toBe(0);
    expect(layout.laneCount).toBe(2);
  });

  it("handles an octopus merge (3 parents)", () => {
    const layout = assignLanes(
      commits([
        ["M", ["A", "B", "C"]],
        ["C", []],
        ["B", []],
        ["A", []],
      ]),
    );
    expect(layout.rows[0]).toMatchObject({ laneIndex: 0, isMerge: true });
    expect(layout.rows[0].nextLanes).toEqual(["A", "B", "C"]);
    expect(layout.laneCount).toBe(3);
  });

  it("collapses incoming branches into the dot lane on a merge", () => {
    // Diamond: D forks into B and C, M merges them.
    //   M ── parents B, C
    //   B ── parent  D
    //   C ── parent  D
    //   D ── root
    const layout = assignLanes(
      commits([
        ["M", ["B", "C"]],
        ["B", ["D"]],
        ["C", ["D"]],
        ["D", []],
      ]),
    );
    // M sits on lane 0; lane 1 gets allocated for the C side.
    expect(layout.rows[0]).toMatchObject({ laneIndex: 0, isMerge: true });
    expect(layout.rows[0].nextLanes).toEqual(["B", "C"]);
    expect(layout.rows[1]).toMatchObject({ laneIndex: 0 }); // B
    expect(layout.rows[2]).toMatchObject({ laneIndex: 1 }); // C
    // D is the merge point of both lanes — second claimer collapses
    // into the dot lane.
    expect(layout.rows[3]).toMatchObject({ laneIndex: 0, mergedLanes: [1] });
    expect(layout.rows[3].nextLanes).toEqual([]);
    expect(layout.laneCount).toBe(2);
  });

  it("reuses freed lane slots before extending right", () => {
    // S forks into a side branch (B) that ends, then later a fresh
    // branch (X) appears. X should land in the freed slot, not lane 2.
    const layout = assignLanes(
      commits([
        ["X", []], // fresh rootless branch — first row
        ["S", ["A", "B"]], // splits into A and B
        ["B", []],
        ["A", []],
      ]),
    );
    // X claims lane 0 and frees it (no parents)…
    expect(layout.rows[0]).toMatchObject({ laneIndex: 0 });
    expect(layout.rows[0].nextLanes).toEqual([]);
    // …so S also lands on lane 0, and B allocates lane 1.
    expect(layout.rows[1]).toMatchObject({ laneIndex: 0, isMerge: true });
    expect(layout.rows[1].nextLanes).toEqual(["A", "B"]);
    expect(layout.laneCount).toBe(2);
  });

  it("counts laneCount as the peak width, not the final width", () => {
    // After the diamond fully collapses, the layout ends at width 1.
    // laneCount should still report 2 (the peak).
    const layout = assignLanes(
      commits([
        ["M", ["A", "B"]],
        ["B", ["A"]],
        ["A", []],
      ]),
    );
    expect(layout.laneCount).toBe(2);
    // Final row's nextLanes is empty — width 0 — yet laneCount stays 2.
    expect(layout.rows[layout.rows.length - 1].nextLanes).toEqual([]);
  });

  it("handles disconnected histories with two roots", () => {
    const layout = assignLanes(
      commits([
        ["A", []],
        ["B", []],
      ]),
    );
    // Both roots end up on lane 0 since A frees it before B arrives.
    expect(layout.rows[0]).toMatchObject({ laneIndex: 0, nextLanes: [] });
    expect(layout.rows[1]).toMatchObject({ laneIndex: 0, nextLanes: [] });
    expect(layout.laneCount).toBe(1);
  });

  it("places a sibling fork on a new lane while the parent's lane stays put", () => {
    // C and D both have parent P. C is the dot-lane child; D forks
    // off onto a new lane and only collapses when P appears.
    //   C ── parent P
    //   D ── parent P
    //   P ── root
    const layout = assignLanes(
      commits([
        ["C", ["P"]],
        ["D", ["P"]],
        ["P", []],
      ]),
    );
    expect(layout.rows[0].laneIndex).toBe(0);
    expect(layout.rows[0].nextLanes).toEqual(["P"]);
    // D doesn't share C's lane — it's a sibling commit, claims lane 1.
    expect(layout.rows[1].laneIndex).toBe(1);
    // After D, both lanes are still expecting P.
    expect(layout.rows[1].nextLanes).toEqual(["P", "P"]);
    // P collapses both into lane 0.
    expect(layout.rows[2]).toMatchObject({ laneIndex: 0, mergedLanes: [1] });
    expect(layout.rows[2].nextLanes).toEqual([]);
    expect(layout.laneCount).toBe(2);
  });

  it("snapshots priorLanes after lane allocation but before merge collapse", () => {
    const layout = assignLanes(
      commits([
        ["B", ["A"]],
        ["A", []],
      ]),
    );
    // priorLanes is captured after a freshly-allocated dot lane is
    // pushed onto the lanes array — so the first row sees one `null`
    // slot, not an empty list. Pin behavior so a renderer change
    // doesn't quietly desync.
    expect(layout.rows[0].priorLanes).toEqual([null]);
    expect(layout.rows[1].priorLanes).toEqual(["A"]);
  });
});
