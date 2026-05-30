// ANSI 16-color palettes for the embedded agent terminal, keyed by
// theme id.
//
// Each palette is a flat record of CSS custom properties that
// useTerminalSession's readThemeFromCss() picks up. The keys
// (--term-ansi-*) are applied to :root by useApplyCss after the
// theme's own variables, so a theme can override individual entries
// in its `variables` map if it wants to.
//
// For themes without an explicit palette here, the appropriate
// LIGHT_FALLBACK or DARK_FALLBACK gets applied based on theme.type.

export type TermPalette = Record<string, string>;

// Generic light-theme fallback for any theme.type === "light" without
// its own curated palette. Saturated mid-tone hues that hold contrast
// on near-white backgrounds; brights are slightly darker/more vivid so
// `\e[1;3xm` doesn't fade into the page.
const LIGHT_FALLBACK: TermPalette = {
  "--term-ansi-black": "#1f2328",
  "--term-ansi-red": "#cf222e",
  "--term-ansi-green": "#1a7f37",
  "--term-ansi-yellow": "#9a6700",
  "--term-ansi-blue": "#0969da",
  "--term-ansi-magenta": "#8250df",
  "--term-ansi-cyan": "#1b7c83",
  "--term-ansi-white": "#6e7781",
  "--term-ansi-bright-black": "#57606a",
  "--term-ansi-bright-red": "#a40e26",
  "--term-ansi-bright-green": "#116329",
  "--term-ansi-bright-yellow": "#7d4e00",
  "--term-ansi-bright-blue": "#0550ae",
  "--term-ansi-bright-magenta": "#6639ba",
  "--term-ansi-bright-cyan": "#136061",
  "--term-ansi-bright-white": "#24292f",
};

// Tokyo-Night-derived: this is what most modern dark terminals look
// like and reads well against any of our dark themes.
const DARK_FALLBACK: TermPalette = {
  "--term-ansi-black": "#15161e",
  "--term-ansi-red": "#f7768e",
  "--term-ansi-green": "#9ece6a",
  "--term-ansi-yellow": "#e0af68",
  "--term-ansi-blue": "#7aa2f7",
  "--term-ansi-magenta": "#bb9af7",
  "--term-ansi-cyan": "#7dcfff",
  "--term-ansi-white": "#a9b1d6",
  "--term-ansi-bright-black": "#414868",
  "--term-ansi-bright-red": "#f7768e",
  "--term-ansi-bright-green": "#9ece6a",
  "--term-ansi-bright-yellow": "#e0af68",
  "--term-ansi-bright-blue": "#7aa2f7",
  "--term-ansi-bright-magenta": "#bb9af7",
  "--term-ansi-bright-cyan": "#7dcfff",
  "--term-ansi-bright-white": "#c0caf5",
};

const SOLARIZED_DARK_PAL: TermPalette = {
  "--term-ansi-black": "#073642",
  "--term-ansi-red": "#dc322f",
  "--term-ansi-green": "#859900",
  "--term-ansi-yellow": "#b58900",
  "--term-ansi-blue": "#268bd2",
  "--term-ansi-magenta": "#d33682",
  "--term-ansi-cyan": "#2aa198",
  "--term-ansi-white": "#eee8d5",
  "--term-ansi-bright-black": "#002b36",
  "--term-ansi-bright-red": "#cb4b16",
  "--term-ansi-bright-green": "#586e75",
  "--term-ansi-bright-yellow": "#657b83",
  "--term-ansi-bright-blue": "#839496",
  "--term-ansi-bright-magenta": "#6c71c4",
  "--term-ansi-bright-cyan": "#93a1a1",
  "--term-ansi-bright-white": "#fdf6e3",
};

