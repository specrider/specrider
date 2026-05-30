/** A theme is a small record of CSS custom-property overrides plus a
 *  `type` (light/dark) used for `color-scheme` and any layout rules
 *  that need to know broad polarity. Every variable optional —
 *  unset values inherit from the closest base theme.
 *
 *  ## Contrast contract for a11y compliance
 *
 *  Themes target WCAG AA (not AAA, which would invalidate the catalog).
 *  When picking values, follow this contract:
 *
 *  - `--ink` vs `--paper`: must clear **4.5:1** (AA body text).
 *  - `--ink-2` vs `--paper`: must clear **4.5:1** (secondary body text).
 *  - `--ink-3` vs `--paper`: must clear **3:1** (UI text, chip labels,
 *    folder caret labels, meta data). Not for body prose.
 *  - `--ink-4` vs `--paper`: borders and disabled-state ghost text only.
 *    Don't paint readable text in this tone.
 *  - `--accent` vs `--paper-2`: must clear **3:1** so focus rings,
 *    selection halos, and link underlines are visible.
 *
 *  The audit ran against the built-ins on 2026-05-08 — most clear AA
 *  comfortably; a handful (paper, sepia, one-light, gruvbox-light)
 *  put `--ink-3` at ~3.4:1, which keeps it for UI use but rules it
 *  out of body text. Use `--ink-2` for any text that runs longer than
 *  a chip label. */
export interface Theme {
  id: string;
  name: string;
  type: "light" | "dark";
  author?: string;
  variables: Record<string, string>;
}

// ─── Contrast validation ───────────────────────────────────────────

/** Pulls the lightness component out of an `oklch(L C H)` string.
 *  Returns null when the string isn't a recognizable oklch literal —
 *  the validator then skips the check rather than warn spuriously. */
