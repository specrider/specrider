import type { Plan } from "../types";

export function comparePlanRecency(
  a: Pick<Plan, "modifiedRaw">,
  b: Pick<Plan, "modifiedRaw">,
): number {
  if (a.modifiedRaw === b.modifiedRaw) return 0;
  return a.modifiedRaw < b.modifiedRaw ? -1 : 1;
}
