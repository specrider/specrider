/**
 * Decides whether the debounced save effect should write the current
 * rawMd buffer to disk.
 *
 * The save effect inside App.tsx wires the live state into this
 * function. Extracted as a pure helper so the data-loss invariants
 * have unit tests independent of React's effect machinery — a
 * regression here is what overwrites a real document with a stale
 * buffer from a different plan.
 *
 * Returns the snapshot to write when the save should proceed, or
 * `null` when any guard trips and the save must be skipped.
 *
 * Guards (each line is a load-bearing safety check):
 *
 * 1. `skipNextSave` — set by the plan-switch effect and the watcher's
 *    rebind path so the save tick that fires immediately after a
 *    rawMd swap doesn't write the just-loaded content right back.
 *
 * 2. No active plan — nothing to save against.
 *
 * 3. **Owner mismatch** — `rawMdOwner` is the path of the plan whose
 *    content `rawMd` currently holds. Must equal the active plan's
 *    path. A mismatch means we're mid-switch (owner cleared) or the
 *    rawMd hasn't been refreshed yet (owner stale); either way,
 *    writing now corrupts the wrong file.
 *
 * 4. **Debounce mismatch** — the 800ms-debounced snapshot of rawMd
 *    must equal the *current* rawMd. A stale debounce can fire after
 *    a plan switch has re-established ownership, carrying the prior
 *    plan's content under the new plan's path. The owner check alone
 *    can't catch this because the owner ref moves with rawMd, not
 *    with the lagging debounced value.
 *
 * 5. No-op write — content unchanged from the last successful write.
 */
export function decideSaveSnapshot(args: {
  skipNextSave: boolean;
  activePlanPath: string | null;
  rawMdOwner: string;
  rawMd: string;
  debouncedSaveSource: string;
  lastSaved: string;
}): string | null {
  if (args.skipNextSave) return null;
  if (!args.activePlanPath) return null;
  if (args.rawMdOwner !== args.activePlanPath) return null;
  if (args.debouncedSaveSource !== args.rawMd) return null;
  if (args.rawMd === args.lastSaved) return null;
  return args.rawMd;
}
