import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { loadGoogleFont } from "./fontLoader";
import { applyResolvedThemeToDocument, pickActiveTheme } from "./startupTheme";
import type { Theme } from "./themes";
import type { ResolvedSettings } from "./types";

/** One-shot anti-flash trigger. Windows are spawned hidden via
 *  `tauri.conf.json` + `WebviewWindowBuilder.visible(false)`; we
 *  invoke `show_window` only after the document's `load` event has
 *  fired (signalling all CSS / fonts / scripts are done) and one
 *  settle tick has passed (so the compositor has actually committed
 *  the painted state to the WKWebView's layer).
 *
 *  We don't use `requestAnimationFrame`: hidden NSWindows pause RAF
 *  in WKWebView so a RAF-deferred show would never fire. `setTimeout`
 *  still runs at coarse intervals while hidden, which is what we
 *  need. */
let windowShown = false;
function revealWindowAfterFirstPaint(): void {
  if (windowShown) return;
  windowShown = true;

  const fire = () => {
    // Settle tick. The `load` event fires after first paint, but the
    // layer commit can lag a frame; setTimeout 32ms is roughly two
    // 60Hz frames — enough cushion that the layer is up-to-date when
    // Tauri animates the window in.
    setTimeout(() => {
      void invoke("show_window").catch(() => {
        /* Already-visible windows (re-focus path) no-op on the Rust
           side; no recovery needed. */
      });
    }, 32);
  };

  if (document.readyState === "complete") {
    fire();
  } else {
    window.addEventListener("load", fire, { once: true });
  }
}

/**
 * Mirrors the resolved settings onto:
 *   - document.documentElement style (CSS custom properties — both the
 *     theme's variable bag and the typography knobs)
 *   - document.body class list (theme-light / theme-dark + density)
 * Subscribes to `prefers-color-scheme` only when theme = "system".
 *
 * `customThemes` is a flat list of user-defined themes loaded from
 * `<app_config>/themes/*.json`; passed in via the Settings
 * store so the lookup catalog includes them.
 */
export function useApplyCss(
  settings: ResolvedSettings,
  customThemes: Theme[] = [],
): void {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;

    applyResolvedThemeToDocument(settings, customThemes);

    // Density
    body.classList.remove("density-comfortable", "density-dense");
    body.classList.add(`density-${settings.density}`);

    // Typography toggles — driven by the three switches in
    // Settings → Typography. The CSS overrides live at the bottom of
    // styles.css.
    body.classList.toggle("no-hyphens", !settings.hyphenation);
    body.classList.toggle("no-body-ligatures", !settings.bodyLigatures);
    body.classList.toggle("mono-ligatures", settings.monoLigatures);

    // Lazy-fetch any Google Fonts the user picked. No-op for system /
    // locally-installed family names.
    loadGoogleFont(settings.fontSerif);
    loadGoogleFont(settings.fontSans);
    loadGoogleFont(settings.fontMono);

    root.style.setProperty(
      "--font-serif",
      quoteFontFamily(settings.fontSerif, "serif"),
    );
    root.style.setProperty(
      "--font-sans",
      quoteFontFamily(settings.fontSans, "sans-serif"),
    );
    root.style.setProperty(
      "--font-mono",
      quoteFontFamily(settings.fontMono, "monospace"),
    );
    root.style.setProperty("--body-size", `${settings.bodySize}px`);
    root.style.setProperty("--ui-size", `${settings.uiSize}px`);
    root.style.setProperty("--mono-size", `${settings.monoSize}px`);
    root.style.setProperty("--line-height", String(settings.lineHeight));

    pushMenuThemeToHost(settings, customThemes);
    revealWindowAfterFirstPaint();
  }, [settings, customThemes]);

  // Track system theme changes when the user picked "system".
  useEffect(() => {
    if (settings.theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyResolvedThemeToDocument(settings, customThemes);
      pushMenuThemeToHost(settings, customThemes);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [settings, customThemes]);
}

/** Resolve a CSS custom property to a GTK-compatible color string.
 *  GTK 3's CSS parser only understands rgb/rgba/hex (CSS Color L3),
 *  but `getComputedStyle().color` in WebKit2GTK preserves the original
 *  color space — so an `oklch()` source comes back as `oklch(...)` and
 *  fillStyle reflection isn't reliable enough to flatten it.
 *
 *  Instead we paint the resolved color into a 1×1 sRGB canvas and read
 *  the pixel bytes back. Whatever format the browser accepts becomes
 *  rgb/rgba on the way out — bulletproof against any new CSS Color
 *  Level the WebView grows in the future. Returns null if the variable
 *  is unset or the browser refused the assignment. */
function resolveCssVarToGtkColor(varName: string): string | null {
  const probe = document.createElement("span");
  probe.style.cssText = `color: var(${varName}); display: none;`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color.trim();
  probe.remove();
  if (!resolved) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  let pixel: Uint8ClampedArray;
  try {
    pixel = ctx.getImageData(0, 0, 1, 1).data;
  } catch {
    return null;
  }
  const [r, g, b, a] = pixel;
  if (a === 255) return `rgb(${r}, ${g}, ${b})`;
  if (a === 0) return null;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** Bridge the resolved app theme into the host window's GTK menubar.
 *  No-op on macOS / Windows on the Rust side, so we always call. */
function pushMenuThemeToHost(
  settings: ResolvedSettings,
  customThemes: Theme[],
): void {
  const theme = pickActiveTheme(settings, customThemes);
  const isDark = theme.type === "dark";
  const bg = resolveCssVarToGtkColor("--paper");
  const fg = resolveCssVarToGtkColor("--ink");
  if (bg && fg) {
    void invoke("set_menu_theme", { bg, fg, isDark }).catch(() => {
      /* No-op: command runs as a side effect; theming missing is not
         worth surfacing to the user. */
    });
  }
  // Windows-only: flip the title bar / native menu between Windows'
  // light and dark palettes. Unlike GTK, the Win32 menu doesn't accept
  // arbitrary colors, so this only tracks the light/dark axis.
  void invoke("set_window_dark_mode", { isDark }).catch(() => {
    /* No-op for the same reason as above. */
  });
}

/** Wrap a font family in quotes if it contains spaces, then append a
 *  generic fallback so the stack stays robust. */
function quoteFontFamily(family: string, fallback: string): string {
  const quoted =
    /[\s,]/.test(family) && !family.startsWith('"') && !family.startsWith("'")
      ? `"${family}"`
      : family;
  return `${quoted}, ${fallback}`;
}