function oklchLightness(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(
    /oklch\(\s*([0-9.]+%?)\s+[0-9.]+\s+[0-9.]+(?:\s*\/\s*[0-9.]+%?)?\s*\)/i,
  );
  if (!m) return null;
  const raw = m[1];
  const n = raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** Cheap WCAG-ish contrast estimate in oklch space. Treats lightness
 *  as a proxy for relative luminance — close enough to flag the
 *  obviously-bad cases without a full sRGB conversion. */
function approxContrast(la: number, lb: number): number {
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Returns a human-readable warning if the theme's `--accent` against
 *  `--paper-2` looks like it would fall below the 3:1 minimum we
 *  expect for focus rings, or null when the check passes / can't run. */
export function checkThemeContrast(theme: Theme): string | null {
  const accent = oklchLightness(theme.variables["--accent"]);
  const paper2 = oklchLightness(theme.variables["--paper-2"]);
  if (accent == null || paper2 == null) return null;
  const ratio = approxContrast(accent, paper2);
  // 2.5 leaves a margin for the lightness-as-luminance approximation.
  if (ratio < 2.5) {
    return `Theme "${theme.name}" has low accent-vs-paper-2 contrast (~${ratio.toFixed(2)}:1). Focus rings may be hard to see; aim for 3:1.`;
  }
  return null;
}

// ─── Built-in themes ────────────────────────────────────────────────

const PAPER: Theme = {
  id: "paper",
  name: "Paper",
  type: "light",
  variables: {
    "--paper": "oklch(0.985 0.005 85)",
    "--paper-2": "oklch(0.965 0.008 85)",
    "--paper-3": "oklch(0.94 0.01 85)",
    "--rule": "oklch(0.88 0.012 85)",
    "--rule-soft": "oklch(0.92 0.01 85)",
    "--ink": "oklch(0.22 0.012 60)",
    "--ink-2": "oklch(0.38 0.014 60)",
    "--ink-3": "oklch(0.56 0.014 70)",
    "--ink-4": "oklch(0.72 0.012 75)",
    "--accent": "oklch(0.52 0.13 265)",
    "--accent-soft": "oklch(0.92 0.04 265)",
    "--accent-fg": "oklch(0.42 0.14 265)",
    "--sage": "oklch(0.62 0.07 150)",
    "--sage-soft": "oklch(0.93 0.03 150)",
    "--amber": "oklch(0.72 0.11 75)",
    "--amber-soft": "oklch(0.95 0.04 80)",
    "--rose": "oklch(0.62 0.13 25)",
    "--rose-soft": "oklch(0.94 0.03 25)",
    "--reader-bg": "oklch(0.978 0.006 82)",
    "--callout-note-bg": "oklch(0.97 0.012 265)",
    "--callout-note-border": "oklch(0.88 0.04 265)",
    "--callout-imp-bg": "oklch(0.97 0.018 75)",
    "--callout-imp-border": "oklch(0.88 0.06 75)",
  },
};

const SEPIA: Theme = {
  id: "sepia",
  name: "Sepia",
  type: "light",
  variables: {
    "--paper": "oklch(0.96 0.018 80)",
    "--paper-2": "oklch(0.93 0.022 80)",
    "--paper-3": "oklch(0.9 0.025 75)",
    "--rule": "oklch(0.83 0.025 75)",
    "--rule-soft": "oklch(0.88 0.02 75)",
    "--ink": "oklch(0.32 0.025 50)",
    "--ink-2": "oklch(0.45 0.025 50)",
    "--ink-3": "oklch(0.6 0.02 60)",
    "--ink-4": "oklch(0.72 0.018 65)",
    "--accent": "oklch(0.5 0.12 35)",
    "--accent-soft": "oklch(0.92 0.04 50)",
    "--accent-fg": "oklch(0.42 0.12 35)",
    "--sage": "oklch(0.55 0.08 130)",
    "--sage-soft": "oklch(0.9 0.04 130)",
    "--amber": "oklch(0.65 0.12 70)",
    "--amber-soft": "oklch(0.92 0.05 70)",
    "--rose": "oklch(0.55 0.13 25)",
    "--rose-soft": "oklch(0.92 0.05 25)",
    "--reader-bg": "oklch(0.95 0.022 80)",
    "--callout-note-bg": "oklch(0.94 0.03 50)",
    "--callout-note-border": "oklch(0.86 0.05 50)",
    "--callout-imp-bg": "oklch(0.94 0.04 75)",
    "--callout-imp-border": "oklch(0.84 0.06 75)",
  },
};

const INK: Theme = {
  id: "ink",
  name: "Ink",
  type: "dark",
  variables: {
    "--paper": "oklch(0.18 0.008 80)",
    "--paper-2": "oklch(0.21 0.01 80)",
    "--paper-3": "oklch(0.25 0.012 80)",
    "--rule": "oklch(0.3 0.012 80)",
    "--rule-soft": "oklch(0.26 0.01 80)",
    "--ink": "oklch(0.92 0.008 85)",
    "--ink-2": "oklch(0.78 0.01 85)",
    "--ink-3": "oklch(0.6 0.012 80)",
    "--ink-4": "oklch(0.45 0.014 80)",
    "--accent": "oklch(0.72 0.13 265)",
    "--accent-soft": "oklch(0.3 0.08 265)",
    "--accent-fg": "oklch(0.82 0.12 265)",
    "--sage": "oklch(0.7 0.08 150)",
    "--sage-soft": "oklch(0.3 0.04 150)",
    "--amber": "oklch(0.78 0.12 75)",
    "--amber-soft": "oklch(0.32 0.06 75)",
    "--rose": "oklch(0.7 0.13 25)",
    "--rose-soft": "oklch(0.3 0.06 25)",
    "--reader-bg": "oklch(0.205 0.008 80)",
    "--callout-note-bg": "oklch(0.26 0.04 265)",
    "--callout-note-border": "oklch(0.34 0.06 265)",
    "--callout-imp-bg": "oklch(0.27 0.05 75)",
    "--callout-imp-border": "oklch(0.36 0.08 75)",
  },
};

const TOKYO_NIGHT: Theme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  type: "dark",
  author: "Enkia (port)",
  variables: {
    "--paper": "oklch(0.21 0.025 265)",
    "--paper-2": "oklch(0.24 0.028 265)",
    "--paper-3": "oklch(0.28 0.032 265)",
    "--rule": "oklch(0.32 0.035 265)",
    "--rule-soft": "oklch(0.28 0.03 265)",
    "--ink": "oklch(0.86 0.04 265)",
    "--ink-2": "oklch(0.72 0.045 265)",
    "--ink-3": "oklch(0.55 0.05 265)",
    "--ink-4": "oklch(0.42 0.045 265)",
    "--accent": "oklch(0.74 0.13 250)",
    "--accent-soft": "oklch(0.32 0.08 250)",
    "--accent-fg": "oklch(0.84 0.12 250)",
    "--sage": "oklch(0.78 0.13 155)",
    "--sage-soft": "oklch(0.32 0.06 155)",
    "--amber": "oklch(0.82 0.12 80)",
    "--amber-soft": "oklch(0.34 0.06 80)",
    "--rose": "oklch(0.7 0.16 10)",
    "--rose-soft": "oklch(0.34 0.07 10)",
    "--reader-bg": "oklch(0.235 0.027 265)",
    "--callout-note-bg": "oklch(0.30 0.07 250)",
    "--callout-note-border": "oklch(0.40 0.10 250)",
    "--callout-imp-bg": "oklch(0.32 0.07 60)",
    "--callout-imp-border": "oklch(0.42 0.10 60)",
  },
};

const SOLARIZED_DARK: Theme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  type: "dark",
  author: "Ethan Schoonover (port)",
  variables: {
    "--paper": "oklch(0.27 0.035 200)",
    "--paper-2": "oklch(0.30 0.035 200)",
    "--paper-3": "oklch(0.34 0.035 200)",
    "--rule": "oklch(0.38 0.035 200)",
    "--rule-soft": "oklch(0.34 0.03 200)",
    "--ink": "oklch(0.78 0.025 80)",
    "--ink-2": "oklch(0.65 0.025 200)",
    "--ink-3": "oklch(0.5 0.025 200)",
    "--ink-4": "oklch(0.4 0.025 200)",
    "--accent": "oklch(0.62 0.15 240)",
    "--accent-soft": "oklch(0.32 0.08 240)",
    "--accent-fg": "oklch(0.74 0.14 240)",
    "--sage": "oklch(0.65 0.16 130)",
    "--sage-soft": "oklch(0.32 0.07 130)",
    "--amber": "oklch(0.7 0.15 75)",
    "--amber-soft": "oklch(0.34 0.07 75)",
    "--rose": "oklch(0.6 0.18 20)",
    "--rose-soft": "oklch(0.32 0.08 20)",
    "--reader-bg": "oklch(0.29 0.035 200)",
    "--callout-note-bg": "oklch(0.32 0.06 240)",
    "--callout-note-border": "oklch(0.40 0.08 240)",
    "--callout-imp-bg": "oklch(0.34 0.06 75)",
    "--callout-imp-border": "oklch(0.42 0.08 75)",
  },
};

