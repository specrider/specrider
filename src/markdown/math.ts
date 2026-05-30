import katex from "katex";

/** Synchronously typesets a LaTeX-ish math expression to HTML.
 *  `throwOnError: false` so a malformed expression renders as red
 *  fallback text instead of crashing the whole document.
 *  `trust: false` is KaTeX's default, but pin it explicitly: it
 *  blocks the `\href`, `\url`, `\includegraphics`, and `\htmlClass`
 *  macros, which would otherwise be a vector for `javascript:` URLs
 *  or attribute injection in author-controlled math sources. */
export function renderMath(src: string, displayMode: boolean): string {
  return katex.renderToString(src, {
    displayMode,
    throwOnError: false,
    output: "html",
    strict: "ignore",
    trust: false,
  });
}
