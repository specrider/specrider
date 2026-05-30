import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Options {
  /** "vertical" — Up/Down move; "horizontal" — Left/Right move;
   *  "both" — all four arrow keys. Defaults to "vertical". */
  orientation?: "vertical" | "horizontal" | "both";
  /** When true, ArrowDown past the end wraps to first and ArrowUp past
   *  start wraps to last. Defaults to false (W3C tree pattern doesn't
   *  wrap; menu/listbox often do). */
  loop?: boolean;
  /** Index that should hold the tab stop on first render. Defaults to 0. */
  initialIndex?: number;
}

interface RovingApi {
  /** Index of the currently-active item (the one with tabIndex=0). */
  activeIndex: number;
  /** Programmatically jump the tab stop and focus to a specific index. */
  setActiveIndex: (next: number) => void;
  /** Per-item props the consumer spreads onto the rendered element. */
  getItemProps: (index: number) => {
    tabIndex: 0 | -1;
    ref: (el: HTMLElement | null) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onFocus: () => void;
  };
}

/** Roving-tabindex implementation of the W3C composite-widget keyboard
 *  pattern: one tab stop in the group, arrow keys move between items,
 *  Home/End jump to ends. The container itself is not part of the tab
 *  order — the active item owns the tab stop. */
export function useRovingTabIndex(
  itemCount: number,
  { orientation = "vertical", loop = false, initialIndex = 0 }: Options = {},
): RovingApi {
  const [activeIndex, setActiveIndexState] = useState(() =>
    Math.max(0, Math.min(initialIndex, Math.max(0, itemCount - 1))),
  );
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  // Whether the next render should focus the active item. Set true by
  // the arrow-key handlers; cleared after the focus runs. Stops focus
  // from being yanked away during normal renders / count changes.
  const focusOnNextRender = useRef(false);

  if (itemRefs.current.length !== itemCount) {
    itemRefs.current.length = itemCount;
  }

  // Clamp activeIndex if itemCount shrinks.
  useEffect(() => {
    if (itemCount === 0) {
      if (activeIndex !== 0) setActiveIndexState(0);
      return;
    }
    if (activeIndex >= itemCount) {
      setActiveIndexState(itemCount - 1);
    }
  }, [itemCount, activeIndex]);

  useEffect(() => {
    if (!focusOnNextRender.current) return;
    focusOnNextRender.current = false;
    itemRefs.current[activeIndex]?.focus();
  }, [activeIndex]);

  const move = useCallback(
    (delta: number) => {
      if (itemCount === 0) return;
      setActiveIndexState((cur) => {
        const next = cur + delta;
        if (next < 0) return loop ? itemCount - 1 : 0;
        if (next >= itemCount) return loop ? 0 : itemCount - 1;
        return next;
      });
      focusOnNextRender.current = true;
    },
    [itemCount, loop],
  );

  const jump = useCallback(
    (index: number) => {
      if (itemCount === 0) return;
      const clamped = Math.max(0, Math.min(index, itemCount - 1));
      setActiveIndexState(clamped);
      focusOnNextRender.current = true;
    },
    [itemCount],
  );

  const setActiveIndex = useCallback((next: number) => {
    setActiveIndexState((cur) => (cur === next ? cur : next));
  }, []);

  const getItemProps = useMemo(
    () => (index: number) => ({
      tabIndex: (index === activeIndex ? 0 : -1) as 0 | -1,
      ref: (el: HTMLElement | null) => {
        itemRefs.current[index] = el;
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        const key = e.key;
        const verticalMove =
          orientation === "vertical" || orientation === "both";
        const horizontalMove =
          orientation === "horizontal" || orientation === "both";
        if (verticalMove && key === "ArrowDown") {
          e.preventDefault();
          move(1);
          return;
        }
        if (verticalMove && key === "ArrowUp") {
          e.preventDefault();
          move(-1);
          return;
        }
        if (horizontalMove && key === "ArrowRight") {
          e.preventDefault();
          move(1);
          return;
        }
        if (horizontalMove && key === "ArrowLeft") {
          e.preventDefault();
          move(-1);
          return;
        }
        if (key === "Home") {
          e.preventDefault();
          jump(0);
          return;
        }
        if (key === "End") {
          e.preventDefault();
          jump(itemCount - 1);
          return;
        }
      },
      onFocus: () => {
        // Mouse / programmatic focus on a non-active item promotes it
        // without triggering re-focus on next render.
        setActiveIndex(index);
      },
    }),
    [activeIndex, orientation, move, jump, itemCount, setActiveIndex],
  );

  return { activeIndex, setActiveIndex, getItemProps };
}