const DRACULA: Theme = {
  id: "dracula",
  name: "Dracula",
  type: "dark",
  author: "Zeno Rocha (port)",
  variables: {
    "--paper": "oklch(0.27 0.032 285)",
    "--paper-2": "oklch(0.31 0.032 285)",
    "--paper-3": "oklch(0.35 0.034 285)",
    "--rule": "oklch(0.40 0.036 285)",
    "--rule-soft": "oklch(0.34 0.03 285)",
    "--ink": "oklch(0.94 0.01 90)",
    "--ink-2": "oklch(0.80 0.02 285)",
    "--ink-3": "oklch(0.62 0.04 285)",
    "--ink-4": "oklch(0.48 0.04 285)",
    "--accent": "oklch(0.78 0.15 320)",
    "--accent-soft": "oklch(0.36 0.08 320)",
    "--accent-fg": "oklch(0.86 0.13 320)",
    "--sage": "oklch(0.85 0.18 150)",
    "--sage-soft": "oklch(0.34 0.08 150)",
    "--amber": "oklch(0.85 0.13 90)",
    "--amber-soft": "oklch(0.34 0.07 90)",
    "--rose": "oklch(0.74 0.18 15)",
    "--rose-soft": "oklch(0.34 0.08 15)",
    "--reader-bg": "oklch(0.29 0.032 285)",
    "--callout-note-bg": "oklch(0.36 0.10 320)",
    "--callout-note-border": "oklch(0.44 0.13 320)",
    "--callout-imp-bg": "oklch(0.36 0.10 60)",
    "--callout-imp-border": "oklch(0.44 0.13 60)",
  },
};

const SOLARIZED_LIGHT: Theme = {
  id: "solarized-light",
  name: "Solarized Light",
  type: "light",
  author: "Ethan Schoonover (port)",
  variables: {
    "--paper": "oklch(0.97 0.018 90)",
    "--paper-2": "oklch(0.93 0.022 90)",
    "--paper-3": "oklch(0.89 0.025 85)",
    "--rule": "oklch(0.84 0.025 85)",
    "--rule-soft": "oklch(0.88 0.022 85)",
    "--ink": "oklch(0.42 0.03 200)",
    "--ink-2": "oklch(0.52 0.025 200)",
    "--ink-3": "oklch(0.62 0.022 200)",
    "--ink-4": "oklch(0.72 0.018 80)",
    "--accent": "oklch(0.55 0.16 240)",
    "--accent-soft": "oklch(0.92 0.05 240)",
    "--accent-fg": "oklch(0.45 0.16 240)",
    "--sage": "oklch(0.58 0.16 130)",
    "--sage-soft": "oklch(0.92 0.05 130)",
    "--amber": "oklch(0.65 0.15 75)",
    "--amber-soft": "oklch(0.92 0.06 75)",
    "--rose": "oklch(0.55 0.18 20)",
    "--rose-soft": "oklch(0.92 0.06 20)",
    "--reader-bg": "oklch(0.96 0.02 90)",
    "--callout-note-bg": "oklch(0.93 0.05 240)",
    "--callout-note-border": "oklch(0.84 0.08 240)",
    "--callout-imp-bg": "oklch(0.93 0.06 75)",
    "--callout-imp-border": "oklch(0.84 0.09 75)",
  },
};

