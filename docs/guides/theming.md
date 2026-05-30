---
title: Theming Guide
tags: [guide, themes, customization]
---

# Theming Guide — Authoring a Custom SpecRider Theme

SpecRider ships with 20 hand-tuned themes (Paper, Sepia, Tokyo Night, Dracula, etc.), but you can drop a JSON file into your plans folder and have it appear as a custom theme alongside the built-ins. This guide walks through the file format, every variable SpecRider reads, and how to iterate quickly.

## Where custom themes live

Themes are **user-level preferences**, not project-level — they live in SpecRider's app config directory, the same folder that holds `config.json`:

| Platform | Path |
|---|---|
| macOS   | `~/Library/Application Support/dev.specrider.app/themes/` |
| Linux   | `~/.config/dev.specrider.app/themes/` (XDG) |
| Windows | `%APPDATA%\dev.specrider.app\themes\` |

SpecRider creates the `themes/` folder on first launch. Drop a `.json` file in there and it shows up in Settings → Appearance within a second of saving — a filesystem watcher catches the change.

If you want to share themes between projects or with collaborators, just copy the JSON file. Themes are plain text — git-friendly if you want to track them.

## File format

A theme is a JSON object with a small set of required fields and a free-form `variables` map:

```jsonc
{
  "id": "my-theme",
  "name": "My Theme",
  "type": "dark",
  "author": "Your Name",
  "variables": {
    "--paper": "oklch(0.20 0.02 280)",
    "--accent": "oklch(0.78 0.13 305)"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | ✓ | Unique slug. Used as the React key and persisted as `settings.theme`. Must not collide with a built-in id. |
| `name` | ✓ | Display name in the picker. |
| `type` | ✓ | `"light"` or `"dark"`. Determines which group the picker shows the theme in and which polarity defaults are used for unset variables. |
| `author` |   | Optional. Surfaces in the picker tooltip. |
| `variables` | ✓ | Map of CSS custom property → value. Every key optional individually; missing variables inherit from the type-appropriate base theme (Paper for light, Ink for dark). |

You don't have to define every variable. A minimal theme can override just the accent and let everything else fall through to the base.

## Color format

SpecRider's built-in themes are authored in **OKLCH** — a perceptually uniform color space that handles palette adjustments better than HSL or hex. All CSS color formats work, though, so use whatever you're comfortable with:

- `oklch(0.78 0.13 250)` — lightness 0–1, chroma 0–~0.4, hue 0–360
- `#5577dd` or `#57d` — standard hex
- `rgb(85, 119, 221)` or `rgba(85, 119, 221, 0.9)`
- `hsl(225 70% 60%)`
- Named CSS colors (`tomato`, `slategray`) work too, though hard to scale.

OKLCH is recommended because it lets you derive related shades by tweaking just lightness — for example, accent-soft is usually accent with `+0.4` lightness and `× 0.3` chroma.

A handy reference: [oklch.com](https://oklch.com) for picking and previewing values.

## Variable reference

SpecRider's chrome and reader render entirely from CSS custom properties. Setting these in your theme overrides the active palette globally.

### Surfaces

The four "paper" tiers stack from background outward; chrome panes (browser, outline) sit on `--paper-2`, headers on `--paper`.

| Variable | What it controls |
|---|---|
| `--paper` | Default app surface — title bar, reader, settings. The "light" or "dark" base color. |
| `--paper-2` | One step away from `--paper` — Plans browser background, Outline pane, frontmatter strip. |
| `--paper-3` | Two steps away — hover backgrounds, code blocks, callout backgrounds when not theme-typed. |
| `--reader-bg` | Reader-pane specific override. Slightly different from `--paper` to give the reading surface its own presence. |

### Foreground / text

Four "ink" tiers used for body text, secondary text, dim text, and disabled text.

| Variable | What it controls |
|---|---|
| `--ink` | Body text color, primary headings, button labels. |
| `--ink-2` | Secondary text — paragraph emphasis, sidebar item titles. |
| `--ink-3` | Tertiary text — captions, hints, less-important labels. |
| `--ink-4` | Quaternary — placeholder text, disabled states, scrollbar thumbs. |

### Lines

| Variable | What it controls |
|---|---|
| `--rule` | Stronger borders — pane separators, settings dividers. |
| `--rule-soft` | Subtle dividers — table cells, callout outlines. |

### Accent

The accent is the single hue that says "active" / "selected" / "linked." Used for active-row glow, splitter hover, links, status pill, focus rings.

| Variable | What it controls |
|---|---|
| `--accent` | Primary accent. |
| `--accent-soft` | Light fill version — accent backgrounds, selected-row tint. |
| `--accent-fg` | High-contrast foreground for use *on* accent backgrounds. |

### Status hues

Three semantic colors with `-soft` companion fills.

| Variable | What it controls |
|---|---|
| `--sage` / `--sage-soft` | Done state, success indicators, completed task checkmarks, progress-bar fill. |
| `--amber` / `--amber-soft` | Warning, in-progress, "important" callout border. |
| `--rose` / `--rose-soft` | Error, destructive action, removed-line indicator. |

### Callouts

GitHub-style callouts (`> [!NOTE]` and `> [!IMPORTANT]`) get their own backgrounds so they sit clearly inside body text.

| Variable | What it controls |
|---|---|
| `--callout-note-bg` | NOTE callout background. Usually a tinted accent. |
| `--callout-note-border` | NOTE callout border. |
| `--callout-imp-bg` | IMPORTANT callout background. Usually a tinted amber. |
| `--callout-imp-border` | IMPORTANT callout border. |

## Walkthrough — a minimal custom theme

Say you want a dark theme with a teal accent on top of the default Ink palette. Just drop:

```jsonc
{
  "id": "ink-teal",
  "name": "Ink Teal",
  "type": "dark",
  "variables": {
    "--accent": "oklch(0.74 0.13 195)",
    "--accent-soft": "oklch(0.32 0.07 195)",
    "--accent-fg": "oklch(0.82 0.12 195)"
  }
}
```

Save as `~/Library/Application Support/dev.specrider.app/themes/ink-teal.json` (macOS) and within a second the theme appears in Settings → Appearance → Dark theme → Custom. Click to apply.

For a fuller example, copy any built-in theme's `variables` block from `src/settings/themes.ts` into a new file and tune from there.

## Walkthrough — a complete theme

```jsonc
{
  "id": "midnight",
  "name": "Midnight",
  "type": "dark",
  "author": "you",
  "variables": {
    "--paper": "oklch(0.16 0.02 250)",
    "--paper-2": "oklch(0.19 0.022 250)",
    "--paper-3": "oklch(0.23 0.025 250)",
    "--rule": "oklch(0.30 0.028 250)",
    "--rule-soft": "oklch(0.25 0.024 250)",
    "--ink": "oklch(0.92 0.014 250)",
    "--ink-2": "oklch(0.78 0.018 250)",
    "--ink-3": "oklch(0.60 0.022 250)",
    "--ink-4": "oklch(0.45 0.022 250)",
    "--accent": "oklch(0.74 0.13 240)",
    "--accent-soft": "oklch(0.30 0.08 240)",
    "--accent-fg": "oklch(0.84 0.12 240)",
    "--sage": "oklch(0.78 0.13 145)",
    "--sage-soft": "oklch(0.32 0.06 145)",
    "--amber": "oklch(0.82 0.12 80)",
    "--amber-soft": "oklch(0.34 0.06 80)",
    "--rose": "oklch(0.74 0.16 15)",
    "--rose-soft": "oklch(0.34 0.07 15)",
    "--reader-bg": "oklch(0.18 0.02 250)",
    "--callout-note-bg": "oklch(0.28 0.07 240)",
    "--callout-note-border": "oklch(0.36 0.10 240)",
    "--callout-imp-bg": "oklch(0.30 0.07 60)",
    "--callout-imp-border": "oklch(0.38 0.10 60)"
  }
}
```

## Iterating on a theme

- **Live updates**: changing the JSON triggers a `themes-changed` event; the picker refreshes within ~500ms. If your theme is currently active and you save the file, you'll see the change live in the reader.
- **Bad JSON**: parse errors are logged to the dev console (open the WebView devtools with `⌥⌘I`) and the theme is silently dropped from the picker. Fix the JSON and save again.
- **Missing variables**: anything you don't set inherits from the base theme (Paper for `type: "light"`, Ink for `type: "dark"`). So you can ship a "just change the accent" theme with three lines.
- **Picker swatches**: the picker card samples `--paper`, `--ink`, `--accent`, `--sage` to render the four-color preview. If you want a more legible swatch, set those four explicitly.

## Sharing themes

Custom themes are plain JSON. Send the file to a collaborator, they drop it into their own `themes/` folder, done. If you want versioning, commit the JSON files in a personal dotfiles / preferences repo — there's no requirement that they live anywhere in particular on disk as long as you copy them into the app config dir on each machine.

## Tips

- **Start dark.** Tuning a dark theme is faster than tuning a light one — the eye is more forgiving of small color shifts in the dark range.
- **Use OKLCH.** Lightness is your most-used dial; OKLCH lets you derive entire palettes from one base hue by sweeping `l`.
- **Test against `INDEX.md`**, the `_sample.md` (if you have one), and any plan with a callout. Those exercise the full set of surfaces.
- **Watch contrast.** Lock `--ink` against `--paper` at 4.5:1+ for body text legibility (WCAG AA). Tools like the Chrome DevTools color picker will show the ratio.

## Troubleshooting

| Issue | Likely cause |
|---|---|
| Theme doesn't appear in picker | JSON parse error — check dev console |
| Theme appears but looks broken | Missing or invalid variable values; partial fall-through to base |
| Picker shows the theme but selecting it does nothing | The `id` collides with a built-in (e.g. `paper`, `ink`) — rename it |
| Reader text unreadable | `--ink` and `--paper` too close in lightness; widen the contrast |
| Accent washed out | `--accent-soft` too light — bring it closer to the accent's lightness |

If something's still off, open the WebView devtools (⌥⌘I) and inspect any element. The active CSS variable values are visible in the Computed panel under "Custom Properties."
