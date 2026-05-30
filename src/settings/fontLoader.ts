import { cacheFont, readCachedFont } from "../tauri/api";
import { GOOGLE_FONT_FAMILIES } from "./google-fonts";

/** Inject a `<link rel=stylesheet>` for the given Google Fonts family
 *  if it isn't already present. Idempotent — safe to call repeatedly
 *  with the same family. Skips locally-known fonts (`-apple-system`,
 *  `Menlo`, `Charter`, etc.) that the OS already provides.
 *
 *  Tries the offline cache first: if `<app_config>/fonts/<slug>.css`
 *  exists, the cached CSS is injected as a `<style>` element pointing
 *  at our `specrider-font://` protocol. Otherwise the live Google
 *  Fonts CSS API is used. Either path triggers a background
 *  `cacheFont(family)` so the next launch loads from disk. */
export function loadGoogleFont(family: string): void {
  if (!family) return;
  if (!GOOGLE_FONT_FAMILIES.has(family)) return;

  const id = `mk-font-${slug(family)}`;
  if (document.getElementById(id)) return;

  // Reserve the id immediately so re-entrant calls during the await
  // don't double-inject.
  const placeholder = document.createElement("style");
  placeholder.id = id;
  document.head.appendChild(placeholder);

  void readCachedFont(family)
    .then((cached) => {
      if (cached) {
        placeholder.textContent = cached.css;
        return;
      }
      // Not cached — fall back to a live <link> to Google Fonts so
      // the user gets the font now, then cache for next time.
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeFamily(family)}:wght@400;500;600;700&display=swap`;
      placeholder.replaceWith(link);
      link.id = id;
      // Background-cache so subsequent launches go offline.
      void cacheFont(family).catch((e) =>
        console.warn(`cacheFont(${family}) failed:`, e),
      );
    })
    .catch(() => {
      // readCachedFont errored (no plansRoot, IPC issue, etc) — fall
      // back to the live link path.
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeFamily(family)}:wght@400;500;600;700&display=swap`;
      placeholder.replaceWith(link);
      link.id = id;
    });
}

function encodeFamily(family: string): string {
  return family.replace(/ /g, "+");
}

function slug(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