const ONE_DARK: Theme = {
  id: "one-dark",
  name: "One Dark",
  type: "dark",
  author: "Atom (port)",
  variables: {
    "--paper": "oklch(0.30 0.012 270)",
    "--paper-2": "oklch(0.33 0.013 270)",
    "--paper-3": "oklch(0.37 0.015 270)",
    "--rule": "oklch(0.42 0.018 270)",
    "--rule-soft": "oklch(0.36 0.014 270)",
    "--ink": "oklch(0.82 0.02 270)",
    "--ink-2": "oklch(0.72 0.022 270)",
    "--ink-3": "oklch(0.55 0.025 270)",
    "--ink-4": "oklch(0.42 0.025 270)",
    "--accent": "oklch(0.72 0.14 250)",
    "--accent-soft": "oklch(0.34 0.08 250)",
    "--accent-fg": "oklch(0.82 0.13 250)",
    "--sage": "oklch(0.78 0.15 145)",
    "--sage-soft": "oklch(0.34 0.07 145)",
    "--amber": "oklch(0.82 0.13 80)",
    "--amber-soft": "oklch(0.34 0.06 80)",
    "--rose": "oklch(0.72 0.14 20)",
    "--rose-soft": "oklch(0.34 0.07 20)",
    "--reader-bg": "oklch(0.32 0.012 270)",
    "--callout-note-bg": "oklch(0.36 0.07 250)",
    "--callout-note-border": "oklch(0.44 0.10 250)",
    "--callout-imp-bg": "oklch(0.36 0.07 60)",
    "--callout-imp-border": "oklch(0.44 0.10 60)",
  },
};

const ONE_LIGHT: Theme = {
  id: "one-light",
  name: "One Light",
  type: "light",
  author: "Atom (port)",
  variables: {
    "--paper": "oklch(0.985 0.003 270)",
    "--paper-2": "oklch(0.965 0.005 270)",
    "--paper-3": "oklch(0.94 0.007 270)",
    "--rule": "oklch(0.88 0.01 270)",
    "--rule-soft": "oklch(0.92 0.008 270)",
    "--ink": "oklch(0.32 0.018 270)",
    "--ink-2": "oklch(0.45 0.018 270)",
    "--ink-3": "oklch(0.6 0.018 270)",
    "--ink-4": "oklch(0.72 0.014 270)",
    "--accent": "oklch(0.55 0.18 250)",
    "--accent-soft": "oklch(0.92 0.05 250)",
    "--accent-fg": "oklch(0.45 0.18 250)",
    "--sage": "oklch(0.6 0.14 140)",
    "--sage-soft": "oklch(0.93 0.04 140)",
    "--amber": "oklch(0.7 0.13 75)",
    "--amber-soft": "oklch(0.94 0.05 75)",
    "--rose": "oklch(0.6 0.18 20)",
    "--rose-soft": "oklch(0.93 0.05 20)",
    "--reader-bg": "oklch(0.978 0.004 270)",
    "--callout-note-bg": "oklch(0.95 0.05 250)",
    "--callout-note-border": "oklch(0.84 0.08 250)",
    "--callout-imp-bg": "oklch(0.95 0.05 75)",
    "--callout-imp-border": "oklch(0.86 0.08 75)",
  },
};

const GRUVBOX_DARK: Theme = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  type: "dark",
  author: "morhetz (port)",
  variables: {
    "--paper": "oklch(0.25 0.018 90)",
    "--paper-2": "oklch(0.28 0.022 90)",
    "--paper-3": "oklch(0.32 0.025 88)",
    "--rule": "oklch(0.36 0.028 88)",
    "--rule-soft": "oklch(0.32 0.022 88)",
    "--ink": "oklch(0.88 0.04 95)",
    "--ink-2": "oklch(0.74 0.04 95)",
    "--ink-3": "oklch(0.58 0.04 90)",
    "--ink-4": "oklch(0.45 0.04 90)",
    "--accent": "oklch(0.78 0.14 95)",
    "--accent-soft": "oklch(0.34 0.06 95)",
    "--accent-fg": "oklch(0.84 0.13 95)",
    "--sage": "oklch(0.78 0.16 130)",
    "--sage-soft": "oklch(0.34 0.07 130)",
    "--amber": "oklch(0.78 0.15 60)",
    "--amber-soft": "oklch(0.34 0.07 60)",
    "--rose": "oklch(0.7 0.18 22)",
    "--rose-soft": "oklch(0.34 0.08 22)",
    "--reader-bg": "oklch(0.27 0.02 90)",
    "--callout-note-bg": "oklch(0.32 0.06 220)",
    "--callout-note-border": "oklch(0.40 0.09 220)",
    "--callout-imp-bg": "oklch(0.34 0.07 60)",
    "--callout-imp-border": "oklch(0.42 0.10 60)",
  },
};