const DRACULA_PAL: TermPalette = {
  "--term-ansi-black": "#21222c",
  "--term-ansi-red": "#ff5555",
  "--term-ansi-green": "#50fa7b",
  "--term-ansi-yellow": "#f1fa8c",
  "--term-ansi-blue": "#bd93f9",
  "--term-ansi-magenta": "#ff79c6",
  "--term-ansi-cyan": "#8be9fd",
  "--term-ansi-white": "#f8f8f2",
  "--term-ansi-bright-black": "#6272a4",
  "--term-ansi-bright-red": "#ff6e6e",
  "--term-ansi-bright-green": "#69ff94",
  "--term-ansi-bright-yellow": "#ffffa5",
  "--term-ansi-bright-blue": "#d6acff",
  "--term-ansi-bright-magenta": "#ff92df",
  "--term-ansi-bright-cyan": "#a4ffff",
  "--term-ansi-bright-white": "#ffffff",
};

const NORD_PAL: TermPalette = {
  "--term-ansi-black": "#3b4252",
  "--term-ansi-red": "#bf616a",
  "--term-ansi-green": "#a3be8c",
  "--term-ansi-yellow": "#ebcb8b",
  "--term-ansi-blue": "#81a1c1",
  "--term-ansi-magenta": "#b48ead",
  "--term-ansi-cyan": "#88c0d0",
  "--term-ansi-white": "#e5e9f0",
  "--term-ansi-bright-black": "#4c566a",
  "--term-ansi-bright-red": "#bf616a",
  "--term-ansi-bright-green": "#a3be8c",
  "--term-ansi-bright-yellow": "#ebcb8b",
  "--term-ansi-bright-blue": "#81a1c1",
  "--term-ansi-bright-magenta": "#b48ead",
  "--term-ansi-bright-cyan": "#8fbcbb",
  "--term-ansi-bright-white": "#eceff4",
};

const GRUVBOX_DARK_PAL: TermPalette = {
  "--term-ansi-black": "#282828",
  "--term-ansi-red": "#cc241d",
  "--term-ansi-green": "#98971a",
  "--term-ansi-yellow": "#d79921",
  "--term-ansi-blue": "#458588",
  "--term-ansi-magenta": "#b16286",
  "--term-ansi-cyan": "#689d6a",
  "--term-ansi-white": "#a89984",
  "--term-ansi-bright-black": "#928374",
  "--term-ansi-bright-red": "#fb4934",
  "--term-ansi-bright-green": "#b8bb26",
  "--term-ansi-bright-yellow": "#fabd2f",
  "--term-ansi-bright-blue": "#83a598",
  "--term-ansi-bright-magenta": "#d3869b",
  "--term-ansi-bright-cyan": "#8ec07c",
  "--term-ansi-bright-white": "#ebdbb2",
};

const ONE_DARK_PAL: TermPalette = {
  "--term-ansi-black": "#282c34",
  "--term-ansi-red": "#e06c75",
  "--term-ansi-green": "#98c379",
  "--term-ansi-yellow": "#d19a66",
  "--term-ansi-blue": "#61afef",
  "--term-ansi-magenta": "#c678dd",
  "--term-ansi-cyan": "#56b6c2",
  "--term-ansi-white": "#abb2bf",
  "--term-ansi-bright-black": "#5c6370",
  "--term-ansi-bright-red": "#e06c75",
  "--term-ansi-bright-green": "#98c379",
  "--term-ansi-bright-yellow": "#e5c07b",
  "--term-ansi-bright-blue": "#61afef",
  "--term-ansi-bright-magenta": "#c678dd",
  "--term-ansi-bright-cyan": "#56b6c2",
  "--term-ansi-bright-white": "#dcdfe4",
};

const CATPPUCCIN_MOCHA_PAL: TermPalette = {
  "--term-ansi-black": "#45475a",
  "--term-ansi-red": "#f38ba8",
  "--term-ansi-green": "#a6e3a1",
  "--term-ansi-yellow": "#f9e2af",
  "--term-ansi-blue": "#89b4fa",
  "--term-ansi-magenta": "#f5c2e7",
  "--term-ansi-cyan": "#94e2d5",
  "--term-ansi-white": "#bac2de",
  "--term-ansi-bright-black": "#585b70",
  "--term-ansi-bright-red": "#f38ba8",
  "--term-ansi-bright-green": "#a6e3a1",
  "--term-ansi-bright-yellow": "#f9e2af",
  "--term-ansi-bright-blue": "#89b4fa",
  "--term-ansi-bright-magenta": "#f5c2e7",
  "--term-ansi-bright-cyan": "#94e2d5",
  "--term-ansi-bright-white": "#a6adc8",
};

