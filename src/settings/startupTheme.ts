import { paletteForTheme } from "./termPalettes";
import {
  BUILTIN_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  findTheme,
  type Theme,
} from "./themes";
import {
  type AppSettings,
  EMPTY_SETTINGS,
  type ResolvedSettings,
  resolve,
} from "./types";

const SETTINGS_CACHE_KEY = "specrider.settings.cache";

function canUseStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function resolveThemeFromAny(id: string, custom: Theme[]): Theme | null {
  return findTheme(id) ?? custom.find((t) => t.id === id) ?? null;
}

export function readStartupSettingsCache(): AppSettings | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as AppSettings)
      : null;
  } catch {
    return null;
  }
}

export function cacheStartupSettings(settings: AppSettings): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage can be unavailable in private or constrained contexts. */
  }
}

export function applyStartupTheme(): void {
  const settings = resolve(readStartupSettingsCache() ?? EMPTY_SETTINGS);
  applyResolvedThemeToDocument(settings);
}

export function applyResolvedThemeToDocument(
  settings: ResolvedSettings,
  customThemes: Theme[] = [],
): Theme {
  const theme = pickActiveTheme(settings, customThemes);
  const root = document.documentElement;
  const body = document.body;

  root.style.colorScheme = theme.type;

  if (body) {
    for (const className of Array.from(body.classList)) {
      if (className.startsWith("theme-")) body.classList.remove(className);
    }
    body.classList.add(`theme-${theme.type}`, `theme-${theme.id}`);
  }

  applyThemeVariables(root, theme);
  applyAccentOverride(root, settings.accent);
  return theme;
}

export function pickActiveTheme(
  settings: ResolvedSettings,
  customThemes: Theme[] = [],
): Theme {
  const systemDark = prefersDark();
  let id = settings.theme;
  if (id === "system") {
    id = systemDark ? settings.themeDarkId : settings.themeLightId;
  }

  return (
    resolveThemeFromAny(id, customThemes) ??
    findTheme(systemDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME) ??
    BUILTIN_THEMES[0]
  );
}

function applyThemeVariables(root: HTMLElement, theme: Theme): void {
  const palette = paletteForTheme(theme.id, theme.type);
  for (const [key, value] of Object.entries(palette)) {
    root.style.setProperty(key, value);
  }
  for (const [key, value] of Object.entries(theme.variables)) {
    root.style.setProperty(key, value);
  }
}

function applyAccentOverride(root: HTMLElement, accent: string | null): void {
  if (!accent) return;
  root.style.setProperty("--accent", accent);
  const derived = deriveAccent(accent);
  if (!derived) return;
  root.style.setProperty("--accent-soft", derived.soft);
  root.style.setProperty("--accent-fg", derived.fg);
}

/** OKLCH inputs get derived soft/fg variants. Other formats fall back
 *  to keeping `--accent` set; soft / fg stay at whatever the theme
 *  defines (so the change is partial but visible). */
function deriveAccent(input: string): { soft: string; fg: string } | null {
  const m = input.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i);
  if (m) {
    const l = parseFloat(m[1]);
    const c = parseFloat(m[2]);
    const h = parseFloat(m[3]);
    return {
      soft: `oklch(${Math.min(0.95, l + 0.4).toFixed(3)} ${Math.max(0.04, c * 0.3).toFixed(3)} ${h})`,
      fg: `oklch(${Math.max(0.3, l - 0.1).toFixed(3)} ${(c * 1.05).toFixed(3)} ${h})`,
    };
  }
  return null;
}
