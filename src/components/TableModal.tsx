import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

interface Props {
  title?: string;
  onClose: () => void;
  /** Controls rendered in the head bar between the title and the close
   *  button — e.g. a "Wrap" checkbox the consumer wires to its own state. */
  headExtras?: ReactNode;
  children: ReactNode;
}

const DEFAULT_W = 880;
const DEFAULT_H = 560;
const MIN_W = 360;
const MIN_H = 240;

/** Floating panel for reviewing wide tables. Non-blocking — the user
 *  can keep scrolling the reader behind it. Draggable via its header
 *  and resizable via the bottom-right corner. */
export function TableModal({ title, onClose, headExtras, children }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [pos, setPos] = useState(() => ({
    left: Math.max(24, Math.round((window.innerWidth - DEFAULT_W) / 2)),
    top: Math.max(24, Math.round((window.innerHeight - DEFAULT_H) / 3)),
  }));
  const [size, setSize] = useState(() => ({
    w: Math.min(DEFAULT_W, window.innerWidth - 48),
    h: Math.min(DEFAULT_H, window.innerHeight - 48),
  }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inside = panelRef.current?.contains(document.activeElement);
      if (inside || document.activeElement === document.body) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      // Don't start a drag when the press lands on the close button or
      // any interactive control in the head (checkboxes etc.).
      const target = e.target as HTMLElement;
      if (target.closest("button, input, label, select")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startPos = { ...pos };
      const onMove = (ev: MouseEvent) => {
        const left = Math.max(
          0,
          Math.min(window.innerWidth - 80, startPos.left + ev.clientX - startX),
        );
        const top = Math.max(
          0,
          Math.min(window.innerHeight - 40, startPos.top + ev.clientY - startY),
        );
        setPos({ left, top });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    },
    [pos],
  );

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startSize = { ...size };
      const onMove = (ev: MouseEvent) => {
        const w = Math.max(
          MIN_W,
          Math.min(
            window.innerWidth - pos.left - 8,
            startSize.w + ev.clientX - startX,
          ),
        );
        const h = Math.max(
          MIN_H,
          Math.min(
            window.innerHeight - pos.top - 8,
            startSize.h + ev.clientY - startY,
          ),
        );
        setSize({ w, h });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";
    },
    [size, pos],
  );

  return createPortal(
    <div
      ref={panelRef}
      className="table-modal"
      role="dialog"
      aria-label={title ?? "Table viewer"}
      style={{
        left: pos.left,
        top: pos.top,
        width: size.w,
        height: size.h,
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: header drag starts window-style repositioning for the modal. */}
      <div
        className="table-modal-head"
        onMouseDown={startDrag}
        title="Drag to move"
      >
        <span className="table-modal-title">{title ?? "Table"}</span>
        {headExtras && (
          <div className="table-modal-head-extras">{headExtras}</div>
        )}
        <button
          type="button"
          className="table-modal-close"
          onClick={onClose}
          aria-label="Close table viewer"
          title="Close (Esc)"
        >
          <Icon.Close />
        </button>
      </div>
      <div className="table-modal-body">{children}</div>
      <span
        className="table-modal-resize"
        onMouseDown={startResize}
        aria-hidden="true"
        title="Drag to resize"
      />
    </div>,
    document.body,
  );
}
