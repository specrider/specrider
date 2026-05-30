import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { Plan } from "../types";
import {
  applyFilters,
  type FilterKind,
  type ParsedFilter,
  parseQuery,
  suggestValues,
} from "./queryFilters";
import { rankPlans } from "./rankPlans";
import { splitByMatches } from "./score";

interface QuickSwitchProps {
  open: boolean;
  plans: Plan[];
  onSelect: (planId: string) => void;
  onClose: () => void;
}

const RESULT_LIMIT = 30;
const EMPTY_QUERY_LIMIT = 20;
const MAX_SUGGESTIONS = 8;

export function QuickSwitch({
  open,
  plans,
  onSelect,
  onClose,
}: QuickSwitchProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useFocusTrap(modalRef, { active: open, autoFocus: false });

  // Reset transient state every time the palette opens. Remember the
  // previously-focused element so Esc can restore focus.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setCursor(0);
      setActiveIdx(0);
      setSuggestionIdx(0);
      // Defer focus to the next paint so the input exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      lastFocusedRef.current?.focus?.();
      lastFocusedRef.current = null;
    }
  }, [open]);

  const parsed = useMemo(() => parseQuery(query, cursor), [query, cursor]);

  const filtered = useMemo(
    () => applyFilters(plans, parsed.filters),
    [plans, parsed.filters],
  );

  const results = useMemo(
    () =>
      rankPlans(parsed.freeText, filtered, {
        limit: RESULT_LIMIT,
        emptyQueryLimit: EMPTY_QUERY_LIMIT,
      }),
    [parsed.freeText, filtered],
  );

  const suggestions = useMemo(() => {
    if (!parsed.inProgress) return [];
    return suggestValues(
      plans,
      parsed.inProgress.kind,
      parsed.inProgress.partial,
    ).slice(0, MAX_SUGGESTIONS);
  }, [plans, parsed.inProgress]);

  // Clamp activeIdx whenever the result list shrinks.
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results.length, activeIdx]);

  // Reset suggestion cursor when the suggestion set changes.
  useEffect(() => {
    setSuggestionIdx(0);
  }, []);

  // Keep the active row in view as the user arrows through.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  /** Replace the in-progress filter token with a fully-formed
   *  `prefix:value ` token, advance the caret to just after the
   *  inserted space. */
  const completeSuggestion = (value: string) => {
    if (!parsed.inProgress) return;
    const { kind, tokenStart, tokenEnd } = parsed.inProgress;
    const prefix = kindToPrefix(kind, query, tokenStart);
    const replacement = `${prefix}${value} `;
    const next =
      query.slice(0, tokenStart) + replacement + query.slice(tokenEnd);
    setQuery(next);
    const newCursor = tokenStart + replacement.length;
    setCursor(newCursor);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(newCursor, newCursor);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    // Suggestion-dropdown keys take precedence when it's open. While
    // the user is typing inside an in-progress filter token, ↑/↓
    // navigate suggestions and Tab / Enter / Space all complete —
    // result-list navigation is suppressed so the obvious next move
    // (pick a suggestion) actually works.
    if (suggestions.length > 0 && parsed.inProgress) {
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const picked = suggestions[suggestionIdx];
        if (picked) completeSuggestion(picked);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestionIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestionIdx(
          (i) => (i - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % Math.max(1, results.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) =>
        results.length === 0 ? 0 : (i - 1 + results.length) % results.length,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const picked = results[activeIdx];
      if (picked) {
        onSelect(picked.plan.id);
        onClose();
      }
      return;
    }
  };

  const placeholder =
    parsed.filters.length > 0 || parsed.inProgress
      ? "type to refine…"
      : "Switch to document…  (try `tag:`, `@`, `bucket:`)";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses the dialog; keyboard handling is on the dialog wrapper.
    <div className="qs-backdrop" onClick={onClose} onKeyDown={onKeyDown}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: this click only prevents backdrop dismissal. */}
      <div
        className="qs-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quick switch"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qs-input-row">
          {parsed.filters.length > 0 && (
            <section className="qs-filter-chips" aria-label="Active filters">
              {parsed.filters.map((f) => (
                <FilterChip
                  key={`${f.kind}:${f.value}`}
                  filter={f}
                  onRemove={() => removeFilter(query, f, setQuery, setCursor)}
                />
              ))}
            </section>
          )}
          <input
            ref={inputRef}
            className="qs-input"
            type="text"
            value={query}
            placeholder={placeholder}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyUp={(e) => {
              const sel = (e.target as HTMLInputElement).selectionStart;
              if (sel != null) setCursor(sel);
            }}
            onClick={(e) => {
              const sel = (e.target as HTMLInputElement).selectionStart;
              if (sel != null) setCursor(sel);
            }}
            aria-label="Search documents"
            spellCheck={false}
          />
        </div>
        {parsed.inProgress && (
          <div className="qs-suggestions" role="listbox">
            <div className="qs-suggestions-head">
              <span>{suggestionLabel(parsed.inProgress.kind)}</span>
              {suggestions.length > 0 && (
                <span className="qs-suggestions-hint">
                  <kbd>↑↓</kbd> navigate
                  <span className="qs-suggestions-hint-sep">·</span>
                  <kbd>Tab</kbd> select
                </span>
              )}
            </div>
            {suggestions.length === 0 ? (
              <div className="qs-suggestions-empty">
                No matching{" "}
                {suggestionLabel(parsed.inProgress.kind).toLowerCase()} — press{" "}
                <kbd>Space</kbd> to commit free text.
              </div>
            ) : (
              suggestions.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={i === suggestionIdx}
                  className={`qs-suggestion ${
                    i === suggestionIdx ? "active" : ""
                  }`}
                  onMouseEnter={() => setSuggestionIdx(i)}
                  onClick={() => completeSuggestion(s)}
                >
                  {s}
                </button>
              ))
            )}
          </div>
        )}
        <div className="qs-list" ref={listRef}>
          {results.length === 0 && (
            <div className="qs-empty">
              {parsed.filters.length > 0
                ? "No matches for these filters"
                : "No matches"}
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.plan.id}
              type="button"
              data-idx={i}
              className={`qs-row ${i === activeIdx ? "active" : ""} bucket-${r.plan.bucket}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => {
                onSelect(r.plan.id);
                onClose();
              }}
            >
              <span
                className={`qs-bdot bucket-${r.plan.bucket}`}
                aria-hidden="true"
              />
              <span className="qs-row-main">
                <span className="qs-title">
                  {renderHighlighted(r.plan.title, r.titleSpans)}
                </span>
                <span className="qs-path">
                  {renderHighlighted(r.plan.path, r.pathSpans)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  filter,
  onRemove,
}: {
  filter: ParsedFilter;
  onRemove: () => void;
}) {
  const prefix = chipPrefix(filter.kind);
  return (
    <button
      type="button"
      className={`qs-chip qs-chip-${filter.kind}`}
      onClick={onRemove}
      title={`Remove filter ${prefix}${filter.value}`}
    >
      <span className="qs-chip-prefix">{prefix}</span>
      <span className="qs-chip-value">{filter.value}</span>
      <span className="qs-chip-x" aria-hidden="true">
        ×
      </span>
    </button>
  );
}

function chipPrefix(kind: FilterKind): string {
  switch (kind) {
    case "tag":
      return "#";
    case "owner":
      return "owner:";
    case "assignee":
      return "@";
    case "bucket":
      return "bucket:";
  }
}

function suggestionLabel(kind: FilterKind): string {
  switch (kind) {
    case "tag":
      return "Tags";
    case "owner":
      return "Owner";
    case "assignee":
      return "Assignee (owner or contributor)";
    case "bucket":
      return "Bucket";
  }
}

/** When the user typed `@foo`, completing should replace with `@bar `,
 *  not `assignee:bar `. Look at the literal prefix in the source query
 *  and reuse it. Falls back to `<kind>:` for canonical forms. */
function kindToPrefix(
  kind: FilterKind,
  query: string,
  tokenStart: number,
): string {
  const ch = query[tokenStart];
  if (kind === "tag" && ch === "#") return "#";
  if (kind === "assignee" && ch === "@") return "@";
  return `${kind}:`;
}

function removeFilter(
  query: string,
  filter: ParsedFilter,
  setQuery: (s: string) => void,
  setCursor: (n: number) => void,
) {
  // Drop the token *and* one trailing space if present so the
  // remaining query stays clean.
  let end = filter.tokenEnd;
  if (end < query.length && /\s/.test(query[end])) end++;
  const next = query.slice(0, filter.tokenStart) + query.slice(end);
  setQuery(next);
  setCursor(filter.tokenStart);
}

function renderHighlighted(
  text: string,
  spans: { start: number; end: number }[],
) {
  return splitByMatches(text, spans).map((p, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: split text fragments have no stable identity beyond order.
    p.matched ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
  );
}
