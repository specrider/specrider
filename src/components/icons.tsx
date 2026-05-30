// biome-ignore-all lint/a11y/noSvgWithoutTitle: icons are decorative by default; controls provide accessible labels.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** Default icons to aria-hidden so consumers don't have to remember.
 *  When a caller actually passes aria-label / aria-labelledby (or an
 *  explicit aria-hidden), their choice wins. */
function iconAriaDefaults(p: IconProps): IconProps {
  if (
    p["aria-label"] != null ||
    p["aria-labelledby"] != null ||
    p["aria-hidden"] != null
  ) {
    return p;
  }
  return { ...p, "aria-hidden": true };
}

export const Icon = {
  Search: (p: IconProps) => (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      {...iconAriaDefaults(p)}
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L13.5 13.5" strokeLinecap="round" />
    </svg>
  ),
  Branch: (p: IconProps) => (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      {...iconAriaDefaults(p)}
    >
      <circle cx="3" cy="2.5" r="1.2" />
      <circle cx="3" cy="9.5" r="1.2" />
      <circle cx="9" cy="5.5" r="1.2" />
      <path d="M3 4v4" />
      <path d="M3 5.5h3.5a1.5 1.5 0 011.5 1.5v-1.5" />
    </svg>
  ),
  Sidebar: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </svg>
  ),
  Outline: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </svg>
  ),
  Search2: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L13.5 13.5" strokeLinecap="round" />
    </svg>
  ),
  Note: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      {...iconAriaDefaults(p)}
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 11v0" strokeLinecap="round" />
    </svg>
  ),
  Bolt: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      {...iconAriaDefaults(p)}
    >
      <path d="M9 2L4 9h3l-1 5 5-7H8l1-5z" strokeLinejoin="round" />
    </svg>
  ),
  Editor: (p: IconProps) => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <path d="M3 11l7-7 2 2-7 7-2.5.5.5-2.5z" strokeLinejoin="round" />
    </svg>
  ),
  More: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...iconAriaDefaults(p)}
    >
      <circle cx="4" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12" cy="8" r="1.2" />
    </svg>
  ),
  Read: (p: IconProps) => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <path
        d="M2 4c2-1 4-1 6 0v9c-2-1-4-1-6 0V4zM14 4c-2-1-4-1-6 0v9c2-1 4-1 6 0V4z"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Pencil: (p: IconProps) => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <path
        d="M3 13l2-.5 7-7-1.5-1.5-7 7L3 13zM10 3.5L11.5 5"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Split: (p: IconProps) => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <rect x="2" y="3" width="5.5" height="10" rx="1" />
      <rect x="8.5" y="3" width="5.5" height="10" rx="1" />
    </svg>
  ),
  Markdown: (p: IconProps) => (
    <svg
      width="20"
      height="13"
      viewBox="0 0 24 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <rect x="1" y="1.5" width="22" height="13" rx="2" />
      <path d="M4.5 11.5V5l2.5 3.5L9.5 5v6.5" />
      <path d="M14.5 5v6.5" />
      <path d="M14.5 11.5L17 9M14.5 11.5L12 9" />
    </svg>
  ),
  Terminal: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      {...iconAriaDefaults(p)}
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7l2 1.5L5 10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 10.5h3" strokeLinecap="round" />
    </svg>
  ),
  Grip: (p: IconProps) => (
    <svg
      width="10"
      height="14"
      viewBox="0 0 10 14"
      fill="currentColor"
      {...iconAriaDefaults(p)}
    >
      <circle cx="3" cy="3" r="1.1" />
      <circle cx="7" cy="3" r="1.1" />
      <circle cx="3" cy="7" r="1.1" />
      <circle cx="7" cy="7" r="1.1" />
      <circle cx="3" cy="11" r="1.1" />
      <circle cx="7" cy="11" r="1.1" />
    </svg>
  ),
  Caret: (p: IconProps) => (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
  ChevronL: (p: IconProps) => (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M10 4l-4 4 4 4" />
    </svg>
  ),
  ChevronR: (p: IconProps) => (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
  Pin: (p: IconProps) => (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M9.5 2.5l4 4-2 1-2 4-1 1-2.5-2.5L3 13l1-3 1-1 4-2 1-2 -.5-2.5z" />
      <path d="M5.5 10.5L2.5 13.5" />
    </svg>
  ),
  Plus: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  ),
  FoldVertical: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M3 8h10" strokeDasharray="1.5 1.5" />
      <path d="M8 2v5" />
      <path d="M5.5 4.5L8 7L10.5 4.5" />
      <path d="M8 14V9" />
      <path d="M5.5 11.5L8 9L10.5 11.5" />
    </svg>
  ),
  UnfoldVertical: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M3 8h10" strokeDasharray="1.5 1.5" />
      <path d="M8 7V2" />
      <path d="M5.5 4.5L8 2L10.5 4.5" />
      <path d="M8 9v5" />
      <path d="M5.5 11.5L8 14L10.5 11.5" />
    </svg>
  ),
  /** Diagonal arrows out of a corner — "expand to full view". Used to
   *  open the table viewer modal. */
  Expand: (p: IconProps) => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 9 7" />
      <path d="M6.5 13.5h-4v-4" />
      <path d="M2.5 13.5 7 9" />
    </svg>
  ),
  /** Plain × for close affordances. */
  Close: (p: IconProps) => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  ),
  /** Workspace-trust shield. Outline shape with an inner mark slot.
   *  Variant is conveyed through the parent's class (`trust-shield`
   *  base + `trusted` / `untrusted` / `ask` modifier) — the path
   *  itself stays neutral so theme colors flow through. */
  Shield: (p: IconProps) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...iconAriaDefaults(p)}
    >
      <path d="M8 1.75 2.75 3.5v4.25c0 3.25 2.5 5.6 5.25 6.5 2.75-.9 5.25-3.25 5.25-6.5V3.5L8 1.75Z" />
    </svg>
  ),
};
