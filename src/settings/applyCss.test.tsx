import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApplyCss } from "./applyCss";
import type { Theme } from "./themes";
import { DEFAULTS, type ResolvedSettings } from "./types";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const fontMocks = vi.hoisted(() => ({
  loadGoogleFont: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: coreMocks.invoke,
}));

vi.mock("./fontLoader", () => ({
  loadGoogleFont: fontMocks.loadGoogleFont,
}));

function Harness({
  settings,
  customThemes = [],
}: {
  settings: ResolvedSettings;
  customThemes?: Theme[];
}) {
  useApplyCss(settings, customThemes);
  return null;
}

function settings(patch: Partial<ResolvedSettings> = {}): ResolvedSettings {
  return { ...DEFAULTS, ...patch };
}

function installColorResolutionMocks() {
  const computed = vi
    .spyOn(window, "getComputedStyle")
    .mockReturnValue({ color: "rgb(10, 20, 30)" } as CSSStyleDeclaration);
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([10, 20, 30, 255]),
      })),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
  return () => {
    computed.mockRestore();
    canvas.mockRestore();
  };
}

describe("useApplyCss", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.className = "";
    for (const mock of [
      ...Object.values(coreMocks),
      ...Object.values(fontMocks),
    ]) {
      mock.mockReset();
    }
    coreMocks.invoke.mockResolvedValue(undefined);
  });

  it("applies theme classes, typography CSS variables, fonts, and host menu theme", () => {
    const restoreColorMocks = installColorResolutionMocks();

    render(
      <Harness
        settings={settings({
          accent: "oklch(0.5 0.12 30)",
          density: "dense",
          hyphenation: false,
          bodyLigatures: false,
          monoLigatures: true,
          fontSerif: "Source Serif 4",
          fontSans: "IBM Plex Sans",
          fontMono: "JetBrains Mono",
          bodySize: 17,
          uiSize: 14,
          monoSize: 15,
          lineHeight: 1.7,
          theme: "paper",
        })}
      />,
    );

    expect(document.body.classList.contains("theme-light")).toBe(true);
    expect(document.body.classList.contains("theme-paper")).toBe(true);
    expect(document.body.classList.contains("density-dense")).toBe(true);
    expect(document.body.classList.contains("no-hyphens")).toBe(true);
    expect(document.body.classList.contains("no-body-ligatures")).toBe(true);
    expect(document.body.classList.contains("mono-ligatures")).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue("--font-serif"),
    ).toBe('"Source Serif 4", serif');
    expect(document.documentElement.style.getPropertyValue("--body-size")).toBe(
      "17px",
    );
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      "oklch(0.5 0.12 30)",
    );
    expect(fontMocks.loadGoogleFont).toHaveBeenCalledWith("Source Serif 4");
    expect(fontMocks.loadGoogleFont).toHaveBeenCalledWith("IBM Plex Sans");
    expect(fontMocks.loadGoogleFont).toHaveBeenCalledWith("JetBrains Mono");
    expect(coreMocks.invoke).toHaveBeenCalledWith("set_menu_theme", {
      bg: "rgb(10, 20, 30)",
      fg: "rgb(10, 20, 30)",
      isDark: false,
    });
    expect(coreMocks.invoke).toHaveBeenCalledWith("set_window_dark_mode", {
      isDark: false,
    });

    restoreColorMocks();
  });

  it("reapplies system themes and host theme state when the OS color scheme changes", () => {
    const restoreColorMocks = installColorResolutionMocks();
    let dark = false;
    let changeHandler: (() => void) | null = null;
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return dark;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, handler: () => void) => {
        changeHandler = handler;
      }),
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { unmount } = render(
      <Harness
        settings={settings({
          theme: "system",
          themeLightId: "paper",
          themeDarkId: "ink",
        })}
      />,
    );

    expect(document.body.classList.contains("theme-paper")).toBe(true);

    dark = true;
    expect(changeHandler).toBeTruthy();
    (changeHandler as unknown as () => void)();

    expect(document.body.classList.contains("theme-ink")).toBe(true);
    expect(coreMocks.invoke).toHaveBeenLastCalledWith("set_window_dark_mode", {
      isDark: true,
    });

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", changeHandler);

    restoreColorMocks();
  });
});
