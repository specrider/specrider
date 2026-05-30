// Filter prefix parsing for the QuickSwitch palette.
//
// Recognized tokens (case-insensitive prefix, value is consumed up to
// the next whitespace):
//   tag:<value>        — frontmatter tags includes <value>
//   #<value>           — alias for tag:
//   @<value>           — owner OR contributors includes <value>
//   assignee:<value>   — alias for @
//   owner:<value>      — strict owner match
//   bucket:<value>     — folder bucket (active / upcoming / backlog / archive / …)
//
// Multiple filters AND together. Anything that isn't a recognized
// filter token becomes free-text (passed to the existing fuzzy
// scorer for title/path match).
//
// The parser is forgiving of partial tokens — a trailing `tag:` with
// no value is reported as `tokenInProgress` so the autocomplete UI
// can show suggestions while the user is typing.

import type { Plan } from "../types";

export type FilterKind = "tag" | "owner" | "assignee" | "bucket";

export interface ParsedFilter {
  kind: FilterKind;
  value: string;
  /** Position of the filter token in the original query — used for
   *  rendering chips inline / underlining the substring. */
  tokenStart: number;
  tokenEnd: number;
}

/** A filter the user has *started* typing but not yet completed
 *  (no value, or the cursor is inside the value). The autocomplete
 *  UI keys off this. */
export interface InProgressFilter {
  kind: FilterKind;
  /** Whatever the user has typed so far for the value (may be ""). */
  partial: string;
  tokenStart: number;
  tokenEnd: number;
}

export interface ParsedQuery {
  filters: ParsedFilter[];
  freeText: string;
  /** When non-null, the filter token at the cursor position is still
   *  being typed. Drives the autocomplete dropdown. The cursor
   *  argument to `parseQuery` controls whether this fires. */
  inProgress: InProgressFilter | null;
}

const FILTER_PREFIXES: Array<{ kind: FilterKind; literal: string }> = [
  { kind: "tag", literal: "tag:" },
  { kind: "owner", literal: "owner:" },
  { kind: "assignee", literal: "assignee:" },
  { kind: "bucket", literal: "bucket:" },
];

/** Find the next filter token starting at `start` in `query`. Returns
 *  null when no more tokens remain. */
function consumeToken(
  query: string,
  start: number,
): {
  kind: FilterKind | null;
  value: string;
  tokenStart: number;
  tokenEnd: number;
} | null {
  // Skip leading whitespace.
  let i = start;
  while (i < query.length && /\s/.test(query[i])) i++;
  if (i >= query.length) return null;
  const tokenStart = i;

  // `#tag` alias — treat anything after # up to whitespace as a tag.
  if (query[i] === "#") {
    let j = i + 1;
    while (j < query.length && !/\s/.test(query[j])) j++;
    return {
      kind: "tag",
      value: query.slice(i + 1, j),
      tokenStart,
      tokenEnd: j,
    };
  }
  // `@name` alias — assignee.
  if (query[i] === "@") {
    let j = i + 1;
    while (j < query.length && !/\s/.test(query[j])) j++;
    return {
      kind: "assignee",
      value: query.slice(i + 1, j),
      tokenStart,
      tokenEnd: j,
    };
  }
  // `tag:` / `owner:` / `assignee:` / `bucket:` (case-insensitive).
  const lower = query.slice(i).toLowerCase();
  for (const p of FILTER_PREFIXES) {
    if (lower.startsWith(p.literal)) {
      let j = i + p.literal.length;
      while (j < query.length && !/\s/.test(query[j])) j++;
      return {
        kind: p.kind,
        value: query.slice(i + p.literal.length, j),
        tokenStart,
        tokenEnd: j,
      };
    }
  }
  // Free text — consume up to next whitespace; caller treats the
  // span as part of the freeText string.
  let j = i;
  while (j < query.length && !/\s/.test(query[j])) j++;
  return { kind: null, value: query.slice(i, j), tokenStart, tokenEnd: j };
}

