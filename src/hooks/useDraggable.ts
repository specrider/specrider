import { useCallback, useEffect, useRef, useState } from "react";

interface Position {
  left: number;
  top: number;
}

interface Options {
  /** Approximate popover footprint, used to center when no anchor is
   *  given AND to clamp drag positions inside the viewport. */
  size: { width: number; height: number };
}

interface UseDraggable {
  pos: Position;
  /** Attach to the drag handle (typically the popover header). */
  handleRef: (el: HTMLElement | null) => void;
}

/** Lets a fixed-position element be dragged by its handle. The handle
 *  ignores mousedowns on `<button>` / `<input>` so close buttons keep
 *  working. Position is clamped to keep at least a sliver of the
 *  popover on screen. */
export function useDraggable(
  initial: Position | null,
  { size }: Options,
): UseDraggable {
  const [pos, setPos] = useState<Position>(
    () =>
      initial ?? {
        left: Math.max(8, window.innerWidth / 2 - size.width / 2),
        top: Math.max(8, window.innerHeight / 2 - size.height / 2),
      },
  );

  // Mirror state into a ref so the mousedown closure picks up the
  // current position on subsequent drags (the effect runs once).
  const posRef = useRef(pos);
  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  const [handleEl, setHandleEl] = useState<HTMLElement | null>(null);
  const handleRef = useCallback((el: HTMLElement | null) => {
    setHandleEl(el);
  }, []);

  useEffect(() => {
    if (!handleEl) return;
    let startMouseX = 0;
    let startMouseY = 0;
    let startPosX = 0;
    let startPosY = 0;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      setPos({
        left: Math.max(
          8 - size.width + 80,
          Math.min(startPosX + dx, window.innerWidth - 80),
        ),
        top: Math.max(8, Math.min(startPosY + dy, window.innerHeight - 40)),
      });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't hijack clicks on buttons/inputs inside the handle.
      if (target.closest("button, input, a, select, textarea")) return;
      e.preventDefault();
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      startPosX = posRef.current.left;
      startPosY = posRef.current.top;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    };
    handleEl.addEventListener("mousedown", onDown);
    return () => {
      handleEl.removeEventListener("mousedown", onDown);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleEl, size.width]);

  return { pos, handleRef };
}
