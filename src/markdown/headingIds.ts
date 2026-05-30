import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { slugify } from "./slugify";

/** Walks `root.children` in document order and assigns each heading a
 *  unique id, suffixing collisions with `-2`, `-3`, etc. Both
 *  `extractOutline` (the right-pane source of truth) and the Reader's
 *  rendered headings call this so a click on the second `Deliverables`
 *  in the outline lands on the second `<h?>` rather than the first.
 *
 *  Keyed by 1-based source line — stable within a parse, and the
 *  outline tracks the same line, so map lookups line up. */
export function assignHeadingIds(root: Root): Map<number, string> {
  const map = new Map<number, string>();
  const used = new Set<string>();
  let fallbackLine = 0;
  for (const node of root.children) {
    if (node.type !== "heading") continue;
    const text = mdastToString(node);
    const base = slugify(text) || "section";
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n++;
    }
    used.add(id);
    const line = node.position?.start.line ?? ++fallbackLine;
    map.set(line, id);
  }
  return map;
}
