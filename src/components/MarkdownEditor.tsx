import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { atMentionExtension } from "../markdown/atMention";
import {
  blameExtension,
  changeGutterExtension,
  specialFenceExtension,
} from "../markdown/codemirror";
import { gitConflictDecorations } from "../markdown/gitConflictDecorations";
import { useSettings } from "../settings/store";
import type { BlameSet, ChangeSet, Hunk } from "../tauri/api";
import type { Plan } from "../types";

interface Props {
  value: string;
  onChange: (next: string) => void;
  diff?: ChangeSet;
  onHunkClick?: (hunk: Hunk) => void;
  blame?: BlameSet;
  blameEnabled?: boolean;
  onBlameShaClick?: (sha: string) => void;
  /** All plans in the project, for the `@`-mention completion popup.
   *  Read at completion time via a ref so updates flow without
   *  rebuilding the editor. */
  plans?: Plan[];
  /** When true, layer the git-conflict marker decorations on top of
   *  the buffer. Drives the [Keep ours / Keep theirs / Keep both]
   *  inline chips. */
  conflicted?: boolean;
}

export interface MarkdownEditorHandle {
  /** Scrolls the given (1-based) line into view, places the cursor on
   *  it, and focuses the editor. No-op for out-of-range lines. */
  revealLine: (line: number) => void;
  /** Current cursor line, 1-based. Returns 1 when the editor isn't mounted. */
  currentLine: () => number;
  /** Scrolls the given (1-based) line near the top of the viewport
   *  (with a small margin) and places the cursor there. Unlike
   *  `revealLine`, this does *not* focus the editor — used for
   *  outline jumps in split mode where the user might want to keep
   *  reading rather than start typing immediately.
   *
   *  `placeCursor`:
   *    - "lineStart": cursor at column 0 of the line.
   *    - "afterTaskMarker": cursor right after the `- [ ]` /
   *      `- [x]` checkbox (so typing edits the task text). Falls back
   *      to lineStart when the line doesn't match a task marker.
   *
   *  No-op for out-of-range lines.
   */
  scrollToLine: (
    line: number,
    options?: { placeCursor?: "lineStart" | "afterTaskMarker" },
  ) => void;
  /** Returns the 1-based source line at the top of the visible
   *  viewport, or 1 when the editor isn't mounted. */
  topVisibleLine: () => number;
  /** Total source-line count, or 1 when the editor isn't mounted. */
  totalLines: () => number;
  /** The (fractional) source line at the top of the viewport when the
   *  editor is scrolled to its maximum. Used by split-mode sync as the
   *  "end-of-document" anchor — `totalLines` overshoots because the
   *  last line can never sit at the top of the viewport. */
  topLineAtMaxScroll: () => number;
  /** Subscribes to viewport scroll events. Fires with the current
   *  top-visible line (fractional — e.g. 14.5 means the viewport top
   *  sits halfway through line 14) whenever the user scrolls or
   *  types past the visible window. Returns an unsubscribe function. */
  onViewportChange: (cb: (topLine: number) => void) => () => void;
  /** Scrolls the editor to a fractional source line position
   *  (e.g. 12.3 sits 30 % of line 12's height down). No-op when
   *  the editor isn't mounted or the line is out of range. Used
   *  for continuous (non-snap) scroll sync. */
  scrollToFractionalLine: (line: number) => void;
  /** Focuses the editor, leaving cursor where it is. */
  focus: () => void;
}