const NORD: Theme = {
  id: "nord",
  name: "Nord",
  type: "dark",
  author: "Arctic Ice Studio (port)",
  variables: {
    "--paper": "oklch(0.30 0.025 250)",
    "--paper-2": "oklch(0.34 0.028 250)",
    "--paper-3": "oklch(0.39 0.030 248)",
    "--rule": "oklch(0.44 0.034 248)",
    "--rule-soft": "oklch(0.39 0.028 248)",
    "--ink": "oklch(0.92 0.014 230)",
    "--ink-2": "oklch(0.80 0.020 230)",
    "--ink-3": "oklch(0.65 0.025 240)",
    "--ink-4": "oklch(0.50 0.028 240)",
    "--accent": "oklch(0.74 0.10 230)",
    "--accent-soft": "oklch(0.36 0.06 230)",
    "--accent-fg": "oklch(0.82 0.11 230)",
    "--sage": "oklch(0.78 0.10 150)",
    "--sage-soft": "oklch(0.36 0.05 150)",
    "--amber": "oklch(0.80 0.10 80)",
    "--amber-soft": "oklch(0.36 0.05 80)",
    "--rose": "oklch(0.70 0.13 15)",
    "--rose-soft": "oklch(0.36 0.06 15)",
    "--reader-bg": "oklch(0.32 0.025 250)",
    "--callout-note-bg": "oklch(0.36 0.06 230)",
    "--callout-note-border": "oklch(0.44 0.08 230)",
    "--callout-imp-bg": "oklch(0.36 0.06 60)",
    "--callout-imp-border": "oklch(0.44 0.08 60)",
  },
};

const ROSE_PINE: Theme = {
  id: "rose-pine",
  name: "Rosé Pine",
  type: "dark",
  author: "rose-pine (port)",
  variables: {
    "--paper": "oklch(0.22 0.02 320)",
    "--paper-2": "oklch(0.25 0.024 320)",
    "--paper-3": "oklch(0.29 0.028 318)",
    "--rule": "oklch(0.34 0.032 318)",
    "--rule-soft": "oklch(0.29 0.026 318)",
    "--ink": "oklch(0.88 0.025 320)",
    "--ink-2": "oklch(0.75 0.030 320)",
    "--ink-3": "oklch(0.58 0.035 320)",
    "--ink-4": "oklch(0.44 0.035 320)",
    "--accent": "oklch(0.74 0.09 25)",
    "--accent-soft": "oklch(0.32 0.06 25)",
    "--accent-fg": "oklch(0.82 0.10 25)",
    "--sage": "oklch(0.78 0.10 175)",
    "--sage-soft": "oklch(0.32 0.05 175)",
    "--amber": "oklch(0.82 0.11 75)",
    "--amber-soft": "oklch(0.32 0.05 75)",
    "--rose": "oklch(0.74 0.13 8)",
    "--rose-soft": "oklch(0.32 0.06 8)",
    "--reader-bg": "oklch(0.24 0.022 320)",
    "--callout-note-bg": "oklch(0.30 0.06 270)",
    "--callout-note-border": "oklch(0.38 0.08 270)",
    "--callout-imp-bg": "oklch(0.32 0.07 30)",
    "--callout-imp-border": "oklch(0.40 0.09 30)",
  },
};

const ROSE_PINE_DAWN: Theme = {
  id: "rose-pine-dawn",
  name: "Rosé Pine Dawn",
  type: "light",
  author: "rose-pine (port)",
  variables: {
    "--paper": "oklch(0.97 0.012 50)",
    "--paper-2": "oklch(0.94 0.016 50)",
    "--paper-3": "oklch(0.91 0.020 45)",
    "--rule": "oklch(0.83 0.022 45)",
    "--rule-soft": "oklch(0.88 0.018 45)",
    "--ink": "oklch(0.40 0.04 320)",
    "--ink-2": "oklch(0.52 0.04 320)",
    "--ink-3": "oklch(0.62 0.035 320)",
    "--ink-4": "oklch(0.72 0.025 320)",
    "--accent": "oklch(0.55 0.15 25)",
    "--accent-soft": "oklch(0.92 0.05 25)",
    "--accent-fg": "oklch(0.45 0.16 25)",
    "--sage": "oklch(0.55 0.12 175)",
    "--sage-soft": "oklch(0.92 0.04 175)",
    "--amber": "oklch(0.65 0.13 70)",
    "--amber-soft": "oklch(0.92 0.05 70)",
    "--rose": "oklch(0.55 0.16 8)",
    "--rose-soft": "oklch(0.92 0.05 8)",
    "--reader-bg": "oklch(0.95 0.014 50)",
    "--callout-note-bg": "oklch(0.93 0.04 270)",
    "--callout-note-border": "oklch(0.84 0.07 270)",
    "--callout-imp-bg": "oklch(0.94 0.05 30)",
    "--callout-imp-border": "oklch(0.85 0.08 30)",
  },
};

