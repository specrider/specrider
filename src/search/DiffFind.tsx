import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  DiffFindApi,
  DiffSearchMatch,
} from "../components/CommitDiffBody";
import { Icon } from "../components/icons";
import { useDebounced } from "../hooks/useDebounced";

interface DiffFindProps {
  open: boolean;
  apiRef: RefObject<DiffFindApi | null>;
  scanKey: unknown;
  onClose: () => void;
}

export function DiffFind({ open, apiRef, scanKey, onClose }: DiffFindProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [matches, setMatches] = useState<DiffSearchMatch[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const debouncedQuery = useDebounced(query, 60);

  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else {
      apiRef.current?.clear();
      setMatches([]);
      setActiveIdx(0);
      lastFocusedRef.current?.focus?.();
      lastFocusedRef.current = null;
    }
  }, [apiRef, open]);

  useEffect(() => {
    void scanKey;
    if (!open) return;
    const found = apiRef.current?.search(debouncedQuery) ?? [];
    setMatches(found);
    setActiveIdx(0);
    apiRef.current?.activate(found[0] ?? null);
  }, [apiRef, debouncedQuery, open, scanKey]);

  if (!open) return null;

  function step(delta: number) {
    if (matches.length === 0) return;
    const next = (activeIdx + delta + matches.length) % matches.length;
    setActiveIdx(next);
    apiRef.current?.activate(matches[next] ?? null);
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  return (
    <search className="find-bar" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        value={query}
        placeholder="Find in diff"
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Find in diff"
        spellCheck={false}
      />
      <span className="find-count" aria-live="polite">
        {matches.length === 0
          ? query
            ? "0 / 0"
            : ""
          : `${activeIdx + 1} / ${matches.length}`}
      </span>
      <button
        type="button"
        className="find-btn"
        onClick={() => step(-1)}
        aria-label="Previous match"
        title="Previous (Shift+Enter)"
        disabled={matches.length === 0}
      >
        <Icon.ChevronL />
      </button>
      <button
        type="button"
        className="find-btn"
        onClick={() => step(1)}
        aria-label="Next match"
        title="Next (Enter)"
        disabled={matches.length === 0}
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
        x
      </button>
    </search>
  );
}
