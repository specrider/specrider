/**
 * Tiny in-house ranker for QuickSwitch (⌘T) and other small palettes.
 *
 * Tier-based — substring matches always rank above char-by-char fuzzy
 * so users get predictable results when they type a recognizable
 * fragment. Returns null when no tier matches at all.
 */

export interface MatchSpan {
  field: "title" | "path";
  /** Indices (start, end) into the field, in order. End is exclusive. */
  start: number;
  end: number;
}

export interface ScoredMatch {
  score: number;
  /** Spans suitable for rendering matched-char emphasis. */
  spans: MatchSpan[];
}

const TIER_TITLE_EXACT = 1000;
const TIER_TITLE_WORD = 700;
const TIER_PATH_EXACT = 400;
const TIER_FUZZY = 100;

export function scoreMatch(
  query: string,
  title: string,
  path: string,
): ScoredMatch | null {
  if (!query) {
    return { score: 0, spans: [] };
  }

  const q = query.toLowerCase();
  const t = title.toLowerCase();
  const p = path.toLowerCase();

  // Tier 1: substring in title
  const tIdx = t.indexOf(q);
  if (tIdx >= 0) {
    // Closer to the start = higher score.
    const proximity = Math.max(0, 50 - tIdx);
    return {
      score: TIER_TITLE_EXACT + proximity,
      spans: [{ field: "title", start: tIdx, end: tIdx + q.length }],
    };
  }

  // Tier 2: word-boundary substring in title (start of a word in slug)
  const wbIdx = wordBoundaryIndex(t, q);
  if (wbIdx >= 0) {
    return {
      score: TIER_TITLE_WORD + Math.max(0, 50 - wbIdx),
      spans: [{ field: "title", start: wbIdx, end: wbIdx + q.length }],
    };
  }

  // Tier 3: substring in path
  const pIdx = p.indexOf(q);
  if (pIdx >= 0) {
    return {
      score: TIER_PATH_EXACT + Math.max(0, 50 - pIdx),
      spans: [{ field: "path", start: pIdx, end: pIdx + q.length }],
    };
  }

  // Tier 4: char-by-char fuzzy across title (last resort)
  const fuzzy = fuzzyMatch(t, q);
  if (fuzzy) {
    return {
      score: TIER_FUZZY + fuzzy.bonus,
      spans: fuzzy.spans.map((s) => ({ field: "title", ...s })),
    };
  }

  return null;
}

/** First index where `needle` matches `haystack` aligned to a
 *  word-boundary character (start of string, or right after a non-
 *  alphanumeric like `-`/`_`/`/`/` `). */
function wordBoundaryIndex(haystack: string, needle: string): number {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}`, "i");
  const m = re.exec(haystack);
  if (!m) return -1;
  return m.index + m[1].length;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Char-by-char fuzzy match. Each query char must appear in the
 *  haystack in order; consecutive matches add a small bonus. */
function fuzzyMatch(
  haystack: string,
  query: string,
): { bonus: number; spans: { start: number; end: number }[] } | null {
  const spans: { start: number; end: number }[] = [];
  let bonus = 0;
  let qi = 0;
  let lastIdx = -2;
  let runStart = -1;

  for (let hi = 0; hi < haystack.length && qi < query.length; hi++) {
    if (haystack[hi] === query[qi]) {
      if (hi === lastIdx + 1) {
        bonus += 2;
        if (runStart < 0) runStart = hi - 1;
        spans[spans.length - 1] = { start: runStart, end: hi + 1 };
      } else {
        runStart = hi;
        spans.push({ start: hi, end: hi + 1 });
      }
      lastIdx = hi;
      qi++;
    } else if (haystack[hi] !== query[qi]) {
      runStart = -1;
    }
  }

  if (qi < query.length) return null;
  return { bonus, spans };
}

/** Helper for renderers — split a string by an ordered list of spans
 *  so callers can wrap the matched chars in <mark> without touching
 *  unmatched portions. Spans must be sorted, non-overlapping. */
export function splitByMatches(
  text: string,
  spans: { start: number; end: number }[],
): { text: string; matched: boolean }[] {
  if (spans.length === 0) return [{ text, matched: false }];
  const out: { text: string; matched: boolean }[] = [];
  let cur = 0;
  for (const s of spans) {
    if (s.start > cur)
      out.push({ text: text.slice(cur, s.start), matched: false });
    out.push({ text: text.slice(s.start, s.end), matched: true });
    cur = s.end;
  }
  if (cur < text.length) out.push({ text: text.slice(cur), matched: false });
  return out;
}