const TOKYO_NIGHT_STORM: Theme = {
  id: "tokyo-night-storm",
  name: "Tokyo Night Storm",
  type: "dark",
  author: "Enkia (port)",
  variables: {
    "--paper": "oklch(0.26 0.025 265)",
    "--paper-2": "oklch(0.29 0.028 265)",
    "--paper-3": "oklch(0.33 0.032 265)",
    "--rule": "oklch(0.38 0.035 265)",
    "--rule-soft": "oklch(0.33 0.030 265)",
    "--ink": "oklch(0.86 0.04 265)",
    "--ink-2": "oklch(0.72 0.045 265)",
    "--ink-3": "oklch(0.55 0.05 265)",
    "--ink-4": "oklch(0.42 0.045 265)",
    "--accent": "oklch(0.74 0.13 250)",
    "--accent-soft": "oklch(0.36 0.08 250)",
    "--accent-fg": "oklch(0.84 0.12 250)",
    "--sage": "oklch(0.78 0.13 155)",
    "--sage-soft": "oklch(0.36 0.06 155)",
    "--amber": "oklch(0.82 0.12 80)",
    "--amber-soft": "oklch(0.36 0.06 80)",
    "--rose": "oklch(0.7 0.16 10)",
    "--rose-soft": "oklch(0.36 0.07 10)",
    "--reader-bg": "oklch(0.28 0.026 265)",
    "--callout-note-bg": "oklch(0.34 0.07 250)",
    "--callout-note-border": "oklch(0.42 0.10 250)",
    "--callout-imp-bg": "oklch(0.34 0.07 60)",
    "--callout-imp-border": "oklch(0.42 0.10 60)",
  },
};

const GITHUB_DARK: Theme = {
  id: "github-dark",
  name: "GitHub Dark",
  type: "dark",
  author: "GitHub (port)",
  variables: {
    "--paper": "oklch(0.21 0.018 250)",
    "--paper-2": "oklch(0.24 0.020 250)",
    "--paper-3": "oklch(0.28 0.022 250)",
    "--rule": "oklch(0.32 0.024 250)",
    "--rule-soft": "oklch(0.28 0.020 250)",
    "--ink": "oklch(0.92 0.012 250)",
    "--ink-2": "oklch(0.78 0.014 250)",
    "--ink-3": "oklch(0.62 0.016 250)",
    "--ink-4": "oklch(0.48 0.018 250)",
    "--accent": "oklch(0.70 0.16 250)",
    "--accent-soft": "oklch(0.32 0.08 250)",
    "--accent-fg": "oklch(0.80 0.14 250)",
    "--sage": "oklch(0.76 0.18 145)",
    "--sage-soft": "oklch(0.32 0.07 145)",
    "--amber": "oklch(0.80 0.14 75)",
    "--amber-soft": "oklch(0.32 0.06 75)",
    "--rose": "oklch(0.70 0.16 20)",
    "--rose-soft": "oklch(0.32 0.07 20)",
    "--reader-bg": "oklch(0.23 0.018 250)",
    "--callout-note-bg": "oklch(0.30 0.07 250)",
    "--callout-note-border": "oklch(0.38 0.09 250)",
    "--callout-imp-bg": "oklch(0.32 0.07 60)",
    "--callout-imp-border": "oklch(0.40 0.09 60)",
  },
};

const GITHUB_LIGHT: Theme = {
  id: "github-light",
  name: "GitHub Light",
  type: "light",
  author: "GitHub (port)",
  variables: {
    "--paper": "oklch(0.99 0.002 250)",
    "--paper-2": "oklch(0.97 0.003 250)",
    "--paper-3": "oklch(0.94 0.005 250)",
    "--rule": "oklch(0.86 0.008 250)",
    "--rule-soft": "oklch(0.91 0.006 250)",
    "--ink": "oklch(0.28 0.014 250)",
    "--ink-2": "oklch(0.42 0.016 250)",
    "--ink-3": "oklch(0.58 0.016 250)",
    "--ink-4": "oklch(0.70 0.014 250)",
    "--accent": "oklch(0.50 0.18 250)",
    "--accent-soft": "oklch(0.93 0.05 250)",
    "--accent-fg": "oklch(0.42 0.18 250)",
    "--sage": "oklch(0.55 0.14 145)",
    "--sage-soft": "oklch(0.92 0.04 145)",
    "--amber": "oklch(0.68 0.13 75)",
    "--amber-soft": "oklch(0.93 0.05 75)",
    "--rose": "oklch(0.58 0.18 20)",
    "--rose-soft": "oklch(0.93 0.05 20)",
    "--reader-bg": "oklch(0.985 0.003 250)",
    "--callout-note-bg": "oklch(0.94 0.04 250)",
    "--callout-note-border": "oklch(0.85 0.07 250)",
    "--callout-imp-bg": "oklch(0.95 0.05 75)",
    "--callout-imp-border": "oklch(0.86 0.08 75)",
  },
};

