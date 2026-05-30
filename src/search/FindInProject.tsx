import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { type SearchResult, searchPlans } from "../tauri/api";
import type { Plan } from "../types";

interface FindInProjectProps {
  open: boolean;
  plans: Plan[];
  /** Called when the user picks a hit. Receives the plan id (relative
   *  path), the matched line number, and the query — so the caller
   *  can switch plans and seed the in-doc find bar with the same
   *  query for visual continuity. */
  onSelect: (planId: string, line: number, query: string) => void;
  onClose: () => void;
}

interface FlatHit {
  result: SearchResult;
  hitIdx: number;
  plan?: Plan;
  /** True if this row is the first hit for its plan — used to render
   *  a plan header above the row. */
  isPlanHeader: boolean;
}

const DEBOUNCE_MS = 180;

export function FindInProject({
  open,
  plans,
  onSelect,
  onClose,
}: FindInProjectProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pending, setPending] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useFocusTrap(modalRef, { active: open, autoFocus: false });

  // Open/close lifecycle.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else {
      lastFocusedRef.current?.focus?.();
      lastFocusedRef.current = null;
      setActiveIdx(0);
    }
  }, [open]);

  // Debounced search. Empty query → empty results.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setPending(false);
      return;
    }
    setPending(true);
    const t = window.setTimeout(() => {
      searchPlans(trimmed, { caseSensitive, wholeWord, useRegex })
        .then((r) => {
          setResults(r);
          setActiveIdx(0);
        })
        .catch((e) => {
          console.error("searchPlans failed:", e);
          setResults([]);
        })
        .finally(() => setPending(false));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [open, query, caseSensitive, wholeWord, useRegex]);

  const planById = useMemo(() => {
    const m = new Map<string, Plan>();
    for (const p of plans) m.set(p.path, p);
    return m;
  }, [plans]);

  const flat: FlatHit[] = useMemo(() => {
    const out: FlatHit[] = [];
    for (const r of results) {
      const plan = planById.get(r.path);
      r.hits.forEach((_, idx) => {
        out.push({
          result: r,
          hitIdx: idx,
          plan,
          isPlanHeader: idx === 0,
        });
      });
    }
    return out;
  }, [results, planById]);

  const totalMatches = useMemo(
    () => results.reduce((acc, r) => acc + r.hits.length, 0),
    [results],
  );

  // Keep the active row in view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % Math.max(1, flat.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) =>
        flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const picked = flat[activeIdx];
      if (picked) {
        const hit = picked.result.hits[picked.hitIdx];
        onSelect(picked.result.path, hit.line, query.trim());
        onClose();
      }
      return;
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses the dialog; keyboard handling is on the dialog wrapper.
    <div
      className="qs-backdrop fp-backdrop"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: this click only prevents backdrop dismissal. */}
      <div
        className="qs-modal fp-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Find in project"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fp-head">
          <input
            ref={inputRef}
            className="qs-input fp-input"
            type="text"
            value={query}
            placeholder="Find in project…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find in project"
            spellCheck={false}
          />
          <div className="fp-toggles">
            <ToggleChip
              label="Aa"
              title="Match case"
              on={caseSensitive}
              onChange={setCaseSensitive}
            />
            <ToggleChip
              label="W"
              title="Whole word"
              on={wholeWord}
              onChange={setWholeWord}
            />
            <ToggleChip
              label=".*"
              title="Regular expression"
              on={useRegex}
              onChange={setUseRegex}
            />
          </div>
        </div>
        <div className="fp-status">
          {query.trim() === ""
            ? "Type to search across all documents"
            : pending
              ? "Searching…"
              : totalMatches === 0
                ? "No matches"
                : `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${results.length} document${results.length === 1 ? "" : "s"}`}
        </div>
        <div className="fp-list" ref={listRef}>
          {flat.map((row, i) => {
            const hit = row.result.hits[row.hitIdx];
            const planTitle = row.plan?.title ?? row.result.path;
            return (
              <div key={`${row.result.path}:${hit.line}:${hit.matchStart}`}>
                {row.isPlanHeader && (
                  <div className="fp-plan-head">
                    <span className="fp-plan-title">{planTitle}</span>
                    <span className="fp-plan-path">{row.result.path}</span>
                    <span className="fp-plan-count">
                      {row.result.hits.length}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  data-idx={i}
                  className={`fp-row ${i === activeIdx ? "active" : ""}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => {
                    onSelect(row.result.path, hit.line, query.trim());
                    onClose();
                  }}
                >
                  <span className="fp-line-no">{hit.line}</span>
                  <span className="fp-snippet">
                    {renderSnippet(hit.lineText, hit.matchStart, hit.matchEnd)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function renderSnippet(text: string, start: number, end: number) {
  // Trim leading whitespace to keep snippets compact, adjusting offsets.
  const leading = text.length - text.trimStart().length;
  const trimmed = text.slice(leading);
  const s = Math.max(0, start - leading);
  const e = Math.max(s, end - leading);
  const before = trimmed.slice(0, s);
  const matched = trimmed.slice(s, e);
  const after = trimmed.slice(e);
  return (
    <>
      <span>{before}</span>
      <mark>{matched}</mark>
      <span>{after}</span>
    </>
  );
}

function ToggleChip({
  label,
  title,
  on,
  onChange,
}: {
  label: string;
  title: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`fp-chip ${on ? "on" : ""}`}
      title={title}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  );
}
