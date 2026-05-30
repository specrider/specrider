/** Pure source-rewriters for the three reader-driven task gestures:
 *  insert after, remove subtree, move subtree. Extracted from App.tsx
 *  so the line-arithmetic is unit-testable without mounting React or
 *  driving a pointer event.
 *
 *  Every function takes a markdown source string and returns the
 *  next source string. They never throw; on invalid input they
 *  return `source` unchanged so callers can treat them as no-ops. */

/** Inserts a new empty task as the next sibling of the task at
 *  `startLine`, immediately after its subtree (i.e. after `endLine`).
 *  The new task inherits the original's indent and bullet marker. */
export function insertTaskAfter(
  source: string,
  startLine: number,
  endLine: number,
): { next: string; newTaskLine: number } | null {
  const lines = source.split("\n");
  const srcIdx = startLine - 1;
  if (srcIdx < 0 || srcIdx >= lines.length) return null;
  if (endLine < startLine || endLine > lines.length) return null;
  const m = lines[srcIdx].match(/^(\s*)([-*+])(\s+)\[[ xX]\]/);
  if (!m) return null;
  const [, indent, marker, sep] = m;
  const newLine = `${indent}${marker}${sep}[ ] `;
  lines.splice(endLine, 0, newLine);
  return { next: lines.join("\n"), newTaskLine: endLine + 1 };
}

/** Removes the inclusive `[startLine, endLine]` range from `source`.
 *  Returns the original string when the range is invalid or empty. */
export function removeTaskBlock(
  source: string,
  startLine: number,
  endLine: number,
): string {
  const lines = source.split("\n");
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    return source;
  }
  lines.splice(startLine - 1, endLine - startLine + 1);
  const next = lines.join("\n");
  return next === source ? source : next;
}

/** Moves the inclusive `[fromStart, fromEnd]` range to before/after
 *  `anchorLine`, optionally re-indenting the moved subtree to a new
 *  leading-space count. Returns the original `source` for any no-op
 *  (anchor inside the moved range, identical result, invalid input). */
export function moveTaskBlock(
  source: string,
  fromStart: number,
  fromEnd: number,
  anchorLine: number,
  position: "before" | "after",
  newIndent: number,
): string {
  const lines = source.split("\n");
  if (
    fromStart < 1 ||
    fromEnd < fromStart ||
    fromEnd > lines.length ||
    anchorLine < 1 ||
    anchorLine > lines.length
  ) {
    return source;
  }
  // Anchor inside the moved range is a no-op — the user can't drop a
  // subtree inside itself.
  if (anchorLine >= fromStart && anchorLine <= fromEnd) return source;

  const moved = lines.slice(fromStart - 1, fromEnd);
  const oldIndent = moved[0].match(/^( *)/)?.[1].length ?? 0;
  const targetIndent = Math.max(0, newIndent);
  const delta = targetIndent - oldIndent;
  const reindented =
    delta === 0
      ? moved
      : moved.map((line) => {
          if (line.length === 0) return line;
          if (delta > 0) return " ".repeat(delta) + line;
          // Outdent: strip up to |delta| leading spaces, but never
          // turn a non-blank into an empty string.
          let strip = 0;
          while (strip < -delta && strip < line.length && line[strip] === " ") {
            strip++;
          }
          return line.slice(strip);
        });

  const removed = lines.splice(fromStart - 1, fromEnd - fromStart + 1);
  if (removed.length === 0) return source;
  const removedLen = removed.length;
  // Anchor lines reference the pre-splice array; map to the mutated
  // array's index.
  let anchorIdx =
    anchorLine < fromStart ? anchorLine - 1 : anchorLine - 1 - removedLen;
  if (position === "after") anchorIdx += 1;
  anchorIdx = Math.max(0, Math.min(lines.length, anchorIdx));
  lines.splice(anchorIdx, 0, ...reindented);

  const next = lines.join("\n");
  return next === source ? source : next;
}
