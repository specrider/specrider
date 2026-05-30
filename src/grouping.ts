// Pure section-builders for the docs-pane grouping toggle.
//
// Each builder takes the same `Plan[]` and returns a flat list of
// Sections — `{ id, label, count, plans, archivedCount, archivedPlans }`.
// `groupByFiles` isn't here because the existing tree renderer in
// DocumentBrowser is a different shape; the toggle branches on mode
// at the render level.

import { comparePlanRecency } from "./plans/sort";
import type { Plan } from "./types";

export type GroupingMode = "files" | "tags" | "assignees";

export interface Section {
  /** Stable key for React reconciliation. Includes a prefix so tag
   *  vs assignee sections never collide. */
  id: string;
  /** Display name. Lower-cased tag names render as-is. */
  label: string;
  /** Visible plan count (excludes hidden archive plans). */
  count: number;
  /** Hidden archive plans for this section. 0 in Files mode and
   *  whenever the global "show archived" setting is on. */
  archivedCount: number;
  plans: Plan[];
  archivedPlans: Plan[];
}

/** Sort sections alphabetically (case-insensitive) with the catch-all
 *  pinned to the end. The catch-all id is `"untagged"` for tags and
 *  `"unassigned"` for assignees — both share the suffix `:__catchall`
 *  so the sort can find them generically. */
function sortSections(sections: Section[]): Section[] {
  return sections.sort((a, b) => {
    const aCatch = a.id.endsWith(":__catchall");
    const bCatch = b.id.endsWith(":__catchall");
    if (aCatch !== bCatch) return aCatch ? 1 : -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

/** Sort plans inside a section by most-recent-modified first. */
function sortByMtime(plans: Plan[]): Plan[] {
  return plans.sort(comparePlanRecency);
}

/** Split a section's plans into visible vs. archived based on the
 *  caller's "show archived by default" preference. When the
 *  preference is on, archive plans are returned in `plans` (visible)
 *  and `archivedPlans` is empty — the caller can still choose to
 *  collapse the section but won't render the dedicated archived pill. */
function splitArchive(
  plans: Plan[],
  showArchivedByDefault: boolean,
): { visible: Plan[]; archived: Plan[] } {
  if (showArchivedByDefault) {
    return { visible: sortByMtime(plans), archived: [] };
  }
  const visible: Plan[] = [];
  const archived: Plan[] = [];
  for (const p of plans) {
    if (p.bucket === "archive") archived.push(p);
    else visible.push(p);
  }
  return { visible: sortByMtime(visible), archived: sortByMtime(archived) };
}

/** Normalize a tag for grouping: trim + lowercase. The first-seen
 *  casing is preserved as the section label (so a corpus that uses
 *  `Git` once and `git` ten times still labels the section `Git`
 *  cleanly — but the user's typing is consistently grouped). */
function tagKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Group plans by frontmatter `tags`. A plan with multiple tags
 *  appears under each. Plans with no tags land in an `untagged`
 *  catch-all section pinned to the end. */
export function groupByTags(
  plans: Plan[],
  options: { showArchivedByDefault?: boolean } = {},
): Section[] {
  const showArchived = options.showArchivedByDefault ?? false;
  const buckets = new Map<string, { label: string; plans: Plan[] }>();
  const untagged: Plan[] = [];
  for (const p of plans) {
    const tags = p.tags.map((t) => t.trim()).filter((t) => t.length > 0);
    if (tags.length === 0) {
      untagged.push(p);
      continue;
    }
    const seen = new Set<string>();
    for (const raw of tags) {
      const key = tagKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = buckets.get(key);
      if (existing) {
        existing.plans.push(p);
      } else {
        buckets.set(key, { label: raw, plans: [p] });
      }
    }
  }
  const sections: Section[] = [];
  for (const [key, { label, plans: members }] of buckets) {
    const { visible, archived } = splitArchive(members, showArchived);
    // Drop sections with no visible AND no archived plans. This can
    // happen when every plan in a tag bucket was filtered out (e.g.
    // archive-only tags before the archived-pill UI is wired). Empty
    // sections look like a bug.
    if (visible.length === 0 && archived.length === 0) continue;
    sections.push({
      id: `tag:${key}`,
      label,
      count: visible.length,
      archivedCount: archived.length,
      plans: visible,
      archivedPlans: archived,
    });
  }
  if (untagged.length > 0) {
    const { visible, archived } = splitArchive(untagged, showArchived);
    if (visible.length > 0 || archived.length > 0) {
      sections.push({
        id: "tag:__catchall",
        label: "untagged",
        count: visible.length,
        archivedCount: archived.length,
        plans: visible,
        archivedPlans: archived,
      });
    }
  }
  return sortSections(sections);
}

/** Group plans by `owner` first, then by every entry in
 *  `contributors`. A plan owned by `jake` with contributor `alex`
 *  appears under both. Plans with empty owner AND contributors land
 *  in an `unassigned` catch-all section pinned to the end. */
export function groupByAssignees(
  plans: Plan[],
  options: { showArchivedByDefault?: boolean } = {},
): Section[] {
  const showArchived = options.showArchivedByDefault ?? false;
  const buckets = new Map<string, { label: string; plans: Plan[] }>();
  const unassigned: Plan[] = [];
  for (const p of plans) {
    const owner = (p.owner ?? "").trim();
    const contributors = (p.contributors ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const all = new Set<string>();
    if (owner) all.add(owner);
    for (const c of contributors) all.add(c);
    if (all.size === 0) {
      unassigned.push(p);
      continue;
    }
    for (const name of all) {
      const key = name.toLowerCase();
      const existing = buckets.get(key);
      if (existing) {
        existing.plans.push(p);
      } else {
        buckets.set(key, { label: name, plans: [p] });
      }
    }
  }
  const sections: Section[] = [];
  for (const [key, { label, plans: members }] of buckets) {
    const { visible, archived } = splitArchive(members, showArchived);
    if (visible.length === 0 && archived.length === 0) continue;
    sections.push({
      id: `assignee:${key}`,
      label,
      count: visible.length,
      archivedCount: archived.length,
      plans: visible,
      archivedPlans: archived,
    });
  }
  if (unassigned.length > 0) {
    const { visible, archived } = splitArchive(unassigned, showArchived);
    if (visible.length > 0 || archived.length > 0) {
      sections.push({
        id: "assignee:__catchall",
        label: "unassigned",
        count: visible.length,
        archivedCount: archived.length,
        plans: visible,
        archivedPlans: archived,
      });
    }
  }
  return sortSections(sections);
}
