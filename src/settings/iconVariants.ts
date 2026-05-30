/** Hardcoded list of bundled icon variants. To add a new one: drop a
 *  PNG (≥1024px, with the squircle baked in) at
 *  `src-tauri/icons/variants/<id>.png` and append an entry here. The
 *  `id` is what gets persisted in settings and resolved by the Rust
 *  side at swap time. */
export interface IconVariant {
  id: string;
  label: string;
}

export const ICON_VARIANTS: IconVariant[] = [
  { id: "default", label: "Default" },
  { id: "light", label: "Light" },
  { id: "mono-light", label: "Mono Light" },
  { id: "mono-dark", label: "Mono Dark" },
];
