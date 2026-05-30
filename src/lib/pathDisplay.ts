export function formatHomePath(
  path: string,
  home: string | null | undefined,
): string {
  if (!home) return path;
  const trimmed = home.replace(/[\\/]+$/, "");
  if (path === trimmed) return "~";
  if (path.startsWith(`${trimmed}/`)) return `~${path.slice(trimmed.length)}`;
  if (path.startsWith(`${trimmed}\\`)) return `~${path.slice(trimmed.length)}`;
  return path;
}
