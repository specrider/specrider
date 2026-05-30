import { describe, expect, it } from "vitest";
import { decideSaveSnapshot } from "./saveGuard";

// Default args representing "user has been editing plan A and we're
// about to save". Every test starts from this baseline and toggles
// the one field it cares about, so the failure mode being asserted
// is the only variable.
const STEADY_STATE = {
  skipNextSave: false,
  activePlanPath: "active/plan-a.md" as string | null,
  rawMdOwner: "active/plan-a.md",
  rawMd: "# Plan A\n\nedited body\n",
  debouncedSaveSource: "# Plan A\n\nedited body\n",
  lastSaved: "# Plan A\n\noriginal body\n",
};

describe("decideSaveSnapshot — happy path", () => {
  it("returns the rawMd snapshot when all guards pass", () => {
    expect(decideSaveSnapshot(STEADY_STATE)).toBe("# Plan A\n\nedited body\n");
  });
});

describe("decideSaveSnapshot — guards", () => {
  it("returns null when skipNextSave is set", () => {
    expect(
      decideSaveSnapshot({ ...STEADY_STATE, skipNextSave: true }),
    ).toBeNull();
  });

  it("returns null when there is no active plan", () => {
    expect(
      decideSaveSnapshot({ ...STEADY_STATE, activePlanPath: null }),
    ).toBeNull();
  });

  it("returns null when the rawMd owner doesn't match the active plan", () => {
    // Plan-switch is in flight: ownership has been cleared but rawMd
    // still holds the prior plan's edited buffer. Writing here would
    // overwrite the new plan with the old plan's content.
    expect(decideSaveSnapshot({ ...STEADY_STATE, rawMdOwner: "" })).toBeNull();
  });

  it("returns null when the rawMd owner is a stale path", () => {
    expect(
      decideSaveSnapshot({
        ...STEADY_STATE,
        rawMdOwner: "active/plan-a.md",
        activePlanPath: "active/plan-b.md",
      }),
    ).toBeNull();
  });

  it("returns null when content is unchanged from last save", () => {
    expect(
      decideSaveSnapshot({
        ...STEADY_STATE,
        rawMd: STEADY_STATE.lastSaved,
        debouncedSaveSource: STEADY_STATE.lastSaved,
      }),
    ).toBeNull();
  });
});

describe("decideSaveSnapshot — stale-debounce race", () => {
  // The user-reported scenario reduced to its essentials.
  //
  // Sequence in the live app:
  //   1. User types in plan A → rawMd = "A edited"; debounce schedules
  //      an 800ms timer with that value.
  //   2. User clicks plan B before the timer fires.
  //   3. Plan-switch effect clears rawMdOwner, starts readPlan(B).
  //   4. readPlan(B) resolves → rawMdOwner = "B path",
  //      rawMd = "B content".
  //   5. The OLD timer fires (race): debouncedSaveSource =
  //      "A edited" — the stale value from step 1.
  //   6. Save effect runs. The owner check passes (B === B). Without
  //      the debounce-vs-rawMd check, the save would write
  //      "A edited" under plan B's path, completely erasing it.
  //
  // The guard MUST refuse this write.
  it("refuses to save when debouncedSaveSource is a stale prior-plan snapshot", () => {
    const result = decideSaveSnapshot({
      skipNextSave: false,
      activePlanPath: "active/plan-b.md",
      rawMdOwner: "active/plan-b.md",
      rawMd: "# Plan B\n\nlots of important content\n",
      debouncedSaveSource: "# Plan A\n\nstale prior-plan content\n",
      lastSaved: "# Plan B\n\nlots of important content\n",
    });
    expect(result).toBeNull();
  });

  // Once the debounce catches up to the new plan's rawMd, the save is
  // allowed to proceed (assuming the content actually diverged from
  // last-saved).
  it("allows the save once debounce has caught up to the active rawMd", () => {
    const result = decideSaveSnapshot({
      skipNextSave: false,
      activePlanPath: "active/plan-b.md",
      rawMdOwner: "active/plan-b.md",
      rawMd: "# Plan B\n\nedited B body\n",
      debouncedSaveSource: "# Plan B\n\nedited B body\n",
      lastSaved: "# Plan B\n\noriginal B body\n",
    });
    expect(result).toBe("# Plan B\n\nedited B body\n");
  });
});
