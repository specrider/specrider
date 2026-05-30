import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = `specrider.collapsedSections.v1.${getCurrentWindow().label}`;

type StoredMap = Record<string, string[]>;

function loadStored(): StoredMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStored(map: StoredMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private browsing */
  }
}

export interface CollapsedSections {
  collapsed: Set<string>;
  /** Toggle a single heading's collapse state. */
  toggle: (id: string) => void;
  /** Ensure these heading ids are NOT in the collapsed set. */
  expandIds: (ids: string[]) => void;
  /** Add every id to the collapsed set. */
  collapseAll: (ids: string[]) => void;
  /** Clear the collapsed set entirely. */
  expandAll: () => void;
}

/** Owns per-plan collapsed-section state with localStorage sync. The
 *  set is keyed by the (already disambiguated) heading id from
 *  `assignHeadingIds`, so a click on an outline row matches exactly
 *  the heading rendered in the reader. */
export function useCollapsedSections(
  planPath: string | null,
): CollapsedSections {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (!planPath) return new Set();
    return new Set(loadStored()[planPath] ?? []);
  });

  // Reload when the plan changes — each plan keeps its own fold state.
  useEffect(() => {
    if (!planPath) {
      setCollapsed(new Set());
      return;
    }
    setCollapsed(new Set(loadStored()[planPath] ?? []));
  }, [planPath]);

  const persist = useCallback(
    (next: Set<string>) => {
      if (!planPath) return;
      const map = loadStored();
      if (next.size === 0) {
        delete map[planPath];
      } else {
        map[planPath] = [...next];
      }
      saveStored(map);
    },
    [planPath],
  );

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const expandIds = useCallback(
    (ids: string[]) => {
      setCollapsed((prev) => {
        let dirty = false;
        const next = new Set(prev);
        for (const id of ids) {
          if (next.delete(id)) dirty = true;
        }
        if (!dirty) return prev;
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const collapseAll = useCallback(
    (ids: string[]) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const expandAll = useCallback(() => {
    setCollapsed((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      persist(next);
      return next;
    });
  }, [persist]);

  return { collapsed, toggle, expandIds, collapseAll, expandAll };
}