/** Parses the full query into `{ filters, freeText, inProgress }`.
 *
 *  When `cursor` is provided and falls inside a filter token, that
 *  token is reported as `inProgress` (and excluded from `filters`)
 *  so the autocomplete UI doesn't try to match against half-typed
 *  values. Pass `cursor = query.length` (or omit) to treat every
 *  filter as committed. */
export function parseQuery(query: string, cursor?: number): ParsedQuery {
  const filters: ParsedFilter[] = [];
  const freeTextParts: string[] = [];
  let inProgress: InProgressFilter | null = null;
  const cur = cursor ?? query.length;
  let pos = 0;
  while (pos < query.length) {
    const tok = consumeToken(query, pos);
    if (!tok) break;
    const cursorInsideToken = cur > tok.tokenStart && cur <= tok.tokenEnd;
    if (tok.kind === null) {
      freeTextParts.push(tok.value);
    } else if (cursorInsideToken) {
      inProgress = {
        kind: tok.kind,
        partial: tok.value,
        tokenStart: tok.tokenStart,
        tokenEnd: tok.tokenEnd,
      };
    } else {
      // Filters with empty value act like free text — the user
      // typed `tag:` and committed (cursor moved past). Treat as
      // not-yet-meaningful so we don't filter to nothing.
      if (tok.value.length > 0) {
        filters.push({
          kind: tok.kind,
          value: tok.value,
          tokenStart: tok.tokenStart,
          tokenEnd: tok.tokenEnd,
        });
      }
    }
    pos = tok.tokenEnd;
  }
  return {
    filters,
    freeText: freeTextParts.join(" ").trim(),
    inProgress,
  };
}

/** Apply filters to a plan list (AND across filters). Free text is
 *  intentionally NOT applied here — `rankPlans` in QuickSwitch keeps
 *  ownership of fuzzy matching so highlight spans stay accurate. */
export function applyFilters(plans: Plan[], filters: ParsedFilter[]): Plan[] {
  if (filters.length === 0) return plans;
  return plans.filter((p) => filters.every((f) => matchPlan(p, f)));
}

function matchPlan(plan: Plan, filter: ParsedFilter): boolean {
  const v = filter.value.toLowerCase();
  switch (filter.kind) {
    case "tag":
      return plan.tags.some((t) => t.toLowerCase() === v);
    case "owner":
      return plan.owner.toLowerCase() === v;
    case "assignee":
      return (
        plan.owner.toLowerCase() === v ||
        plan.contributors.some((c) => c.toLowerCase() === v)
      );
    case "bucket":
      return plan.bucket.toLowerCase() === v;
  }
}

/** Distinct values across the workspace for a given filter kind —
 *  drives the autocomplete suggestion list. Sorted by frequency
 *  descending then alphabetical. */
export function suggestValues(
  plans: Plan[],
  kind: FilterKind,
  partial: string,
): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  const note = (raw: string) => {
    const key = raw.trim();
    if (!key) return;
    const k = key.toLowerCase();
    const existing = counts.get(k);
    if (existing) existing.count++;
    else counts.set(k, { label: key, count: 1 });
  };
  for (const p of plans) {
    if (kind === "tag") {
      for (const t of p.tags) note(t);
    } else if (kind === "owner") {
      if (p.owner) note(p.owner);
    } else if (kind === "assignee") {
      if (p.owner) note(p.owner);
      for (const c of p.contributors) note(c);
    } else if (kind === "bucket") {
      if (p.bucket) note(p.bucket);
    }
  }
  const lower = partial.toLowerCase();
  const filtered: Array<{ label: string; count: number }> = [];
  for (const v of counts.values()) {
    if (!lower || v.label.toLowerCase().includes(lower)) {
      filtered.push(v);
    }
  }
  filtered.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
  return filtered.map((v) => v.label);
}