const CATPPUCCIN_LATTE_PAL: TermPalette = {
  "--term-ansi-black": "#5c5f77",
  "--term-ansi-red": "#d20f39",
  "--term-ansi-green": "#40a02b",
  "--term-ansi-yellow": "#df8e1d",
  "--term-ansi-blue": "#1e66f5",
  "--term-ansi-magenta": "#ea76cb",
  "--term-ansi-cyan": "#179299",
  "--term-ansi-white": "#acb0be",
  "--term-ansi-bright-black": "#6c6f85",
  "--term-ansi-bright-red": "#d20f39",
  "--term-ansi-bright-green": "#40a02b",
  "--term-ansi-bright-yellow": "#df8e1d",
  "--term-ansi-bright-blue": "#1e66f5",
  "--term-ansi-bright-magenta": "#ea76cb",
  "--term-ansi-bright-cyan": "#179299",
  "--term-ansi-bright-white": "#bcc0cc",
};

const AYU_DARK_PAL: TermPalette = {
  "--term-ansi-black": "#1a1f29",
  "--term-ansi-red": "#f07178",
  "--term-ansi-green": "#aad94c",
  "--term-ansi-yellow": "#ffb454",
  "--term-ansi-blue": "#59c2ff",
  "--term-ansi-magenta": "#d2a6ff",
  "--term-ansi-cyan": "#95e6cb",
  "--term-ansi-white": "#bfbdb6",
  "--term-ansi-bright-black": "#7c8087",
  "--term-ansi-bright-red": "#f07178",
  "--term-ansi-bright-green": "#aad94c",
  "--term-ansi-bright-yellow": "#ffb454",
  "--term-ansi-bright-blue": "#59c2ff",
  "--term-ansi-bright-magenta": "#d2a6ff",
  "--term-ansi-bright-cyan": "#95e6cb",
  "--term-ansi-bright-white": "#fcfcfc",
};

const GITHUB_DARK_PAL: TermPalette = {
  "--term-ansi-black": "#484f58",
  "--term-ansi-red": "#ff7b72",
  "--term-ansi-green": "#3fb950",
  "--term-ansi-yellow": "#d29922",
  "--term-ansi-blue": "#58a6ff",
  "--term-ansi-magenta": "#bc8cff",
  "--term-ansi-cyan": "#39c5cf",
  "--term-ansi-white": "#b1bac4",
  "--term-ansi-bright-black": "#6e7681",
  "--term-ansi-bright-red": "#ffa198",
  "--term-ansi-bright-green": "#56d364",
  "--term-ansi-bright-yellow": "#e3b341",
  "--term-ansi-bright-blue": "#79c0ff",
  "--term-ansi-bright-magenta": "#d2a8ff",
  "--term-ansi-bright-cyan": "#56d4dd",
  "--term-ansi-bright-white": "#f0f6fc",
};

const GITHUB_LIGHT_PAL: TermPalette = {
  "--term-ansi-black": "#24292f",
  "--term-ansi-red": "#cf222e",
  "--term-ansi-green": "#116329",
  "--term-ansi-yellow": "#4d2d00",
  "--term-ansi-blue": "#0969da",
  "--term-ansi-magenta": "#8250df",
  "--term-ansi-cyan": "#1b7c83",
  "--term-ansi-white": "#6e7781",
  "--term-ansi-bright-black": "#57606a",
  "--term-ansi-bright-red": "#a40e26",
  "--term-ansi-bright-green": "#1a7f37",
  "--term-ansi-bright-yellow": "#633c01",
  "--term-ansi-bright-blue": "#218bff",
  "--term-ansi-bright-magenta": "#8250df",
  "--term-ansi-bright-cyan": "#3192aa",
  "--term-ansi-bright-white": "#8c959f",
};

