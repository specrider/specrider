import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/icons";
import { useDebounced } from "../hooks/useDebounced";
import { scrollBehavior } from "../lib/motion";

interface FindInDocProps {
  open: boolean;
  /** Container whose text content gets searched. Usually `.document`. */
  scopeRef: React.RefObject<HTMLElement | null>;
  /** Scroll container — used to scroll the active match into view. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Bumped by the parent whenever the underlying doc text changes
   *  (e.g. plan switch, save). Triggers a re-scan. */
  scanKey: unknown;
  /** Optional seed query — when set, the bar opens with the input
   *  pre-filled (used by the project-search "land on this hit" flow). */
  initialQuery?: string;
  /** Input placeholder + aria-label. Defaults to "Find in document". */
  placeholder?: string;
  /** Highlight slot suffix — append to namespace `::highlight()` slots
   *  per pane so two find bars (e.g. Reader + diff explorer) can both
   *  be open without trampling each other's painted matches. The
   *  matching `::highlight(mk-find-<suffix>)` rule must exist in CSS;
   *  unknown slots silently no-op. */
  highlightSlot?: string;
  onClose: () => void;
}

/** Browser-style find bar for Read mode. Uses the CSS Custom Highlight
 *  API so we never mutate the document DOM — `Highlight` objects are
 *  layered on top of existing text via `::highlight(...)` styles. */
export function FindInDoc({
  open,
  scopeRef,
  scrollRef,
  scanKey,
  initialQuery,
  placeholder = "Find in document",
  highlightSlot,
  onClose,
}: FindInDocProps) {
  const ALL_HIGHLIGHT = highlightSlot ? `mk-find-${highlightSlot}` : "mk-find";
  const CURRENT_HIGHLIGHT = highlightSlot
    ? `mk-find-${highlightSlot}-current`
    : "mk-find-current";
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matchesRef = useRef<Range[]>([]);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const supportsHighlightAPI = useMemo(supportsCustomHighlights, []);

  const clearHighlights = useCallback(() => {
    if (!supportsHighlightAPI) return;
    CSS.highlights.delete(ALL_HIGHLIGHT);
    CSS.highlights.delete(CURRENT_HIGHLIGHT);
  }, [ALL_HIGHLIGHT, CURRENT_HIGHLIGHT, supportsHighlightAPI]);

  const paintHighlights = useCallback(
    (currentIdx: number) => {
      if (!supportsHighlightAPI) return;
      clearHighlights();
      const ranges = matchesRef.current;
      if (ranges.length === 0) return;
      // All matches -> faint fill.
      const all = new Highlight(...ranges.filter((_, i) => i !== currentIdx));
      CSS.highlights.set(ALL_HIGHLIGHT, all);
      // Current match -> solid fill.
      const cur = ranges[currentIdx];
      if (cur) {
        CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(cur));
        scrollIntoView(cur, scrollRef.current);
      }
    },
    [
      ALL_HIGHLIGHT,
      CURRENT_HIGHLIGHT,
      clearHighlights,
      scrollRef,
      supportsHighlightAPI,
    ],
  );

  // Re-scan whenever the query, the scope, or the doc changes.
  const debouncedQuery = useDebounced(query, 60);
  const rescan = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    matchesRef.current = debouncedQuery
      ? findRanges(scope, debouncedQuery)
      : [];
    setMatchCount(matchesRef.current.length);
    setActiveIdx(0);
    paintHighlights(0);
  }, [debouncedQuery, paintHighlights, scopeRef]);

  // Open/close lifecycle: focus input, restore focus on close, clear
  // highlights on close. When `initialQuery` is provided, seed the
  // input on open so the project-search → in-doc-find handoff lands
  // pre-filled.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      if (initialQuery !== undefined) {
        setQuery(initialQuery);
      }
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else {
      clearHighlights();
      setMatchCount(0);
      setActiveIdx(0);
      matchesRef.current = [];
      lastFocusedRef.current?.focus?.();
      lastFocusedRef.current = null;
    }
  }, [open, initialQuery, clearHighlights]);

  useEffect(() => {
    void scanKey;
    if (!open) return;
    rescan();
  }, [open, rescan, scanKey]);

  if (!open) return null;

  function step(delta: number) {
    if (matchesRef.current.length === 0) return;
    const next =
      (activeIdx + delta + matchesRef.current.length) %
      matchesRef.current.length;
    setActiveIdx(next);
    paintHighlights(next);
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return;
    }
  };

  return (
    <search className="find-bar" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={placeholder}
        spellCheck={false}
      />
      <span className="find-count" aria-live="polite">
        {matchCount === 0
          ? query
            ? "0 / 0"
            : ""
          : `${activeIdx + 1} / ${matchCount}`}
      </span>
      <button
        type="button"
        className="find-btn"
        onClick={() => step(-1)}
        aria-label="Previous match"
        title="Previous (⇧Enter)"
        disabled={matchCount === 0}
      >
        <Icon.ChevronL />
      </button>
      <button
        type="button"
        className="find-btn"
        onClick={() => step(1)}
        aria-label="Next match"
        title="Next (Enter)"
        disabled={matchCount === 0}
      >
        <Icon.ChevronR />
      </button>
      <button
        type="button"
        className="find-btn"
        onClick={onClose}
        aria-label="Close find bar"
        title="Close (Esc)"
      >
        ×
      </button>
    </search>
  );
}

/** Returns Range objects for every case-insensitive match of `query`
 *  in the visible text under `scope`. Uses TreeWalker over text nodes
 *  so it handles split text across multiple inline elements. */
function findRanges(scope: HTMLElement, query: string): Range[] {
  const out: Range[] = [];
  const q = query.toLowerCase();
  if (!q) return out;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      // Skip text inside script/style/code-language chips.
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n = walker.nextNode();
  while (n) {
    const text = n.nodeValue ?? "";
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    while (idx !== -1) {
      const r = document.createRange();
      r.setStart(n, idx);
      r.setEnd(n, idx + q.length);
      out.push(r);
      idx = lower.indexOf(q, idx + q.length);
    }
    n = walker.nextNode();
  }
  return out;
}

function scrollIntoView(range: Range, scrollContainer: HTMLElement | null) {
  const rect = range.getBoundingClientRect();
  if (!scrollContainer) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  // Only scroll if the match isn't already comfortably visible.
  if (
    rect.top < containerRect.top + 60 ||
    rect.bottom > containerRect.bottom - 60
  ) {
    const target =
      scrollContainer.scrollTop +
      (rect.top - containerRect.top) -
      containerRect.height / 2 +
      rect.height / 2;
    scrollContainer.scrollTo({ top: target, behavior: scrollBehavior() });
  }
}

function supportsCustomHighlights(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}
