// Lane-assignment for the commit history rail.
//
// Pure function (no React, no Tauri) — given a list of commits in
// display order (newest → oldest, parents follow children), return
// per-row lane data the rail uses to render the lane glyph column.
//
// Algorithm: classic "active lanes" git-graph layout. Walk commits in
// order and maintain a `lanes` array where each slot is the SHA the
// lane is currently expecting to draw next (i.e. the next child of
// that lane). For each commit:
//   1. Lanes whose expected SHA equals this commit's SHA "claim" it.
//   2. The leftmost claiming lane (or a fresh slot if none) becomes
//      the dot lane. Other claimers free their slot — those are merges
//      converging into the dot lane.
//   3. The dot lane's expected SHA flips to the commit's first parent.
//      Additional parents allocate new lane slots (re-using freed slots
//      where possible).
//
// References: gitk, Tig, git-graph (Rust), `gitgraph.js`. Standard
// algorithm; the per-row outputs are simple enough that the renderer
// can draw single-row glyphs (dot + vertical lines) without needing
// inter-row connector rows.

export interface GraphCommitLite {
  sha: string;
  parents: string[];
}

export interface LaneAssignment {
  /** 0-based column where this commit's dot sits. */
  laneIndex: number;
  /** Lanes active just BEFORE this commit. `null` slots are free. */
  priorLanes: ReadonlyArray<string | null>;
  /** Lanes active just AFTER this commit. */
  nextLanes: ReadonlyArray<string | null>;
  /** Lane indices that were claiming this commit but aren't the dot
   *  lane — they collapse into `laneIndex` (incoming merge edges). */
  mergedLanes: number[];
  /** True iff this commit has 2+ parents (multi-parent merge). */
  isMerge: boolean;
}

export interface GraphLayout {
  rows: LaneAssignment[];
  /** Maximum lane index actually used across the entire layout —
   *  the renderer sizes the lane column to this so all rows align. */
  laneCount: number;
}

function firstNullIndex(lanes: Array<string | null>): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === null) return i;
  }
  return -1;
}

function trimTrailingNulls(lanes: Array<string | null>): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
    lanes.pop();
  }
}

export function assignLanes(commits: GraphCommitLite[]): GraphLayout {
  const lanes: Array<string | null> = [];
  const rows: LaneAssignment[] = [];
  let laneCount = 0;

  for (const c of commits) {
    // 1. Lanes already expecting this commit (the column its child(ren)
    //    pre-allocated for it).
    const claiming: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === c.sha) claiming.push(i);
    }

    // 2. Pick the dot lane. Leftmost claimer wins; otherwise allocate.
    let dotLane: number;
    if (claiming.length > 0) {
      dotLane = claiming[0];
    } else {
      const free = firstNullIndex(lanes);
      if (free >= 0) {
        dotLane = free;
      } else {
        dotLane = lanes.length;
        lanes.push(null);
      }
    }

    // 3. Snapshot priorLanes BEFORE mutation. These drive the upper
    //    half of the row's connector visualization.
    const priorLanes: Array<string | null> = lanes.slice();

    // 4. Free non-dot claiming lanes (merges converging in).
    const mergedLanes: number[] = [];
    for (const i of claiming) {
      if (i !== dotLane) {
        lanes[i] = null;
        mergedLanes.push(i);
      }
    }

    // 5. Flip dot lane's expected SHA to the first parent (or null).
    if (c.parents.length === 0) {
      lanes[dotLane] = null;
    } else {
      lanes[dotLane] = c.parents[0];
      // Additional parents allocate new lanes (or reuse freed ones,
      // or merge into a lane that's already expecting that SHA).
      for (let pi = 1; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        if (lanes.includes(p)) continue;
        const free = firstNullIndex(lanes);
        if (free >= 0) {
          lanes[free] = p;
        } else {
          lanes.push(p);
        }
      }
    }

    // 6. Trim trailing null slots so width stays bounded.
    trimTrailingNulls(lanes);

    const nextLanes: Array<string | null> = lanes.slice();

    rows.push({
      laneIndex: dotLane,
      priorLanes,
      nextLanes,
      mergedLanes,
      isMerge: c.parents.length > 1,
    });

    const widest = Math.max(priorLanes.length, nextLanes.length, dotLane + 1);
    if (widest > laneCount) laneCount = widest;
  }

  return { rows, laneCount };
}

/** Stable lane-index → CSS hue. The rail picks colors from this so
 *  lane 0 is always the same teal regardless of which commit owns it
 *  this session. Capped at 8 distinct hues; lane 8+ wraps. */
export const LANE_HUES: readonly number[] = [
  205, // teal
  18, // orange
  140, // green
  280, // purple
  340, // pink
  45, // amber
  220, // blue
  100, // lime
];

export function laneColor(laneIndex: number): string {
  const hue = LANE_HUES[laneIndex % LANE_HUES.length];
  return `hsl(${hue}, 55%, 48%)`;
}
