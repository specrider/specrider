/** Hrefs we refuse to render. `javascript:` and `vbscript:` execute
 *  on navigation; `data:` can carry HTML+inline-script. None belong
 *  in a plan — sanitize at the `<a>` source so cmd/middle-click
 *  (which bypasses our onClick intercept) can't reach them. */
const UNSAFE_HREF_RE = /^\s*(javascript|vbscript|data):/i;

export function safeHref(url: string): string | undefined {
  if (UNSAFE_HREF_RE.test(url)) return undefined;
  return url;
}
