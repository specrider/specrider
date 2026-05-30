import type { Root } from "mdast";
import { useCallback, useMemo, useState } from "react";
import {
  type CollapsedSections,
  useCollapsedSections,
} from "../hooks/useCollapsedSections";
import { assignHeadingIds } from "../markdown/headingIds";

export interface HeadingEntry {
  id: string;
  depth: number;
}

interface OutlineState {
  ancestorChain: (targetId: string) => string[];
  collapseHook: CollapsedSections;
  enclosingHeadingId: (line: number) => string | null;
  headingHierarchy: HeadingEntry[];
  headingIdMap: Map<number, string>;
  taskCollapsed: Set<number>;
  toggleTaskCollapse: (line: number) => void;
}

export function useOutlineState(activeId: string, ast: Root): OutlineState {
  const headingIdMap = useMemo(() => assignHeadingIds(ast), [ast]);
  const headingHierarchy = useMemo(() => {
    const out: HeadingEntry[] = [];
    for (const node of ast.children) {
      if (node.type !== "heading") continue;
      if (node.depth < 1 || node.depth > 3) continue;
      const line = node.position?.start.line ?? 0;
      const id = headingIdMap.get(line);
      if (id) out.push({ id, depth: node.depth });
    }
    return out;
  }, [ast, headingIdMap]);
  const collapseHook = useCollapsedSections(activeId || null);
  const [taskCollapseState, setTaskCollapseState] = useState<{
    activeId: string;
    collapsed: Set<number>;
  }>(() => ({ activeId, collapsed: new Set() }));
  const taskCollapsed =
    taskCollapseState.activeId === activeId
      ? taskCollapseState.collapsed
      : new Set<number>();

  const toggleTaskCollapse = useCallback(
    (line: number) => {
      setTaskCollapseState((prev) => {
        const next = new Set(prev.activeId === activeId ? prev.collapsed : []);
        if (next.has(line)) next.delete(line);
        else next.add(line);
        return { activeId, collapsed: next };
      });
    },
    [activeId],
  );

  const ancestorChain = useCallback(
    (targetId: string): string[] => {
      const idx = headingHierarchy.findIndex((h) => h.id === targetId);
      if (idx < 0) return [];
      const chain: string[] = [targetId];
      let need = headingHierarchy[idx].depth - 1;
      for (let i = idx - 1; i >= 0 && need >= 1; i--) {
        if (headingHierarchy[i].depth <= need) {
          chain.push(headingHierarchy[i].id);
          need = headingHierarchy[i].depth - 1;
        }
      }
      return chain;
    },
    [headingHierarchy],
  );

  const enclosingHeadingId = useCallback(
    (line: number): string | null => {
      let bestId: string | null = null;
      let bestLine = -1;
      for (const node of ast.children) {
        if (node.type !== "heading") continue;
        const hLine = node.position?.start.line ?? 0;
        if (hLine <= line && hLine > bestLine) {
          const id = headingIdMap.get(hLine);
          if (id) {
            bestId = id;
            bestLine = hLine;
          }
        }
      }
      return bestId;
    },
    [ast, headingIdMap],
  );

  return {
    ancestorChain,
    collapseHook,
    enclosingHeadingId,
    headingHierarchy,
    headingIdMap,
    taskCollapsed,
    toggleTaskCollapse,
  };
}
