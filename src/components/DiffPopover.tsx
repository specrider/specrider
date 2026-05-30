import { useEffect, useRef } from "react";
import { useDraggable } from "../hooks/useDraggable";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { Hunk } from "../tauri/api";

interface Props {
  hunk: Hunk;
  onClose: () => void;
  /** Where to anchor the popover. If absent, the popover floats at
   *  the document center. */
  anchor?: { left: number; top: number } | null;
}

/** Renders the deleted/added text of a hunk, color-coded. Read-only:
 *  v1 doesn't expose stage/discard actions. */
export function DiffPopover({ hunk, onClose, anchor }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { pos, handleRef } = useDraggable(anchor ?? null, {
    size: { width: 480, height: 240 },
  });

  useFocusTrap(ref);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  const beforeLines = hunk.before.replace(/\n$/, "").split("\n");
  const afterLines = hunk.after.replace(/\n$/, "").split("\n");
  const showBefore = hunk.oldLines > 0;
  const showAfter = hunk.newLines > 0;

  return (
    <div
      className="diff-popover"
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diff-popover-title"
    >
      <div className="diff-popover-head" ref={handleRef}>
        <span className="diff-popover-meta" id="diff-popover-title">
          @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{" "}
          @@
        </span>
        <button
          type="button"
          className="diff-popover-close"
          onClick={onClose}
          aria-label="Close diff"
        >
          ×
        </button>
      </div>
      <div className="diff-popover-body">
        {showBefore &&
          beforeLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff preview lines are static display fragments.
            <div key={`b-${i}`} className="diff-line removed">
              <span className="diff-sigil">−</span>
              <span className="diff-text">{line || " "}</span>
            </div>
          ))}
        {showAfter &&
          afterLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff preview lines are static display fragments.
            <div key={`a-${i}`} className="diff-line added">
              <span className="diff-sigil">+</span>
              <span className="diff-text">{line || " "}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
