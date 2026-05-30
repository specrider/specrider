/** Resolves a relative href (`./foo.md`, `../shared/bar.md`) against
 *  the directory of `currentPath`. Returns `null` when the resolution
 *  would walk above the project root, or when `href` is empty.
 *
 *  Both inputs use forward slashes (matching `Plan.path`). The result
 *  is plans-root-relative — no leading slash. */
export function resolveRelativePath(
  currentPath: string,
  href: string,
): string | null {
  if (!href) return null;
  const currentDir = currentPath.split("/").slice(0, -1);
  const segments = href.split("/");
  const out = [...currentDir];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}
