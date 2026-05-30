import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getPins,
  onPinsChanged,
  onPlansRootChanged,
  type PinnedPlan,
  type PinnedSection,
  type Pins,
  togglePlanPin,
  toggleSectionPin,
} from "../tauri/api";

const EMPTY_PINS: Pins = { plans: [], sections: {} };

interface PinsContextValue {
  pins: Pins;
  loaded: boolean;
  /** Pinned plans, ordered most-recently-pinned first. */
  pinnedPlans: PinnedPlan[];
  /** Pinned sections for `planPath`, most-recent first. */
  pinnedSections: (planPath: string) => PinnedSection[];
  isPlanPinned: (planPath: string) => boolean;
  isSectionPinned: (planPath: string, headingId: string) => boolean;
  togglePlan: (planPath: string) => Promise<boolean>;
  toggleSection: (
    planPath: string,
    headingId: string,
    headingText: string,
  ) => Promise<boolean>;
}

const PinsContext = createContext<PinsContextValue | null>(null);

export function PinsProvider({ children }: { children: ReactNode }) {
  const [pins, setPins] = useState<Pins>(EMPTY_PINS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getPins()
        .then((p) => {
          if (cancelled) return;
          setPins(p);
          setLoaded(true);
        })
        .catch((e) => console.error("getPins failed:", e));
    };
    refresh();

    let unlistenPins: UnlistenFn | undefined;
    onPinsChanged((p) => {
      if (cancelled) return;
      setPins(p);
    }).then((u) => {
      unlistenPins = u;
    });

    // The pins map is keyed per plans root, so when this window's root
    // changes we need to refetch — the prior root's pins shouldn't
    // bleed into the new project's surfaces.
    let unlistenRoot: UnlistenFn | undefined;
    onPlansRootChanged(() => {
      refresh();
    }).then((u) => {
      unlistenRoot = u;
    });

    return () => {
      cancelled = true;
      unlistenPins?.();
      unlistenRoot?.();
    };
  }, []);

  const pinnedPlans = useMemo(
    () => [...pins.plans].sort((a, b) => b.pinnedAt - a.pinnedAt),
    [pins.plans],
  );

  const pinnedSections = useCallback(
    (planPath: string): PinnedSection[] => {
      const list = pins.sections[planPath];
      if (!list) return [];
      return [...list].sort((a, b) => b.pinnedAt - a.pinnedAt);
    },
    [pins.sections],
  );

  const isPlanPinned = useCallback(
    (planPath: string) => pins.plans.some((p) => p.planPath === planPath),
    [pins.plans],
  );

  const isSectionPinned = useCallback(
    (planPath: string, headingId: string) => {
      const list = pins.sections[planPath];
      if (!list) return false;
      return list.some((s) => s.headingId === headingId);
    },
    [pins.sections],
  );

  const togglePlan = useCallback(async (planPath: string) => {
    try {
      return await togglePlanPin(planPath);
    } catch (e) {
      console.error("togglePlanPin failed:", e);
      throw e;
    }
  }, []);

  const toggleSection = useCallback(
    async (planPath: string, headingId: string, headingText: string) => {
      try {
        return await toggleSectionPin({ planPath, headingId, headingText });
      } catch (e) {
        console.error("toggleSectionPin failed:", e);
        throw e;
      }
    },
    [],
  );
  const value = useMemo(
    () => ({
      pins,
      loaded,
      pinnedPlans,
      pinnedSections,
      isPlanPinned,
      isSectionPinned,
      togglePlan,
      toggleSection,
    }),
    [
      pins,
      loaded,
      pinnedPlans,
      pinnedSections,
      isPlanPinned,
      isSectionPinned,
      togglePlan,
      toggleSection,
    ],
  );

  return <PinsContext.Provider value={value}>{children}</PinsContext.Provider>;
}

export function usePins(): PinsContextValue {
  const ctx = useContext(PinsContext);
  if (!ctx) throw new Error("usePins must be used inside <PinsProvider>");
  return ctx;
}
