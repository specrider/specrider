/** Stamp the host OS onto `<html>` as `os-mac` / `os-linux` / `os-windows`
 *  so layout that depends on platform chrome (notably the macOS overlay
 *  traffic-light gutter on `.titlebar`) can be tuned in plain CSS without
 *  a backend round-trip. Detection is via the user-agent string Tauri's
 *  webview reports — synchronous so the class is in place before the
 *  first paint and we don't see a one-frame layout shift. */
export type HostOs = "mac" | "linux" | "windows" | "other";

export function detectHostOs(): HostOs {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

export function applyPlatformClass(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const cls of Array.from(root.classList)) {
    if (cls.startsWith("os-")) root.classList.remove(cls);
  }
  root.classList.add(`os-${detectHostOs()}`);
}
