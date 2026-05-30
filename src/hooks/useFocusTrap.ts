import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

interface Options {
  /** When false, the trap does nothing — useful for components whose
   *  open state is owned by the parent. Defaults to true. */
  active?: boolean;
  /** When true, focuses the first focusable element on mount. Set to
   *  false when the component manages initial focus itself (e.g. an
   *  autoFocused input). Defaults to true. */
  autoFocus?: boolean;
}

/** Modal / dialog focus management. While `active`, Tab and Shift-Tab
 *  cycle focus inside `containerRef`; on unmount, focus restores to
 *  whatever element was active when the trap was installed. The caller
 *  owns Esc handling so dismissal logic stays in one place. */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { active = true, autoFocus = true }: Options = {},
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    if (autoFocus) {
      const focusables = getFocusable(container);
      const first = focusables[0];
      if (first) {
        first.focus();
      } else {
        // Container itself becomes the focus target so Esc and arrow
        // keys still find a handler.
        container.tabIndex = -1;
        container.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusable(container);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      const prev = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      // Only restore if the previously-focused element is still in the
      // DOM and focusable. Otherwise let the browser pick a default.
      if (prev && document.contains(prev) && typeof prev.focus === "function") {
        prev.focus();
      }
    };
  }, [active, autoFocus, containerRef]);
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  return Array.from(nodes).filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    // Skip elements with no layout (display:none / visibility:hidden /
    // detached subtrees). offsetParent is null for any of these.
    if (el.offsetParent === null && el !== container) {
      // <details> contents and position:fixed elements have no
      // offsetParent but are still focusable. Fall back to a bounding
      // rect check for those.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  });
}
