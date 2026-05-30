import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { formatRelativeTime } from "../lib/time";
import type { BlameLine, BlameSet, ChangeSet, Hunk } from "../tauri/api";

type ChangeKind = "added" | "modified" | "deleted-after";

class ChangeMarker extends GutterMarker {
  constructor(public readonly kind: ChangeKind) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-change-bar ${this.kind}`;
    return el;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind;
  }
}

const ADDED = new ChangeMarker("added");
const MODIFIED = new ChangeMarker("modified");
const DELETED_AFTER = new ChangeMarker("deleted-after");

/** Returns the hunk that owns a given working-tree line, or null. A
 *  hunk "owns" a line when the line falls inside its `[newStart,
 *  newStart + newLines)` range, or — for pure deletions — equals
 *  `newStart` (the line *after which* the deletion sits). */
export function hunkAtLine(diff: ChangeSet, lineNumber: number): Hunk | null {
  for (const h of diff.hunks) {
    if (h.newLines === 0) {
      if (h.newStart === lineNumber) return h;
    } else if (
      lineNumber >= h.newStart &&
      lineNumber < h.newStart + h.newLines
    ) {
      return h;
    }
  }
  return null;
}

/** Sorted list of newStart line numbers across all hunks — used to
 *  drive next/prev-hunk navigation. */
export function hunkStartLines(diff: ChangeSet): number[] {
  return diff.hunks
    .map((h) => h.newStart)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
}

/** CodeMirror gutter that paints a thin colored bar next to every
 *  changed line. Compartment-managed in MarkdownEditor so swapping the
 *  diff doesn't rebuild the whole editor. */
export function changeGutterExtension(
  diff: ChangeSet,
  onHunkClick?: (hunk: Hunk) => void,
): Extension {
  const added = new Set(diff.added);
  const modified = new Set(diff.modified);
  const deletedAfter = new Set(diff.deletedAfter);
  const empty =
    added.size === 0 && modified.size === 0 && deletedAfter.size === 0;
  if (empty) return [];

  return [
    gutter({
      class: "cm-change-gutter",
      lineMarker(view, line) {
        const ln = view.state.doc.lineAt(line.from).number;
        if (added.has(ln)) return ADDED;
        if (modified.has(ln)) return MODIFIED;
        if (deletedAfter.has(ln)) return DELETED_AFTER;
        return null;
      },
      domEventHandlers: {
        mousedown: (view, line) => {
          if (!onHunkClick) return false;
          const ln = view.state.doc.lineAt(line.from).number;
          const hunk = hunkAtLine(diff, ln);
          if (!hunk) return false;
          onHunkClick(hunk);
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      ".cm-change-gutter": {
        width: "3px",
        padding: "0",
        backgroundColor: "transparent",
        borderRight: "none",
      },
      ".cm-change-gutter .cm-gutterElement": {
        padding: "0",
      },
      ".cm-change-bar": {
        width: "3px",
        height: "100%",
        cursor: "pointer",
      },
      ".cm-change-bar.added": { backgroundColor: "var(--sage)" },
      ".cm-change-bar.modified": { backgroundColor: "var(--amber)" },
      ".cm-change-bar.deleted-after": {
        backgroundColor: "transparent",
        borderTop: "2px solid var(--rose)",
        height: "0",
        marginTop: "-1px",
      },
    }),
  ];
}

// ─── Fenced-block cues (mermaid / math) ─────────────────────────────

/** Visual marker for the body of `mermaid` and `math` fenced blocks
 *  in the source editor. The renderer turns these into SVG diagrams /
 *  KaTeX output; a class on the editor's fence body is enough so the
 *  source pane reads as a special block instead of generic code. */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?\s*$/;

export function specialFenceExtension(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet = Decoration.none;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged) {
            this.decorations = build(u.view);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.baseTheme({
      ".cm-line.cm-fence-mermaid": {
        backgroundColor: "var(--paper-2, rgba(127, 127, 127, 0.06))",
      },
      ".cm-line.cm-fence-math": {
        backgroundColor: "var(--paper-2, rgba(127, 127, 127, 0.06))",
        fontStyle: "italic",
      },
    }),
  ];
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Walk the entire doc once. Fences are uncommon enough that this is
  // cheap; doing it incrementally would mean tracking open-fence state
  // across viewport boundaries — not worth the complexity for the
  // visual-only cue this provides.
  const doc = view.state.doc;
  const total = doc.lines;
  let inside: {
    kind: "mermaid" | "math";
    marker: string;
    indent: string;
  } | null = null;
  for (let i = 1; i <= total; i++) {
    const line = doc.line(i);
    const text = line.text;
    if (inside) {
      const closeRe = new RegExp(
        `^${escapeRegex(inside.indent)}${escapeRegex(inside.marker)}\\s*$`,
      );
      if (closeRe.test(text)) {
        inside = null;
        continue;
      }
      const cls =
        inside.kind === "mermaid" ? "cm-fence-mermaid" : "cm-fence-math";
      builder.add(line.from, line.from, Decoration.line({ class: cls }));
      continue;
    }
    const match = text.match(FENCE_RE);
    if (!match) continue;
    const indent = match[1];
    const marker = match[2];
    const lang = (match[3] ?? "").toLowerCase();
    if (lang === "mermaid") {
      inside = { kind: "mermaid", marker, indent };
    } else if (lang === "math") {
      inside = { kind: "math", marker, indent };
    }
  }
  return builder.finish();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Blame annotation ────────────────────────────────────────────────

class BlameWidget extends WidgetType {
  constructor(
    public readonly text: string,
    public readonly uncommitted: boolean,
    public readonly sha: string,
    public readonly onClick?: (sha: string) => void,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `cm-blame-annotation${
      this.uncommitted ? " uncommitted" : ""
    }${this.sha ? " clickable" : ""}`;
    el.textContent = this.text;
    if (this.sha && this.onClick) {
      const handler = this.onClick;
      const sha = this.sha;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler(sha);
      });
    }
    return el;
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof BlameWidget &&
      other.text === this.text &&
      other.uncommitted === this.uncommitted &&
      other.sha === this.sha
    );
  }
  ignoreEvent() {
    return false;
  }
}

export function formatBlame(line: BlameLine): string {
  if (line.uncommitted) return "(working tree)";
  return `${line.sha} · ${line.author} · ${formatRelativeTime(
    line.authorTime,
  )} — ${line.summary}`;
}

/** End-of-line blame annotation that follows the cursor. Renders only
 *  on the active line so the editor doesn't paint a blizzard of
 *  annotations. Clicking the annotation invokes `onShaClick` (intended
 *  to open the commit popover); uncommitted lines render
 *  `(working tree)` and are non-clickable. */
export function blameExtension(
  blame: BlameSet,
  enabled: boolean,
  onShaClick?: (sha: string) => void,
): Extension {
  if (!enabled || blame.lines.length === 0) return [];

  const byLine = new Map<number, BlameLine>();
  for (const l of blame.lines) byLine.set(l.line, l);

  return [
    EditorView.baseTheme({
      ".cm-blame-annotation": {
        marginLeft: "16px",
        color: "var(--ink-4)",
        fontSize: "0.85em",
        fontFamily: "var(--font-mono)",
        opacity: "0.75",
        userSelect: "none",
        whiteSpace: "nowrap",
      },
      ".cm-blame-annotation.uncommitted": {
        fontStyle: "italic",
        opacity: "0.55",
      },
      ".cm-blame-annotation.clickable": {
        cursor: "pointer",
      },
      ".cm-blame-annotation.clickable:hover": {
        opacity: "1",
        color: "var(--ink-2)",
      },
    }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet = Decoration.none;
        activeLine = -1;

        constructor(view: EditorView) {
          this.refresh(view);
        }

        update(u: ViewUpdate) {
          if (u.selectionSet || u.docChanged || u.viewportChanged) {
            this.refresh(u.view);
          }
        }

        refresh(view: EditorView) {
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head).number;
          if (
            line === this.activeLine &&
            this.decorations !== Decoration.none
          ) {
            return;
          }
          this.activeLine = line;
          this.decorations = this.buildDeco(view, line);
        }

        buildDeco(view: EditorView, lineNumber: number): DecorationSet {
          const blameLine = byLine.get(lineNumber);
          if (!blameLine) return Decoration.none;
          const lineEnd = view.state.doc.line(lineNumber).to;
          const widget = Decoration.widget({
            widget: new BlameWidget(
              formatBlame(blameLine),
              blameLine.uncommitted,
              blameLine.sha,
              onShaClick,
            ),
            side: 1,
          }).range(lineEnd);
          return Decoration.set([widget]);
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
