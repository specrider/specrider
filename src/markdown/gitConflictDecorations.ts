// Git conflict marker decoration for the Markdown editor. Highlights
// the three sides of a conflict block visually and renders an inline
// `[Keep ours] [Keep theirs] [Keep both]` action chip above each block.
//
// Operates on the buffer regex-style — when extraction fails (the
// regex doesn't match cleanly), we hide the chip rather than guessing.
// The text replacement is a single Transaction against the matched
// range so undo behaves naturally.

import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export interface ConflictBlock {
  // Buffer offsets.
  blockStart: number;
  blockEnd: number;
  // Line numbers (1-based) for decoration ranges.
  oursStartLine: number;
  oursEndLine: number;
  theirsStartLine: number;
  theirsEndLine: number;
  // The three text segments (no markers).
  oursText: string;
  theirsText: string;
}

const MARKER_RE = /^<{7}\s+(.*)$/m;
const MID_RE = /^={7}\s*$/m;
const END_RE = /^>{7}\s+(.*)$/m;

/** Walks the doc text and returns every well-formed conflict block.
 *  A block is `<<<<<<<` … `=======` … `>>>>>>>` on three separate
 *  lines. Malformed blocks are skipped silently. */
export function findConflictBlocks(doc: string): ConflictBlock[] {
  const out: ConflictBlock[] = [];
  const lines = doc.split("\n");
  let i = 0;
  let offset = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (MARKER_RE.test(line)) {
      const startLine = i + 1; // 1-based for CM
      const blockStart = offset;
      // Find the divider.
      let j = i + 1;
      let mid = -1;
      let end = -1;
      let cur = offset + line.length + 1;
      const oursStart = cur;
      while (j < lines.length) {
        if (MID_RE.test(lines[j])) {
          mid = j;
          break;
        }
        if (MARKER_RE.test(lines[j])) {
          // Nested or restart — abort this block.
          break;
        }
        cur += lines[j].length + 1;
        j++;
      }
      if (mid === -1) {
        offset += line.length + 1;
        i++;
        continue;
      }
      const oursEnd = cur;
      cur += lines[mid].length + 1; // skip "======="
      const theirsStart = cur;
      let k = mid + 1;
      while (k < lines.length) {
        if (END_RE.test(lines[k])) {
          end = k;
          break;
        }
        if (MARKER_RE.test(lines[k]) || MID_RE.test(lines[k])) {
          break;
        }
        cur += lines[k].length + 1;
        k++;
      }
      if (end === -1) {
        offset += line.length + 1;
        i++;
        continue;
      }
      const theirsEnd = cur;
      const blockEnd = cur + lines[end].length;
      out.push({
        blockStart,
        blockEnd,
        oursStartLine: startLine,
        oursEndLine: mid,
        theirsStartLine: mid + 2,
        theirsEndLine: end,
        oursText: doc.slice(oursStart, oursEnd),
        theirsText: doc.slice(theirsStart, theirsEnd),
      });
      // Advance past the conflict block.
      i = end + 1;
      offset = blockEnd + 1;
      continue;
    }
    offset += line.length + 1;
    i++;
  }
  return out;
}

class ConflictActionsWidget extends WidgetType {
  constructor(
    private readonly block: ConflictBlock,
    private readonly view: EditorView,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-conflict-actions";
    const label = document.createElement("span");
    label.textContent = "Conflict:";
    label.style.color = "var(--ink-3)";
    label.style.marginRight = "4px";
    root.appendChild(label);
    const make = (text: string, replacement: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.view.dispatch({
          changes: {
            from: this.block.blockStart,
            to: this.block.blockEnd,
            insert: replacement,
          },
        });
      });
      return b;
    };
    root.appendChild(make("Keep ours", this.block.oursText.replace(/\n$/, "")));
    root.appendChild(
      make("Keep theirs", this.block.theirsText.replace(/\n$/, "")),
    );
    root.appendChild(
      make(
        "Keep both",
        (this.block.oursText + this.block.theirsText).replace(/\n+$/, ""),
      ),
    );
    return root;
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof ConflictActionsWidget &&
      other.block.blockStart === this.block.blockStart &&
      other.block.blockEnd === this.block.blockEnd
    );
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const blocks = findConflictBlocks(text);
  if (blocks.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of blocks) {
    // Widget above the conflict block — fire on the start line.
    const startPos = view.state.doc.line(block.oursStartLine).from;
    builder.add(
      startPos,
      startPos,
      Decoration.widget({
        widget: new ConflictActionsWidget(block, view),
        side: -1,
        block: true,
      }),
    );
    // Marker line decoration (the "<<<<<<<" / "=======" / ">>>>>>>" lines).
    builder.add(
      view.state.doc.line(block.oursStartLine).from,
      view.state.doc.line(block.oursStartLine).from,
      Decoration.line({ class: "cm-conflict-marker" }),
    );
    builder.add(
      view.state.doc.line(block.oursEndLine + 1).from,
      view.state.doc.line(block.oursEndLine + 1).from,
      Decoration.line({ class: "cm-conflict-marker" }),
    );
    builder.add(
      view.state.doc.line(block.theirsEndLine + 1).from,
      view.state.doc.line(block.theirsEndLine + 1).from,
      Decoration.line({ class: "cm-conflict-marker" }),
    );
    // Body decorations — "ours" lines and "theirs" lines.
    for (let ln = block.oursStartLine + 1; ln <= block.oursEndLine; ln++) {
      builder.add(
        view.state.doc.line(ln).from,
        view.state.doc.line(ln).from,
        Decoration.line({ class: "cm-conflict-ours" }),
      );
    }
    for (let ln = block.theirsStartLine; ln <= block.theirsEndLine; ln++) {
      builder.add(
        view.state.doc.line(ln).from,
        view.state.doc.line(ln).from,
        Decoration.line({ class: "cm-conflict-theirs" }),
      );
    }
  }
  return builder.finish();
}

function scheduleIdleScan(run: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout?: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    const handle = w.requestIdleCallback(run, { timeout: 250 });
    return () => w.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(run, 250);
  return () => window.clearTimeout(handle);
}

/** Conditionally-loaded extension: pass `enabled = true` only when
 *  the active plan is conflicted (per `git_status.conflicts`). When
 *  disabled the entire decoration pipeline is a no-op. */
export function gitConflictDecorations(enabled: boolean): Extension {
  if (!enabled) return [];
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private cancelPendingScan: (() => void) | null = null;
      private destroyed = false;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        this.decorations = this.decorations.map(u.changes);
        this.cancelPendingScan?.();
        this.cancelPendingScan = scheduleIdleScan(() => {
          this.cancelPendingScan = null;
          if (this.destroyed) return;
          this.decorations = buildDecorations(u.view);
          u.view.dispatch({});
        });
      }

      destroy() {
        this.destroyed = true;
        this.cancelPendingScan?.();
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
