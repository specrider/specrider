import { comparePlanRecency } from "../plans/sort";
import type { Plan } from "../types";
import { type MatchSpan, scoreMatch } from "./score";

const DEFAULT_RESULT_LIMIT = 30;
const DEFAULT_EMPTY_QUERY_LIMIT = 20;

export interface RankedPlan {
  plan: Plan;
  score: number;
  titleSpans: { start: number; end: number }[];
  pathSpans: { start: number; end: number }[];
}

interface RankPlansOptions {
  limit?: number;
  emptyQueryLimit?: number;
}

export function rankPlans(
  query: string,
  plans: Plan[],
  options: RankPlansOptions = {},
): RankedPlan[] {
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
  const emptyQueryLimit = options.emptyQueryLimit ?? DEFAULT_EMPTY_QUERY_LIMIT;

  if (!query) {
    return plans
      .slice()
      .sort(comparePlanRecency)
      .slice(0, emptyQueryLimit)
      .map((plan) => ({ plan, score: 0, titleSpans: [], pathSpans: [] }));
  }

  const out: RankedPlan[] = [];
  for (const plan of plans) {
    const m = scoreMatch(query, plan.title, plan.path);
    if (!m) continue;
    out.push({
      plan,
      score: m.score,
      titleSpans: spansFor(m.spans, "title"),
      pathSpans: spansFor(m.spans, "path"),
    });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return comparePlanRecency(a.plan, b.plan);
  });
  return out.slice(0, limit);
}

function spansFor(
  spans: MatchSpan[],
  field: "title" | "path",
): { start: number; end: number }[] {
  return spans
    .filter((s) => s.field === field)
    .map(({ start, end }) => ({ start, end }));
}
