---
title: Keyboard Shortcuts
tags: [guide, hotkeys, keyboard]
---

# Keyboard Shortcuts

A complete reference for every keyboard shortcut in SpecRider. Shortcuts are designed to match macOS conventions where possible (browser-style ⌘[ / ⌘] for back/forward, ⌘, for Settings, etc.) so muscle memory from other apps carries over.

## Window management

| Shortcut | Action |
|---|---|
| `⌘N` *or* `⌘⇧N` | New window. Opens to the default folder if one is configured in Settings → Documents, otherwise the empty-state Choose-folder CTA |
| `⌘⇧O` | Open Folder in New Window… — pick a directory in the dialog, a fresh window spawns pointed at it |
| `⌘O` | Open Plans Folder… — pick a directory; the *current* window switches to it |
| `⌘⇧R` | Reveal Plans Folder in Finder |
| `⌘W` | Close window. macOS keeps the app running when the last one closes (configurable in Settings → System & Updates) |
| `⌘Q` | Quit SpecRider |
| `⌘,` | Open Settings (or focus an existing Settings window) |

Window-switching uses the standard macOS pattern: `⌘\`` cycles between SpecRider windows; `⌘Tab` switches between apps. The OS title for each window shows just the project dir name — so you can tell windows apart in Mission Control without opening them.

## Reader / Editor

| Shortcut | Action |
|---|---|
| `⌘E` | Toggle between Read and Markdown modes |
| `Shift+Tab` | Same — alternative for users who prefer it (skipped when focus is inside an editor or form field, so it doesn't conflict with reverse-tab navigation or CodeMirror's outdent) |
| `⌘[` | Back — go to the previous plan / heading you visited |
| `⌘]` | Forward — undo a back |

Both back/forward push the current `(plan, heading)` pair onto a history stack. Cross-plan navigations (link clicks in the document, document-row clicks in the browser) are tracked; in-doc heading jumps from the outline aren't (otherwise the back stack would fill with intra-doc noise).

## Markdown editor (CodeMirror)

When the reader is in Markdown mode, the editor uses CodeMirror's standard keymap. Highlights:

| Shortcut | Action |
|---|---|
| `⌘F` | Find — opens CodeMirror's search panel |
| `⌘G` / `⌘⇧G` | Find next / previous |
| `⌘Z` / `⌘⇧Z` | Undo / Redo |
| `⌘A` | Select all |
| `Tab` / `Shift+Tab` | Indent / Outdent (current line or selection) |
| `⌘D` | Select next occurrence of the current word |
| `⌘L` | Select current line |
| `⌘/` | Toggle line comment (where applicable) |

Selection-modifying shortcuts (`⌘←`, `Option+←`, `⌘Shift+→`, etc.) follow the standard macOS conventions for word/line/document boundaries.

## Outline (right pane)

| Shortcut | Action |
|---|---|
| Click a heading | Scroll the reader to that section |
| Click a task | Scroll the reader to that task and flash-highlight the row |
| Click the disclosure caret on a heading | Fold / unfold its tasks list (does *not* trigger a jump) |

Active heading auto-tracks as you scroll the reader, with the matching outline row highlighted.

## Reader folding

| Shortcut | Action |
|---|---|
| Click an h1 / h2 / h3 heading | Toggle that section's collapse state |
| `⌘⌥.` | Fold every section in the active plan; press again to unfold all |

A faint chevron appears in the heading's left margin on hover and stays visible when the section is collapsed. Outline jumps and back/forward navigation auto-expand any collapsed ancestors so the target heading lands in view. Per-plan fold state persists in `localStorage` per window.

## Documents browser (left pane)

| Action | Result |
|---|---|
| Click a plan row | Switch to it (pushes current onto the back stack) |
| Click a folder header | Toggle that folder's expand/collapse state |
| Type in the search field | Filters plans by both title and folder path; matching folders auto-expand |
| Click `⌄` in the header | Collapse all folders |
| Click `›` in the header | Expand all folders |
| Click `×` in the search field | Clear the search |

## Change-awareness (unstaged git changes)

When the active plan has unstaged changes vs `HEAD`, gutters in both modes light up and the status bar shows the breakdown.

| Shortcut | Action |
|---|---|
| `⌘⇧J` | Jump to the next hunk in the active plan |
| `⌘⇧K` | Jump to the previous hunk |
| `⌘⇧D` | Toggle the inline diff popover for the current hunk |
| `⌘⇧B` | Toggle per-line blame for the session (independent of the persisted Settings → Git toggle) |

Click the M chip in the status bar (or any colored bar in the gutter / outline) to cycle through hunks. The diff popover renders before/after for a single hunk; v1 is read-only.

Per-line blame is opt-in (default off in Settings → Git) since `git blame` is heavier per file. When on, rest the cursor on a line for ≥300ms in the Markdown editor — an end-of-line annotation shows `<sha> · <author> · <relative-time> — <subject>`. Click the annotation to open the commit popover (subject + body, file list, Copy SHA, Open on GitHub when origin is github). Lines with no commit yet read `(working tree)` in italics.

## Status bar (bottom)

The status bar shows the current mode, line count, and the active section under the cursor. The `⌘E` and `⌘K` hints are reminders, not active surfaces.

## Settings (`⌘,`)

The Settings window is its own keyboard surface — Tab cycles fields, arrow keys navigate sliders / radio groups. `Esc` doesn't close the window (so you can press it inside dropdowns without losing your place); use `⌘W` to close.

## Window resize / reposition

The standard macOS shortcuts apply: `⌃⌘F` toggles full screen for the focused window. Pane widths inside SpecRider are draggable but not yet hotkey-bound.

## Planned / not yet shipped

Several shortcuts are spec'd out but not yet implemented:

| Shortcut | Plan | What it'll do |
|---|---|---|
| `⌘T` | search-hotkeys | "Go to file" command palette — fuzzy filter plans, Enter to switch |
| `⌘F` (Read mode) | search-hotkeys | Find bar in the active doc using the CSS Custom Highlight API. Markdown mode already has CodeMirror's ⌘F |
| `⌘B` | search-hotkeys + bookmarks | Toggle the cross-plan bookmarks popover |
| `⌘D` (Read mode) | bookmarks | Bookmark the current section (or selection, if there's one) |
| `⌘⌥.` | viewer-enhancements | Fold all sections / unfold all |
| `Enter` / `F2` (focused plan row) | doc-management | Inline rename |
| `Delete` (focused plan row) | doc-management | Move to Trash (with confirm) |

These ship as their respective plans land.
