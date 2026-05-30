import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSettings } from "../settings/store";
import type { MarkdownEditorHandle } from "./MarkdownEditor";
import type { ReaderMode } from "./Reader";

const STORAGE_KEY = `specrider.splitRatio.v1.${getCurrentWindow().label}`;
const DEFAULT_RATIO = 0.5;
const MIN_EDITOR_PX = 280;
const MAX_EDITOR_RATIO = 0.7;
/** After a user scroll/keystroke on one side, the *other* side ignores
 *  the resulting sync push for this many ms — prevents ping-pong where
 *  each side bounces the other back and forth around a target line. */
const SYNC_GRACE_MS = 200;

interface Props {
  mode: ReaderMode;
  editor: ReactNode;
  preview: ReactNode;
  previewScrollRef: RefObject<HTMLDivElement | null>;
  editorHandleRef?: RefObject<MarkdownEditorHandle | null>;
}

function loadRatio(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RATIO;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0 || n >= 1) return DEFAULT_RATIO;
    return n;
  } catch {
    return DEFAULT_RATIO;
  }
}

/** Wraps the editor and preview in a CSS grid that adapts to the
 *  active reader mode. In `read` and `edit` the inactive child is
 *  hidden via display:none so each preserves its scroll position
 *  across mode toggles; in `split` both sit side by side with a
 *  draggable divider whose position is persisted per-window.
 *
 *  When `splitScrollSync` is on AND mode === "split", scrolling either
 *  side moves the other to the matching heading. Heading-anchored
 *  rather than percentage-based — meaningful for plans where source
 *  and rendered content can have wildly different vertical extents
 *  (frontmatter, tables, code blocks). */