const markdownHighlighting = HighlightStyle.define([
  { tag: t.heading1, class: "cm-h1" },
  { tag: t.heading2, class: "cm-h2" },
  { tag: t.heading3, class: "cm-h3" },
  { tag: [t.heading4, t.heading5, t.heading6], class: "cm-h4" },
  { tag: t.strong, class: "cm-strong" },
  { tag: t.emphasis, class: "cm-em" },
  { tag: t.link, class: "cm-link" },
  { tag: t.url, class: "cm-url" },
  { tag: t.monospace, class: "cm-code" },
  { tag: t.contentSeparator, class: "cm-hr" },
  { tag: t.list, class: "cm-list" },
  { tag: t.quote, class: "cm-quote" },
  { tag: t.processingInstruction, class: "cm-md-mark" },
  { tag: t.meta, class: "cm-meta" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--mono-size, 13px)",
    color: "var(--ink)",
    backgroundColor: "var(--paper)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "18px 0 200px",
    caretColor: "var(--ink)",
  },
  ".cm-line": {
    padding: "0 24px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--paper-2)",
    borderRight: "1px solid var(--rule-soft)",
    color: "var(--ink-4)",
    fontFamily: "var(--font-mono)",
    fontSize: "calc(var(--mono-size, 13px) * 0.85)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 10px 0 14px",
    minWidth: "28px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--ink-2)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--paper-2)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--ink)",
    borderLeftWidth: "1.5px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "var(--accent-soft)",
    },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--paper-3)",
    outline: "1px solid var(--rule)",
  },
  ".cm-h1": { color: "var(--ink)", fontWeight: "600", fontSize: "1.15em" },
  ".cm-h2": { color: "var(--ink)", fontWeight: "600", fontSize: "1.08em" },
  ".cm-h3": { color: "var(--ink)", fontWeight: "600" },
  ".cm-h4": { color: "var(--ink)", fontWeight: "600" },
  ".cm-strong": { fontWeight: "600", color: "var(--ink)" },
  ".cm-em": { fontStyle: "italic", color: "var(--ink-2)" },
  ".cm-link": { color: "var(--accent-fg)" },
  ".cm-url": { color: "var(--accent-fg)", textDecoration: "underline" },
  ".cm-code": {
    color: "oklch(0.45 0.08 200)",
    backgroundColor: "var(--paper-2)",
    padding: "0 2px",
    borderRadius: "2px",
  },
  ".cm-quote": { color: "var(--ink-3)", fontStyle: "italic" },
  ".cm-list": { color: "var(--ink-2)" },
  ".cm-md-mark": { color: "var(--accent)" },
  ".cm-meta": { color: "oklch(0.5 0.12 35)" },
  ".cm-panels": {
    backgroundColor: "var(--paper-2)",
    color: "var(--ink)",
    borderColor: "var(--rule-soft)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--rule-soft)",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "1px solid var(--rule-soft)",
  },
  ".cm-panel.cm-search": {
    padding: "8px 12px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    fontFamily: "var(--font-sans, inherit)",
    fontSize: "12px",
  },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    color: "var(--ink-2)",
    fontSize: "12px",
    margin: "0 4px 0 0",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    accentColor: "var(--accent)",
    margin: 0,
  },
  ".cm-textfield": {
    backgroundColor: "var(--paper)",
    color: "var(--ink)",
    border: "1px solid var(--rule)",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    minWidth: "180px",
    outline: "none",
  },
  ".cm-textfield:focus": {
    borderColor: "var(--accent)",
    boxShadow: "0 0 0 2px var(--accent-soft)",
  },
  ".cm-button": {
    backgroundColor: "var(--paper)",
    backgroundImage: "none",
    color: "var(--ink-2)",
    border: "1px solid var(--rule)",
    borderRadius: "4px",
    padding: "4px 10px",
    fontSize: "12px",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  ".cm-button:hover": {
    backgroundColor: "var(--paper-2)",
    color: "var(--ink)",
    borderColor: "var(--rule)",
  },
  ".cm-button:active": {
    backgroundColor: "var(--paper-3)",
    backgroundImage: "none",
  },
  ".cm-button:focus-visible": {
    borderColor: "var(--accent)",
    boxShadow: "0 0 0 2px var(--accent-soft)",
    outline: "none",
  },
  ".cm-panel.cm-search [name=close]": {
    position: "absolute",
    top: "4px",
    right: "6px",
    background: "transparent",
    border: "none",
    color: "var(--ink-3)",
    fontSize: "16px",
    lineHeight: "1",
    padding: "2px 6px",
    cursor: "pointer",
  },
  ".cm-panel.cm-search [name=close]:hover": {
    color: "var(--ink)",
  },
});

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(
  function MarkdownEditor(
    {
      value,
      onChange,
      diff,
      onHunkClick,
      blame,
      blameEnabled,
      onBlameShaClick,
      plans,
      conflicted,
    },
    ref,
  ) {
    const { effective: settings } = useSettings();
    const showLineNumbers = settings.editorLineNumbers;
    const softWrap = settings.editorSoftWrap;
    const tabSize = settings.editorTabSize;

    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const viewportListenersRef = useRef<Set<(line: number) => void>>(new Set());
    const onHunkClickRef = useRef(onHunkClick);
    onHunkClickRef.current = onHunkClick;
    const onBlameShaClickRef = useRef(onBlameShaClick);
    onBlameShaClickRef.current = onBlameShaClick;
    const plansRef = useRef<Plan[]>(plans ?? []);
    plansRef.current = plans ?? [];

    // Compartments let us reconfigure individual extensions when the
    // corresponding settings change without rebuilding the whole editor.
    const lineNumbersCompartment = useRef(new Compartment());
    const wrapCompartment = useRef(new Compartment());
    const tabSizeCompartment = useRef(new Compartment());
    const changeGutterCompartment = useRef(new Compartment());
    const blameCompartment = useRef(new Compartment());
    const conflictCompartment = useRef(new Compartment());

    // biome-ignore lint/correctness/useExhaustiveDependencies: create the EditorView once; targeted effects below sync value/settings/diff/blame without dropping focus.
    useEffect(() => {
      if (!hostRef.current) return;

      const state = EditorState.create({
        doc: value,
        extensions: [
          lineNumbersCompartment.current.of(
            showLineNumbers ? lineNumbers() : [],
          ),
          changeGutterCompartment.current.of(
            diff
              ? changeGutterExtension(diff, (h) => onHunkClickRef.current?.(h))
              : [],
          ),
          blameCompartment.current.of(
            blame && blameEnabled
              ? blameExtension(blame, true, (sha) =>
                  onBlameShaClickRef.current?.(sha),
                )
              : [],
          ),
          conflictCompartment.current.of(gitConflictDecorations(!!conflicted)),
          wrapCompartment.current.of(softWrap ? EditorView.lineWrapping : []),
          tabSizeCompartment.current.of([
            EditorState.tabSize.of(tabSize),
            indentUnit.of(" ".repeat(tabSize)),
          ]),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          bracketMatching(),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          specialFenceExtension(),
          syntaxHighlighting(markdownHighlighting),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          atMentionExtension(() => plansRef.current),
          search({ top: true }),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          editorTheme,
          EditorView.contentAttributes.of({ "aria-label": "Markdown editor" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      });

      const view = new EditorView({ state, parent: hostRef.current });
      viewRef.current = view;

      // Native scroll listener for split-view scroll sync. CM's
      // updateListener doesn't reliably fire on pure mouse-wheel scrolls
      // (no transaction), so we hook the scroller directly.
      const onScroll = () => {
        if (viewportListenersRef.current.size === 0) return;
        const scrollTop = view.scrollDOM.scrollTop;
        const block = view.lineBlockAtHeight(scrollTop);
        const intLine = view.state.doc.lineAt(block.from).number;
        // Fractional line: how far down inside the current line block
        // the viewport top sits. Adds the precision needed for smooth
        // scroll-sync interpolation between headings.
        const fractional =
          block.height > 0
            ? Math.max(0, Math.min(1, (scrollTop - block.top) / block.height))
            : 0;
        const line = intLine + fractional;
        for (const cb of viewportListenersRef.current) cb(line);
      };
      view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
      // CodeMirror auto-measures on container resize, but only when its
      // own ResizeObserver fires. In a CSS grid where the column shrinks
      // (split → preview-narrow), force a re-measure so wrap reflows
      // immediately rather than at the next user interaction.
      const ro = new ResizeObserver(() => view.requestMeasure());
      if (hostRef.current) ro.observe(hostRef.current);

      return () => {
        view.scrollDOM.removeEventListener("scroll", onScroll);
        ro.disconnect();
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    // Live-reconfigure extensions when settings change.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: lineNumbersCompartment.current.reconfigure(
          showLineNumbers ? lineNumbers() : [],
        ),
      });
    }, [showLineNumbers]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.current.reconfigure(
          softWrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [softWrap]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: tabSizeCompartment.current.reconfigure([
          EditorState.tabSize.of(tabSize),
          indentUnit.of(" ".repeat(tabSize)),
        ]),
      });
    }, [tabSize]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: changeGutterCompartment.current.reconfigure(
          diff
            ? changeGutterExtension(diff, (h) => onHunkClickRef.current?.(h))
            : [],
        ),
      });
    }, [diff]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: conflictCompartment.current.reconfigure(
          gitConflictDecorations(!!conflicted),
        ),
      });
    }, [conflicted]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: blameCompartment.current.reconfigure(
          blame && blameEnabled
            ? blameExtension(blame, true, (sha) =>
                onBlameShaClickRef.current?.(sha),
              )
            : [],
        ),
      });
    }, [blame, blameEnabled]);

    // Sync external `value` changes (e.g. switching plans) into the editor.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }, [value]);

    useImperativeHandle(
      ref,
      () => ({
        revealLine(line) {
          const view = viewRef.current;
          if (!view) return;
          const doc = view.state.doc;
          if (line < 1 || line > doc.lines) return;
          const pos = doc.line(line).from;
          view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "center" }),
          });
          view.focus();
        },
        currentLine() {
          const view = viewRef.current;
          if (!view) return 1;
          return view.state.doc.lineAt(view.state.selection.main.head).number;
        },
        scrollToLine(line, options) {
          const view = viewRef.current;
          if (!view) return;
          const doc = view.state.doc;
          if (line < 1 || line > doc.lines) return;
          const lineInfo = doc.line(line);
          let cursorPos = lineInfo.from;
          if (options?.placeCursor === "afterTaskMarker") {
            // Match GFM task list markers: `- [ ]`, `- [x]`, `* [ ]`,
            // `+ [X]`, with optional leading whitespace and a trailing
            // space the cursor lands after.
            const m = /^(\s*[-*+]\s+\[[ xX]\]\s)/.exec(lineInfo.text);
            if (m) cursorPos = lineInfo.from + m[0].length;
          }
          view.dispatch({
            selection: { anchor: cursorPos },
            effects: EditorView.scrollIntoView(cursorPos, {
              y: "start",
              yMargin: 24,
            }),
          });
        },
        topVisibleLine() {
          const view = viewRef.current;
          if (!view) return 1;
          const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
          return view.state.doc.lineAt(topPos).number;
        },
        totalLines() {
          return viewRef.current?.state.doc.lines ?? 1;
        },
        topLineAtMaxScroll() {
          const view = viewRef.current;
          if (!view) return 1;
          const scroller = view.scrollDOM;
          const maxTop = Math.max(
            0,
            scroller.scrollHeight - scroller.clientHeight,
          );
          const block = view.lineBlockAtHeight(maxTop);
          const intLine = view.state.doc.lineAt(block.from).number;
          const frac =
            block.height > 0 ? (maxTop - block.top) / block.height : 0;
          return intLine + Math.max(0, Math.min(1, frac));
        },
        scrollToFractionalLine(line) {
          const view = viewRef.current;
          if (!view) return;
          const totalLines = view.state.doc.lines;
          const clamped = Math.max(1, Math.min(totalLines, line));
          const intLine = Math.floor(clamped);
          const frac = clamped - intLine;
          const pos = view.state.doc.line(intLine).from;
          const block = view.lineBlockAt(pos);
          view.scrollDOM.scrollTop = block.top + frac * block.height;
        },
        onViewportChange(cb) {
          viewportListenersRef.current.add(cb);
          return () => {
            viewportListenersRef.current.delete(cb);
          };
        },
        focus() {
          viewRef.current?.focus();
        },
      }),
      [],
    );

    return <div className="md-editor" ref={hostRef} />;
  },
);