const ROSE_PINE_PAL: TermPalette = {
  "--term-ansi-black": "#26233a",
  "--term-ansi-red": "#eb6f92",
  "--term-ansi-green": "#31748f",
  "--term-ansi-yellow": "#f6c177",
  "--term-ansi-blue": "#9ccfd8",
  "--term-ansi-magenta": "#c4a7e7",
  "--term-ansi-cyan": "#ebbcba",
  "--term-ansi-white": "#e0def4",
  "--term-ansi-bright-black": "#6e6a86",
  "--term-ansi-bright-red": "#eb6f92",
  "--term-ansi-bright-green": "#31748f",
  "--term-ansi-bright-yellow": "#f6c177",
  "--term-ansi-bright-blue": "#9ccfd8",
  "--term-ansi-bright-magenta": "#c4a7e7",
  "--term-ansi-bright-cyan": "#ebbcba",
  "--term-ansi-bright-white": "#e0def4",
};

const ROSE_PINE_DAWN_PAL: TermPalette = {
  "--term-ansi-black": "#575279",
  "--term-ansi-red": "#b4637a",
  "--term-ansi-green": "#286983",
  "--term-ansi-yellow": "#ea9d34",
  "--term-ansi-blue": "#56949f",
  "--term-ansi-magenta": "#907aa9",
  "--term-ansi-cyan": "#d7827e",
  "--term-ansi-white": "#cecacd",
  "--term-ansi-bright-black": "#9893a5",
  "--term-ansi-bright-red": "#b4637a",
  "--term-ansi-bright-green": "#286983",
  "--term-ansi-bright-yellow": "#ea9d34",
  "--term-ansi-bright-blue": "#56949f",
  "--term-ansi-bright-magenta": "#907aa9",
  "--term-ansi-bright-cyan": "#d7827e",
  "--term-ansi-bright-white": "#fffaf3",
};

// Sepia — warm cream paper. Saturated earthy hues; brights deepen
// rather than lighten so `\e[1m` reads as emphasis, not as fade.
const SEPIA_PAL: TermPalette = {
  "--term-ansi-black": "#3a2e1c",
  "--term-ansi-red": "#b3331f",
  "--term-ansi-green": "#5a6b1a",
  "--term-ansi-yellow": "#9a6a14",
  "--term-ansi-blue": "#1f5a85",
  "--term-ansi-magenta": "#9a3a6a",
  "--term-ansi-cyan": "#1f7068",
  "--term-ansi-white": "#7a6a4e",
  "--term-ansi-bright-black": "#5c4a30",
  "--term-ansi-bright-red": "#8a2614",
  "--term-ansi-bright-green": "#3f4a12",
  "--term-ansi-bright-yellow": "#704a0c",
  "--term-ansi-bright-blue": "#0f3e60",
  "--term-ansi-bright-magenta": "#6a2848",
  "--term-ansi-bright-cyan": "#0f4f48",
  "--term-ansi-bright-white": "#3a2e1c",
};

// Paper — cool warm-white. Tokyo-Night-Day-derived: saturated mid-tones
// that hold against a near-white bg, with brights pushed darker.
const PAPER_PAL: TermPalette = {
  "--term-ansi-black": "#0f1011",
  "--term-ansi-red": "#c64343",
  "--term-ansi-green": "#587539",
  "--term-ansi-yellow": "#8c6c3e",
  "--term-ansi-blue": "#34548a",
  "--term-ansi-magenta": "#5a3e8e",
  "--term-ansi-cyan": "#0f4b6e",
  "--term-ansi-white": "#6172b0",
  "--term-ansi-bright-black": "#4c505e",
  "--term-ansi-bright-red": "#a8352a",
  "--term-ansi-bright-green": "#3d5a1f",
  "--term-ansi-bright-yellow": "#6c4f1f",
  "--term-ansi-bright-blue": "#1f3d6c",
  "--term-ansi-bright-magenta": "#3f2a6e",
  "--term-ansi-bright-cyan": "#0a3550",
  "--term-ansi-bright-white": "#1f2335",
};