const CATPPUCCIN_LATTE: Theme = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  type: "light",
  author: "Catppuccin (port)",
  variables: {
    "--paper": "oklch(0.97 0.008 80)",
    "--paper-2": "oklch(0.94 0.010 80)",
    "--paper-3": "oklch(0.91 0.014 75)",
    "--rule": "oklch(0.84 0.018 75)",
    "--rule-soft": "oklch(0.89 0.014 75)",
    "--ink": "oklch(0.36 0.030 290)",
    "--ink-2": "oklch(0.48 0.028 290)",
    "--ink-3": "oklch(0.60 0.024 290)",
    "--ink-4": "oklch(0.72 0.018 290)",
    "--accent": "oklch(0.55 0.16 305)",
    "--accent-soft": "oklch(0.92 0.05 305)",
    "--accent-fg": "oklch(0.45 0.16 305)",
    "--sage": "oklch(0.55 0.14 150)",
    "--sage-soft": "oklch(0.92 0.04 150)",
    "--amber": "oklch(0.66 0.13 75)",
    "--amber-soft": "oklch(0.92 0.05 75)",
    "--rose": "oklch(0.58 0.17 12)",
    "--rose-soft": "oklch(0.92 0.05 12)",
    "--reader-bg": "oklch(0.96 0.010 80)",
    "--callout-note-bg": "oklch(0.93 0.05 290)",
    "--callout-note-border": "oklch(0.84 0.08 290)",
    "--callout-imp-bg": "oklch(0.94 0.05 60)",
    "--callout-imp-border": "oklch(0.85 0.08 60)",
  },
};

const CATPPUCCIN_MACCHIATO: Theme = {
  id: "catppuccin-macchiato",
  name: "Catppuccin Macchiato",
  type: "dark",
  author: "Catppuccin (port)",
  variables: {
    "--paper": "oklch(0.27 0.025 290)",
    "--paper-2": "oklch(0.30 0.028 290)",
    "--paper-3": "oklch(0.34 0.030 290)",
    "--rule": "oklch(0.38 0.034 290)",
    "--rule-soft": "oklch(0.34 0.030 290)",
    "--ink": "oklch(0.88 0.018 290)",
    "--ink-2": "oklch(0.74 0.022 290)",
    "--ink-3": "oklch(0.58 0.030 290)",
    "--ink-4": "oklch(0.45 0.030 290)",
    "--accent": "oklch(0.78 0.12 305)",
    "--accent-soft": "oklch(0.36 0.08 305)",
    "--accent-fg": "oklch(0.86 0.11 305)",
    "--sage": "oklch(0.82 0.15 150)",
    "--sage-soft": "oklch(0.36 0.07 150)",
    "--amber": "oklch(0.85 0.12 75)",
    "--amber-soft": "oklch(0.36 0.06 75)",
    "--rose": "oklch(0.74 0.16 10)",
    "--rose-soft": "oklch(0.36 0.08 10)",
    "--reader-bg": "oklch(0.29 0.026 290)",
    "--callout-note-bg": "oklch(0.34 0.07 290)",
    "--callout-note-border": "oklch(0.42 0.10 290)",
    "--callout-imp-bg": "oklch(0.36 0.07 60)",
    "--callout-imp-border": "oklch(0.44 0.10 60)",
  },
};

const AYU_DARK: Theme = {
  id: "ayu-dark",
  name: "Ayu Dark",
  type: "dark",
  author: "ayu-theme (port)",
  variables: {
    "--paper": "oklch(0.18 0.018 250)",
    "--paper-2": "oklch(0.21 0.020 250)",
    "--paper-3": "oklch(0.25 0.022 250)",
    "--rule": "oklch(0.30 0.024 250)",
    "--rule-soft": "oklch(0.25 0.020 250)",
    "--ink": "oklch(0.86 0.030 80)",
    "--ink-2": "oklch(0.72 0.030 80)",
    "--ink-3": "oklch(0.56 0.030 80)",
    "--ink-4": "oklch(0.42 0.030 80)",
    "--accent": "oklch(0.78 0.16 65)",
    "--accent-soft": "oklch(0.32 0.07 65)",
    "--accent-fg": "oklch(0.86 0.14 65)",
    "--sage": "oklch(0.80 0.17 130)",
    "--sage-soft": "oklch(0.32 0.07 130)",
    "--amber": "oklch(0.82 0.15 75)",
    "--amber-soft": "oklch(0.32 0.07 75)",
    "--rose": "oklch(0.72 0.16 20)",
    "--rose-soft": "oklch(0.32 0.07 20)",
    "--reader-bg": "oklch(0.20 0.020 250)",
    "--callout-note-bg": "oklch(0.28 0.07 230)",
    "--callout-note-border": "oklch(0.36 0.10 230)",
    "--callout-imp-bg": "oklch(0.30 0.08 60)",
    "--callout-imp-border": "oklch(0.38 0.11 60)",
  },
};

