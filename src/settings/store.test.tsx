import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomThemeRaw } from "../tauri/api";
import { SettingsProvider, useSettings } from "./store";
import { type AppSettings, EMPTY_SETTINGS } from "./types";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  listCustomThemes: vi.fn(),
  onThemesChanged: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: coreMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

vi.mock("../tauri/api", () => ({
  listCustomThemes: apiMocks.listCustomThemes,
  onThemesChanged: apiMocks.onThemesChanged,
}));

let settingsChangedHandler: ((event: { payload: AppSettings }) => void) | null =
  null;
let themesChangedHandler: (() => void) | null = null;

function wrapper({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}

function appSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...EMPTY_SETTINGS, ...patch };
}

function lowContrastTheme(id = "low-theme"): CustomThemeRaw {
  return {
    id,
    name: "Low Contrast",
    type: "light",
    variables: {
      "--accent": "oklch(0.90 0.10 120)",
      "--paper-2": "oklch(0.91 0.01 120)",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SettingsProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    settingsChangedHandler = null;
    themesChangedHandler = null;
    for (const mock of [
      ...Object.values(coreMocks),
      ...Object.values(eventMocks),
      ...Object.values(apiMocks),
    ]) {
      mock.mockReset();
    }
    eventMocks.listen.mockImplementation((event, handler) => {
      if (event === "settings-changed") settingsChangedHandler = handler;
      return Promise.resolve(vi.fn());
    });
    apiMocks.onThemesChanged.mockImplementation((handler) => {
      themesChangedHandler = handler;
      return Promise.resolve(vi.fn());
    });
    apiMocks.listCustomThemes.mockResolvedValue([]);
    coreMocks.invoke.mockImplementation((command) => {
      if (command === "get_settings") {
        return Promise.resolve(appSettings());
      }
      if (command === "set_setting" || command === "reset_settings") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
  });

  it("loads initial settings and surfaces custom theme contrast warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    coreMocks.invoke.mockImplementation((command) => {
      if (command === "get_settings") {
        return Promise.resolve(appSettings({ density: "dense" }));
      }
      return Promise.resolve(undefined);
    });
    apiMocks.listCustomThemes.mockResolvedValueOnce([lowContrastTheme()]);

    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.raw.density).toBe("dense");
    expect(result.current.effective.density).toBe("dense");
    expect(result.current.customThemes[0]?.id).toBe("low-theme");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Theme "Low Contrast" has low'),
    );
    expect(localStorage.getItem("specrider.settings.cache")).toContain(
      '"density":"dense"',
    );

    warn.mockRestore();
  });

  it("updates optimistically and rolls back from a fresh fetch when persistence fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingSet = deferred<void>();
    const persisted = appSettings({ accent: "#111111" });
    coreMocks.invoke.mockImplementation((command) => {
      if (command === "get_settings") return Promise.resolve(persisted);
      if (command === "set_setting") return pendingSet.promise;
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(result.current.loaded).toBe(true));

    void act(() => {
      void result.current.update("accent", "#222222");
    });

    await waitFor(() => expect(result.current.raw.accent).toBe("#222222"));

    act(() => {
      pendingSet.reject(new Error("write failed"));
    });

    await waitFor(() => expect(result.current.raw.accent).toBe("#111111"));
    expect(coreMocks.invoke).toHaveBeenCalledWith("set_setting", {
      key: "accent",
      value: "#222222",
    });

    error.mockRestore();
  });

  it("applies settings-changed events and refreshes custom themes", async () => {
    apiMocks.listCustomThemes.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...lowContrastTheme("event-theme"),
        variables: {},
      },
    ]);
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      settingsChangedHandler?.({
        payload: appSettings({ bodySize: 18 }),
      });
    });

    await waitFor(() => expect(result.current.effective.bodySize).toBe(18));

    act(() => {
      themesChangedHandler?.();
    });

    await waitFor(() =>
      expect(result.current.customThemes[0]?.id).toBe("event-theme"),
    );
  });

  it("calls reset_settings for the requested section", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await result.current.reset("themes");
    });

    expect(coreMocks.invoke).toHaveBeenCalledWith("reset_settings", {
      section: "themes",
    });
  });
});