export function SplitView({
  mode,
  editor,
  preview,
  previewScrollRef,
  editorHandleRef,
}: Props) {
  const { effective: settings } = useSettings();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState<number>(loadRatio);

  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      let raf = 0;
      let latest = ratio;
      const onMove = (ev: MouseEvent) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (rect.width <= 0) return;
          const desired = (ev.clientX - rect.left) / rect.width;
          const minRatio = Math.min(
            MAX_EDITOR_RATIO,
            MIN_EDITOR_PX / rect.width,
          );
          const clamped = Math.min(
            MAX_EDITOR_RATIO,
            Math.max(minRatio, desired),
          );
          latest = clamped;
          setRatio(clamped);
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          localStorage.setItem(STORAGE_KEY, String(latest));
        } catch {
          /* ignore quota */
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [ratio],
  );

  const onSplitterKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.getBoundingClientRect().width;
    if (width <= 0) return;
    const minRatio = Math.min(MAX_EDITOR_RATIO, MIN_EDITOR_PX / width);
    const step = e.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(minRatio, ratio - step);
    else if (e.key === "ArrowRight")
      next = Math.min(MAX_EDITOR_RATIO, ratio + step);
    else if (e.key === "Home") next = minRatio;
    else if (e.key === "End") next = MAX_EDITOR_RATIO;
    if (next === null) return;
    e.preventDefault();
    setRatio(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore quota */
    }
  };

  // Re-clamp ratio against the current container width — a previously
  // stored ratio might violate the 280px minimum at narrower widths.
  useEffect(() => {
    if (mode !== "split") return;
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      if (w <= 0) return;
      setRatio((cur) => {
        const minRatio = Math.min(MAX_EDITOR_RATIO, MIN_EDITOR_PX / w);
        if (cur < minRatio) return minRatio;
        if (cur > MAX_EDITOR_RATIO) return MAX_EDITOR_RATIO;
        return cur;
      });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [mode]);

  // Two-way scroll sync. Each side reports its current top heading;
  // the other scrolls to match. A `lastDriver` ref (with timestamp)
  // suppresses the immediate echo so we don't ping-pong.
  //
  // Re-observes when the heading set changes (AST re-parse) by watching
  // for childList mutations on the document <article>.
  useEffect(() => {
    if (mode !== "split" || !settings.splitScrollSync) return;
    const previewEl = previewScrollRef.current;
    if (!previewEl) return;

    let lastDriver: "editor" | "preview" | null = null;
    let lastDriverAt = 0;

    /** Returns headings as [{line, id, el}] sorted by source line. */
    const collectHeadings = () => {
      const els = Array.from(
        previewEl.querySelectorAll<HTMLElement>(
          "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]",
        ),
      );
      const out: { line: number; id: string; el: HTMLElement }[] = [];
      for (const el of els) {
        const ds = el.dataset.sourceStartLine;
        if (!ds) continue;
        const line = Number(ds);
        if (!Number.isFinite(line)) continue;
        out.push({ line, id: el.id, el });
      }
      out.sort((a, b) => a.line - b.line);
      return out;
    };

    /** Heading position inside the preview's scroll container, in
     *  pixels — independent of current scroll. */
    const headingScrollOffset = (
      h: ReturnType<typeof collectHeadings>[number],
    ) =>
      h.el.getBoundingClientRect().top -
      previewEl.getBoundingClientRect().top +
      previewEl.scrollTop;

    /** For a given source-line (fractional) value, return the bracketing
     *  pair of headings — or [prev, null] if past the last, [null, next]
     *  if before the first. */
    const bracketByLine = (
      headings: ReturnType<typeof collectHeadings>,
      line: number,
    ): [
      ReturnType<typeof collectHeadings>[number] | null,
      ReturnType<typeof collectHeadings>[number] | null,
    ] => {
      let prev: (typeof headings)[number] | null = null;
      let next: (typeof headings)[number] | null = null;
      for (const h of headings) {
        if (h.line <= line) prev = h;
        else {
          next = h;
          break;
        }
      }
      return [prev, next];
    };

    /** For the preview's current scrollTop, return the bracketing
     *  pair of headings (by their position in the scroll container). */
    const bracketByPreviewPx = (
      headings: ReturnType<typeof collectHeadings>,
      px: number,
    ): [
      ReturnType<typeof collectHeadings>[number] | null,
      ReturnType<typeof collectHeadings>[number] | null,
    ] => {
      let prev: (typeof headings)[number] | null = null;
      let next: (typeof headings)[number] | null = null;
      for (const h of headings) {
        if (headingScrollOffset(h) <= px + 1) prev = h;
        else {
          next = h;
          break;
        }
      }
      return [prev, next];
    };

    // Editor → preview. Compute fractional position between the
    // surrounding two headings, then place the preview at the same
    // fractional position between the same two headings' DOM tops.
    // No snap: scrolling continuously past a heading interpolates
    // smoothly into the next gap.
    let editorUnsub: (() => void) | null = null;
    let pollAttempts = 0;
    const wireEditor = () => {
      const handle = editorHandleRef?.current;
      if (!handle) {
        if (pollAttempts++ < 30) {
          requestAnimationFrame(wireEditor);
        }
        return;
      }
      editorUnsub = handle.onViewportChange((topLine) => {
        const now = performance.now();
        if (lastDriver === "preview" && now - lastDriverAt < SYNC_GRACE_MS) {
          return;
        }
        const headings = collectHeadings();
        if (headings.length === 0) return;
        const [prev, next] = bracketByLine(headings, topLine);

        // Document end as a virtual final anchor — without it, docs
        // with no heading after the current scroll position pin the
        // preview to the last heading's offset, so scrolling the editor
        // past it just snaps the preview back to the top of that heading.
        // `topLineAtMaxScroll` (not `totalLines`) is the f=1 reference:
        // at max editor scroll the top-visible line is well short of
        // the last source line, so using `totalLines` would leave the
        // preview short of its bottom even when the editor is fully
        // scrolled.
        const endLine =
          handle.topLineAtMaxScroll?.() ?? handle.totalLines?.() ?? topLine;
        const endTop = Math.max(
          0,
          previewEl.scrollHeight - previewEl.clientHeight,
        );

        let targetTop: number;
        if (!prev) {
          // Above first heading — interpolate from doc start to first.
          const b = next ? headingScrollOffset(next) : endTop;
          const nextLine = next ? next.line : endLine;
          const span = nextLine - 1 || 1;
          const f = Math.max(0, Math.min(1, (topLine - 1) / span));
          targetTop = f * b;
        } else if (!next) {
          // Past last heading — interpolate from prev to doc end.
          const a = headingScrollOffset(prev);
          const span = endLine - prev.line || 1;
          const f = Math.max(0, Math.min(1, (topLine - prev.line) / span));
          targetTop = a + f * Math.max(0, endTop - a);
        } else {
          const span = next.line - prev.line || 1;
          const f = Math.max(0, Math.min(1, (topLine - prev.line) / span));
          const a = headingScrollOffset(prev);
          const b = headingScrollOffset(next);
          targetTop = a + f * (b - a);
        }
        lastDriver = "editor";
        lastDriverAt = now;
        // Bypass `.reader-scroll`'s `scroll-behavior: smooth` — sync
        // pushes need to land instantly so the preview tracks the
        // editor 1:1 without lagging into the next animation frame.
        previewEl.scrollTo({ top: targetTop, behavior: "instant" });
      });
    };
    wireEditor();

    // Preview → editor. Symmetric: find which two headings the
    // preview's scroll position falls between (in pixel terms), then
    // place the editor at the same fractional source-line position
    // between those headings' lines.
    let pendingFrame = 0;
    const onPreviewScroll = () => {
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        const now = performance.now();
        if (lastDriver === "editor" && now - lastDriverAt < SYNC_GRACE_MS) {
          return;
        }
        const handle = editorHandleRef?.current;
        if (!handle) return;
        const headings = collectHeadings();
        if (headings.length === 0) return;

        const px = previewEl.scrollTop;
        const [prev, next] = bracketByPreviewPx(headings, px);

        // Document end as a virtual final anchor — see editor→preview
        // branch above for the reasoning. Without this, scrolling the
        // preview past the last heading pins the editor to that line.
        const endLine =
          handle.topLineAtMaxScroll?.() ?? handle.totalLines?.() ?? 1;
        const endTop = Math.max(
          0,
          previewEl.scrollHeight - previewEl.clientHeight,
        );

        let editorTargetLine: number;
        if (!prev) {
          // Above first heading — interpolate from doc start to first.
          const b = next ? headingScrollOffset(next) : endTop;
          const nextLine = next ? next.line : endLine;
          const span = b || 1;
          const f = Math.max(0, Math.min(1, px / span));
          editorTargetLine = 1 + f * (nextLine - 1);
        } else if (!next) {
          // Past last heading — interpolate from prev to doc end.
          const a = headingScrollOffset(prev);
          const span = endTop - a || 1;
          const f = Math.max(0, Math.min(1, (px - a) / span));
          editorTargetLine = prev.line + f * (endLine - prev.line);
        } else {
          const a = headingScrollOffset(prev);
          const b = headingScrollOffset(next);
          const span = b - a || 1;
          const f = Math.max(0, Math.min(1, (px - a) / span));
          editorTargetLine = prev.line + f * (next.line - prev.line);
        }
        lastDriver = "preview";
        lastDriverAt = now;
        handle.scrollToFractionalLine(editorTargetLine);
      });
    };
    previewEl.addEventListener("scroll", onPreviewScroll, { passive: true });

    return () => {
      editorUnsub?.();
      previewEl.removeEventListener("scroll", onPreviewScroll);
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
    };
  }, [mode, settings.splitScrollSync, previewScrollRef, editorHandleRef]);

  // Focus the editor when entering split mode via ⌘E. Most users in
  // split are editing; this saves a click. Skip when focus is already
  // elsewhere intentionally (settings dialog, etc.) — heuristic: only
  // focus if focus is on body or inside the reader.
  useEffect(() => {
    if (mode !== "split") return;
    const handle = editorHandleRef?.current;
    if (!handle) return;
    const active = document.activeElement;
    if (
      active === document.body ||
      (active instanceof HTMLElement && active.closest(".reader"))
    ) {
      handle.focus();
    }
  }, [mode, editorHandleRef]);

  const gridStyle: React.CSSProperties =
    mode === "split"
      ? {
          gridTemplateColumns: `${ratio * 100}% 6px 1fr`,
        }
      : {
          gridTemplateColumns: "1fr",
        };

  return (
    <div
      ref={containerRef}
      className={`reader-content mode-${mode}`}
      style={gridStyle}
    >
      {editor}
      {mode === "split" && (
        <hr
          className="reader-splitter"
          onMouseDown={startResize}
          onKeyDown={onSplitterKey}
          aria-orientation="vertical"
          aria-label="Resize editor / preview"
          aria-valuemin={20}
          aria-valuemax={Math.round(MAX_EDITOR_RATIO * 100)}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
        />
      )}
      {preview}
    </div>
  );
}