const NEON_RIDER: Theme = {
  id: "neon-rider",
  name: "Neon Rider",
  type: "dark",
  variables: {
    "--paper": "oklch(0.15 0.04 290)",
    "--paper-2": "oklch(0.19 0.05 290)",
    "--paper-3": "oklch(0.23 0.055 292)",
    "--rule": "oklch(0.32 0.07 295)",
    "--rule-soft": "oklch(0.26 0.055 292)",
    "--ink": "oklch(0.94 0.025 300)",
    "--ink-2": "oklch(0.80 0.04 305)",
    "--ink-3": "oklch(0.62 0.05 305)",
    "--ink-4": "oklch(0.48 0.05 300)",
    "--accent": "oklch(0.72 0.22 320)",
    "--accent-soft": "oklch(0.32 0.10 320)",
    "--accent-fg": "oklch(0.84 0.19 320)",
    "--sage": "oklch(0.84 0.16 195)",
    "--sage-soft": "oklch(0.32 0.08 195)",
    "--amber": "oklch(0.82 0.14 75)",
    "--amber-soft": "oklch(0.32 0.07 75)",
    "--rose": "oklch(0.74 0.18 350)",
    "--rose-soft": "oklch(0.32 0.09 350)",
    "--reader-bg": "oklch(0.17 0.04 290)",
    "--callout-note-bg": "oklch(0.30 0.10 320)",
    "--callout-note-border": "oklch(0.40 0.14 320)",
    "--callout-imp-bg": "oklch(0.30 0.10 195)",
    "--callout-imp-border": "oklch(0.40 0.14 195)",
  },
};

const CATPPUCCIN_MOCHA: Theme = {
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  type: "dark",
  author: "Catppuccin (port)",
  variables: {
    "--paper": "oklch(0.24 0.025 290)",
    "--paper-2": "oklch(0.27 0.028 290)",
    "--paper-3": "oklch(0.31 0.030 290)",
    "--rule": "oklch(0.36 0.034 290)",
    "--rule-soft": "oklch(0.32 0.030 290)",
    "--ink": "oklch(0.88 0.018 290)",
    "--ink-2": "oklch(0.75 0.022 290)",
    "--ink-3": "oklch(0.58 0.030 290)",
    "--ink-4": "oklch(0.45 0.030 290)",
    "--accent": "oklch(0.78 0.12 305)",
    "--accent-soft": "oklch(0.34 0.08 305)",
    "--accent-fg": "oklch(0.86 0.11 305)",
    "--sage": "oklch(0.82 0.15 150)",
    "--sage-soft": "oklch(0.34 0.07 150)",
    "--amber": "oklch(0.85 0.12 75)",
    "--amber-soft": "oklch(0.34 0.06 75)",
    "--rose": "oklch(0.74 0.16 10)",
    "--rose-soft": "oklch(0.34 0.08 10)",
    "--reader-bg": "oklch(0.26 0.025 290)",
    "--callout-note-bg": "oklch(0.32 0.07 290)",
    "--callout-note-border": "oklch(0.40 0.10 290)",
    "--callout-imp-bg": "oklch(0.34 0.07 60)",
    "--callout-imp-border": "oklch(0.42 0.10 60)",
  },
};

export const BUILTIN_THEMES: Theme[] = [
  // Light
  PAPER,
  SEPIA,
  ONE_LIGHT,
  GITHUB_LIGHT,
  SOLARIZED_LIGHT,
  CATPPUCCIN_LATTE,
  ROSE_PINE_DAWN,
  // Dark
  INK,
  TOKYO_NIGHT,
  TOKYO_NIGHT_STORM,
  ONE_DARK,
  GITHUB_DARK,
  CATPPUCCIN_MOCHA,
  CATPPUCCIN_MACCHIATO,
  SOLARIZED_DARK,
  DRACULA,
  GRUVBOX_DARK,
  NORD,
  ROSE_PINE,
  AYU_DARK,
  NEON_RIDER,
];

export const THEMES_BY_ID: Map<string, Theme> = new Map(
  BUILTIN_THEMES.map((t) => [t.id, t]),
);

export const DEFAULT_LIGHT_THEME = "paper";
export const DEFAULT_DARK_THEME = "ink";

export function findTheme(id: string | null | undefined): Theme | null {
  if (!id) return null;
  return THEMES_BY_ID.get(id) ?? null;
}
