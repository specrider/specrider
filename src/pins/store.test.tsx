import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pins } from "../tauri/api";
import { PinsProvider, usePins } from "./store";

const apiMocks = vi.hoisted(() => ({
  getPins: vi.fn(),
  onPinsChanged: vi.fn(),
  onPlansRootChanged: vi.fn(),
  togglePlanPin: vi.fn(),
  toggleSectionPin: vi.fn(),
}));

vi.mock("../tauri/api", () => ({
  getPins: apiMocks.getPins,
  onPinsChanged: apiMocks.onPinsChanged,
  onPlansRootChanged: apiMocks.onPlansRootChanged,
  togglePlanPin: apiMocks.togglePlanPin,
  toggleSectionPin: apiMocks.toggleSectionPin,
}));

let pinsChangedHandler: ((pins: Pins) => void) | null = null;
let plansRootChangedHandler: (() => void) | null = null;

function wrapper({ children }: { children: ReactNode }) {
  return <PinsProvider>{children}</PinsProvider>;
}

function pins(patch: Partial<Pins> = {}): Pins {
  return {
    plans: [],
    sections: {},
    ...patch,
  };
}

describe("PinsProvider", () => {
  beforeEach(() => {
    pinsChangedHandler = null;
    plansRootChangedHandler = null;
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    apiMocks.getPins.mockResolvedValue(pins());
    apiMocks.onPinsChanged.mockImplementation((handler) => {
      pinsChangedHandler = handler;
      return Promise.resolve(vi.fn());
    });
    apiMocks.onPlansRootChanged.mockImplementation((handler) => {
      plansRootChangedHandler = handler;
      return Promise.resolve(vi.fn());
    });
    apiMocks.togglePlanPin.mockResolvedValue(true);
    apiMocks.toggleSectionPin.mockResolvedValue(true);
  });

  it("loads pins and returns sorted plan and section views", async () => {
    apiMocks.getPins.mockResolvedValueOnce(
      pins({
        plans: [
          { planPath: "active/old.md", pinnedAt: 10 },
          { planPath: "active/new.md", pinnedAt: 20 },
        ],
        sections: {
          "active/new.md": [
            { headingId: "older", headingText: "Older", pinnedAt: 1 },
            { headingId: "newer", headingText: "Newer", pinnedAt: 2 },
          ],
        },
      }),
    );

    const { result } = renderHook(() => usePins(), { wrapper });

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.pinnedPlans.map((pin) => pin.planPath)).toEqual([
      "active/new.md",
      "active/old.md",
    ]);
    expect(
      result.current
        .pinnedSections("active/new.md")
        .map((section) => section.headingId),
    ).toEqual(["newer", "older"]);
    expect(result.current.isPlanPinned("active/new.md")).toBe(true);
    expect(result.current.isSectionPinned("active/new.md", "newer")).toBe(true);
  });

  it("refreshes pins on root changes and applies pins-changed events", async () => {
    apiMocks.getPins
      .mockResolvedValueOnce(
        pins({ plans: [{ planPath: "a.md", pinnedAt: 1 }] }),
      )
      .mockResolvedValueOnce(
        pins({ plans: [{ planPath: "b.md", pinnedAt: 2 }] }),
      );
    const { result } = renderHook(() => usePins(), { wrapper });

    await waitFor(() =>
      expect(result.current.pinnedPlans[0]?.planPath).toBe("a.md"),
    );

    act(() => {
      plansRootChangedHandler?.();
    });

    await waitFor(() =>
      expect(result.current.pinnedPlans[0]?.planPath).toBe("b.md"),
    );

    act(() => {
      pinsChangedHandler?.(
        pins({ plans: [{ planPath: "event.md", pinnedAt: 3 }] }),
      );
    });

    expect(result.current.pinnedPlans[0]?.planPath).toBe("event.md");
  });

  it("forwards toggle calls and rethrows toggle failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    apiMocks.togglePlanPin.mockRejectedValueOnce(new Error("pin failed"));
    const { result } = renderHook(() => usePins(), { wrapper });

    await waitFor(() => expect(result.current.loaded).toBe(true));

    await expect(result.current.togglePlan("active/plan.md")).rejects.toThrow(
      "pin failed",
    );
    expect(apiMocks.togglePlanPin).toHaveBeenCalledWith("active/plan.md");
    expect(error).toHaveBeenCalledWith(
      "togglePlanPin failed:",
      expect.any(Error),
    );

    await result.current.toggleSection("active/plan.md", "intro", "Intro");
    expect(apiMocks.toggleSectionPin).toHaveBeenCalledWith({
      planPath: "active/plan.md",
      headingId: "intro",
      headingText: "Intro",
    });

    error.mockRestore();
  });

  it("throws when usePins is called outside PinsProvider", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => renderHook(() => usePins())).toThrow(
      "usePins must be used inside <PinsProvider>",
    );

    error.mockRestore();
  });
});