// Solarized Light — keep the classic accents but swap white/brights so
// they're not Solarized's chrome greys (which vanish on `--reader-bg`).
const SOLARIZED_LIGHT_PAL: TermPalette = {
  "--term-ansi-black": "#073642",
  "--term-ansi-red": "#dc322f",
  "--term-ansi-green": "#859900",
  "--term-ansi-yellow": "#b58900",
  "--term-ansi-blue": "#268bd2",
  "--term-ansi-magenta": "#d33682",
  "--term-ansi-cyan": "#2aa198",
  "--term-ansi-white": "#586e75",
  "--term-ansi-bright-black": "#002b36",
  "--term-ansi-bright-red": "#a3251f",
  "--term-ansi-bright-green": "#5d6b00",
  "--term-ansi-bright-yellow": "#8c6900",
  "--term-ansi-bright-blue": "#1a6da8",
  "--term-ansi-bright-magenta": "#a82862",
  "--term-ansi-bright-cyan": "#1f7872",
  "--term-ansi-bright-white": "#073642",
};

// One Light — Atom One Light's published terminal palette.
const ONE_LIGHT_PAL: TermPalette = {
  "--term-ansi-black": "#383a42",
  "--term-ansi-red": "#e45649",
  "--term-ansi-green": "#50a14f",
  "--term-ansi-yellow": "#c18401",
  "--term-ansi-blue": "#4078f2",
  "--term-ansi-magenta": "#a626a4",
  "--term-ansi-cyan": "#0184bc",
  "--term-ansi-white": "#a0a1a7",
  "--term-ansi-bright-black": "#5c6370",
  "--term-ansi-bright-red": "#b8392f",
  "--term-ansi-bright-green": "#3d7a3c",
  "--term-ansi-bright-yellow": "#946301",
  "--term-ansi-bright-blue": "#2a5fc8",
  "--term-ansi-bright-magenta": "#7e1d7c",
  "--term-ansi-bright-cyan": "#01658f",
  "--term-ansi-bright-white": "#383a42",
};

// Ink is the headline dark theme — Tokyo-Night-derived, matches the
// dark fallback.
const INK_PAL: TermPalette = DARK_FALLBACK;

const PER_THEME: Record<string, TermPalette> = {
  paper: PAPER_PAL,
  sepia: SEPIA_PAL,
  ink: INK_PAL,
  "tokyo-night": DARK_FALLBACK,
  "tokyo-night-storm": DARK_FALLBACK,
  "solarized-dark": SOLARIZED_DARK_PAL,
  "solarized-light": SOLARIZED_LIGHT_PAL,
  dracula: DRACULA_PAL,
  "one-dark": ONE_DARK_PAL,
  "one-light": ONE_LIGHT_PAL,
  "gruvbox-dark": GRUVBOX_DARK_PAL,
  nord: NORD_PAL,
  "rose-pine": ROSE_PINE_PAL,
  "rose-pine-dawn": ROSE_PINE_DAWN_PAL,
  "github-dark": GITHUB_DARK_PAL,
  "github-light": GITHUB_LIGHT_PAL,
  "catppuccin-latte": CATPPUCCIN_LATTE_PAL,
  "catppuccin-macchiato": CATPPUCCIN_MOCHA_PAL,
  "catppuccin-mocha": CATPPUCCIN_MOCHA_PAL,
  "ayu-dark": AYU_DARK_PAL,
};

/** Resolves the ANSI 16 palette for a theme. Falls back to a generic
 *  light or dark palette based on the theme's `type` for any theme
 *  not in the curated dictionary above (including user-defined custom
 *  themes from `<app_config>/themes/*.json`). */
export function paletteForTheme(
  themeId: string,
  type: "light" | "dark",
): TermPalette {
  return (
    PER_THEME[themeId] ?? (type === "dark" ? DARK_FALLBACK : LIGHT_FALLBACK)
  );
}
