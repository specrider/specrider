import type { List, ListItem, Paragraph, Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import type { OutlineListItem, OutlineNode, OutlineTask } from "../types";
import { assignHeadingIds } from "./headingIds";

interface FlatHeading {
  /** 1–3, matching the source heading depth. */
  depth: 1 | 2 | 3;
  text: string;
  id: string;
  start: number;
  /** 1-based source line of the heading. */
  startLine: number;
}

/**
 * Walks the mdast Root and produces the right-pane outline tree.
 *
 * h1/h2/h3 all become outline entries. h1 and h2 share depth 1 (same
 * visual treatment, top-level siblings) so an H1 doesn't shrink/indent
 * the rest of the outline; h3 stays at depth 2, nested under its
 * preceding h2 (or h1 if no h2 came first). h4+ are silently ignored.
 *
 * Per-section task counts are *rolled up*: a heading's taskTotal includes
 * tasks in its own paragraphs plus tasks in every descendant heading's
 * section. The `tasks` array on each node, in contrast, contains *only*
 * the tasks directly under that heading (between it and the next heading
 * at any depth) — used for nested display in the outline pane.
 *
 */
export function extractOutline(root: Root): OutlineNode[] {
  const headingIds = assignHeadingIds(root);
  const flat: FlatHeading[] = [];
  for (let i = 0; i < root.children.length; i++) {
    const node = root.children[i];
    if (node.type === "heading" && node.depth >= 1 && node.depth <= 3) {
      const text = mdastToString(node);
      const startLine = node.position?.start.line ?? 0;
      flat.push({
        depth: node.depth as 1 | 2 | 3,
        text,
        id: headingIds.get(startLine) ?? `heading-${i}`,
        start: i,
        startLine,
      });
    }
  }

  // Generous EOF marker — any change beyond the last node still
  // intersects the trailing section.
  const docEndLine = (root.position?.end.line ?? Number.MAX_SAFE_INTEGER) + 1;

  const endOfSection = (idx: number, depth: 1 | 2 | 3): number => {
    for (let j = idx + 1; j < flat.length; j++) {
      if (flat[j].depth <= depth) return flat[j].start;
    }
    return root.children.length;
  };

  const endLineOfSection = (idx: number, depth: 1 | 2 | 3): number => {
    for (let j = idx + 1; j < flat.length; j++) {
      if (flat[j].depth <= depth) return flat[j].startLine;
    }
    return docEndLine;
  };

  const endOfImmediate = (idx: number): number => {
    if (idx + 1 < flat.length) return flat[idx + 1].start;
    return root.children.length;
  };

  const endLineOfImmediate = (idx: number): number => {
    if (idx + 1 < flat.length) return flat[idx + 1].startLine;
    return docEndLine;
  };

  const resolveDone = (item: ListItem): boolean => !!item.checked;

  // Tasks are collected and counted recursively so a checkbox nested
  // inside another checkbox still rolls into the heading's totals and
  // gets a row in the outline. Depth is incremented only when we
  // descend into a child list whose parent listItem itself was a task,
  // so a task with a nested non-task bullet list keeps its sub-tasks
  // (if any) at the right indent.
  const countTasksInList = (
    list: List,
    acc: { done: number; total: number },
  ) => {
    for (const child of list.children) {
      if (child.type !== "listItem") continue;
      const item = child as ListItem;
      if (typeof item.checked === "boolean") {
        acc.total++;
        if (resolveDone(item)) acc.done++;
      }
      for (const grand of item.children) {
        if (grand.type === "list") countTasksInList(grand as List, acc);
      }
    }
  };

  const countTasksInRange = (
    startIdx: number,
    endIdx: number,
  ): { done: number; total: number } => {
    const acc = { done: 0, total: 0 };
    for (let i = startIdx; i < endIdx; i++) {
      const node = root.children[i];
      if (node.type === "list") countTasksInList(node as List, acc);
    }
    return acc;
  };

  const collectTasksInList = (
    list: List,
    depth: number,
    out: OutlineTask[],
  ) => {
    for (const child of list.children) {
      if (child.type !== "listItem") continue;
      const item = child as ListItem;
      const isTask = typeof item.checked === "boolean";
      if (isTask) {
        const line = item.position?.start.line ?? -1;
        out.push({
          line,
          text: listItemPlainText(item),
          done: resolveDone(item),
          depth,
        });
      }
      for (const grand of item.children) {
        if (grand.type === "list") {
          collectTasksInList(grand as List, isTask ? depth + 1 : depth, out);
        }
      }
    }
  };

  const collectTasksInRange = (
    startIdx: number,
    endIdx: number,
  ): OutlineTask[] => {
    const out: OutlineTask[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      const node = root.children[i];
      if (node.type === "list") collectTasksInList(node as List, 0, out);
    }
    return out;
  };

  // Top-level only; nested lists make the outline noisy. A `1. [ ] foo`
  // GFM-numbered task is classified as a task,
  // not a numbered list entry; the checkbox is the load-bearing
  // semantics, so it goes into `tasks` and is skipped here.
  const collectListsInRange = (
    startIdx: number,
    endIdx: number,
  ): OutlineListItem[] => {
    const out: OutlineListItem[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      const node = root.children[i];
      if (node.type !== "list") continue;
      const list = node as List;
      const kind: "numbered" | "bulleted" = list.ordered
        ? "numbered"
        : "bulleted";
      let ordinal = list.start ?? 1;
      for (const child of list.children) {
        if (child.type !== "listItem") continue;
        const item = child as ListItem;
        const isTask = typeof item.checked === "boolean";
        if (isTask) {
          if (list.ordered) ordinal++;
          continue;
        }
        const line = item.position?.start.line ?? -1;
        const marker = list.ordered ? `${ordinal}.` : "-";
        out.push({
          line,
          text: listItemPlainText(item),
          kind,
          marker,
        });
        if (list.ordered) ordinal++;
      }
    }
    return out;
  };

  const tree: OutlineNode[] = [];
  let currentTop: OutlineNode | null = null;

  flat.forEach((h, idx) => {
    const immediateEnd = endOfImmediate(idx);
    // H1 + H2 are visual siblings, so an H1's "section" is just the
    // intro area between it and the next heading — otherwise its rollup
    // would re-count every task in every following H2 section and
    // double the totals.
    const sectionEnd =
      h.depth === 1 ? immediateEnd : endOfSection(idx, h.depth);
    const sectionEndLine =
      h.depth === 1 ? endLineOfImmediate(idx) : endLineOfSection(idx, h.depth);
    const counts = countTasksInRange(h.start + 1, sectionEnd);
    const tasks = collectTasksInRange(h.start + 1, immediateEnd);
    const lists = collectListsInRange(h.start + 1, immediateEnd);
    // h1 + h2 share depth 1 (same visual treatment as siblings); h3
    // gets depth 2 and nests under whichever top-level heading came
    // last.
    const visualDepth: 1 | 2 = h.depth === 3 ? 2 : 1;
    const node: OutlineNode = {
      id: h.id,
      text: h.text,
      depth: visualDepth,
      line: h.startLine,
      endLine: sectionEndLine,
      taskDone: counts.done,
      taskTotal: counts.total,
      tasks,
      lists,
      children: [],
    };
    if (h.depth === 1 || h.depth === 2) {
      tree.push(node);
      currentTop = node;
    } else if (currentTop) {
      currentTop.children.push(node);
    } else {
      tree.push(node);
    }
  });

  return tree;
}

function listItemPlainText(item: ListItem): string {
  const firstPara = item.children.find((c) => c.type === "paragraph") as
    | Paragraph
    | undefined;
  if (firstPara) return mdastToString(firstPara);
  return mdastToString(item);
}

export function totalProgress(outline: OutlineNode[]): {
  done: number;
  total: number;
} {
  let done = 0;
  let total = 0;
  for (const n of outline) {
    done += n.taskDone;
    total += n.taskTotal;
  }
  return { done, total };
}
