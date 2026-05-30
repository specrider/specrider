use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// `<app_config>/fonts/` — root for all cached font assets.
fn fonts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    Ok(dir.join("fonts"))
}

/// Lowercase ASCII slug of a Google Font family. "Tokyo Night" → "tokyo-night".
fn family_slug(family: &str) -> String {
    let s: String = family
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    s.trim_matches('-').replace("--", "-").replace("--", "-")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFont {
    pub family: String,
    pub slug: String,
    pub css: String,
}

/// Downloads the Google Fonts CSS for `family`, downloads each woff2 to
/// `<app_config>/fonts/<slug>/<n>.woff2`, then rewrites the CSS so
/// every `url(…)` points at our `specrider-font://` protocol. Returns
/// the rewritten CSS string the frontend should inject as a
/// `<style>` element.
#[tauri::command]
pub async fn cache_font(family: String, app: AppHandle) -> Result<CachedFont, String> {
    let slug = family_slug(&family);
    let fonts_root = fonts_dir(&app)?;
    let family_dir = fonts_root.join(&slug);
    std::fs::create_dir_all(&family_dir).map_err(|e| format!("mkdir fonts dir: {e}"))?;

    let css_url = format!(
        "https://fonts.googleapis.com/css2?family={}:wght@400;500;600;700&display=swap",
        family.replace(' ', "+")
    );

    let client = reqwest::Client::builder()
        // Google Fonts serves different woff2 subsets / variants based
        // on the User-Agent. Use a modern browser UA so we get the
        // small woff2 files (vs woff for old browsers).
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 \
            (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        )
        .build()
        .map_err(|e| format!("reqwest client: {e}"))?;

    let css_text = client
        .get(&css_url)
        .send()
        .await
        .map_err(|e| format!("fetch css: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read css body: {e}"))?;

    // Find every `url(https://...woff2)` reference and download it.
    // Replace with `specrider-font://<slug>/<n>.woff2` in the rewritten
    // CSS we hand back to the frontend.
    let mut rewritten = String::with_capacity(css_text.len());
    let mut cursor = 0usize;
    let mut counter = 0u32;
    while let Some(rel) = css_text[cursor..].find("url(") {
        let url_start = cursor + rel + 4;
        let url_end = match css_text[url_start..].find(')') {
            Some(e) => url_start + e,
            None => break,
        };
        let url = css_text[url_start..url_end].trim_matches(|c| c == '"' || c == '\'');
        let lower = url.to_ascii_lowercase();
        let is_woff2 = lower.contains(".woff2");
        let is_https = url.starts_with("https://");
        rewritten.push_str(&css_text[cursor..url_start]);
        if is_https && is_woff2 {
            let local_name = format!("{counter}.woff2");
            counter += 1;
            // Best-effort download. Skip rewrite if it fails — the
            // original https URL stays in the CSS, falling back to the
            // network on first paint.
            match download_to(&client, url, &family_dir.join(&local_name)).await {
                Ok(()) => {
                    rewritten.push_str(&format!("specrider-font://localhost/{slug}/{local_name}"))
                }
                Err(e) => {
                    eprintln!("font download failed for {url}: {e}");
                    rewritten.push_str(url);
                }
            }
        } else {
            rewritten.push_str(url);
        }
        rewritten.push(')');
        cursor = url_end + 1;
    }
    rewritten.push_str(&css_text[cursor..]);

    // Persist the rewritten CSS so subsequent launches can read it
    // back without re-fetching from Google.
    let css_path = fonts_root.join(format!("{slug}.css"));
    std::fs::write(&css_path, &rewritten).map_err(|e| format!("write cached css: {e}"))?;

    Ok(CachedFont {
        family,
        slug,
        css: rewritten,
    })
}

#[tauri::command]
pub fn read_cached_font(family: String, app: AppHandle) -> Result<Option<CachedFont>, String> {
    let slug = family_slug(&family);
    let css_path = fonts_dir(&app)?.join(format!("{slug}.css"));
    match std::fs::read_to_string(&css_path) {
        Ok(css) => Ok(Some(CachedFont { family, slug, css })),
        Err(_) => Ok(None),
    }
}

async fn download_to(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("get {url}: {e}"))?;
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    std::fs::write(dest, &bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(())
}

/// Resolves a `specrider-font://<slug>/<file>` URI to bytes from the
/// local cache dir. Returns `None` if the file isn't cached (the
/// custom protocol handler will then 404).
pub fn read_font_asset(app: &AppHandle, slug: &str, file: &str) -> Option<Vec<u8>> {
    let dir = fonts_dir(app).ok()?;
    read_font_asset_in(&dir, slug, file)
}

/// Pure variant taking the fonts dir as an explicit argument so it can
/// be exercised from tests without an `AppHandle`. Refuses any path
/// that escapes the fonts dir via `..` or a symlink.
pub fn read_font_asset_in(fonts_dir: &Path, slug: &str, file: &str) -> Option<Vec<u8>> {
    let path = fonts_dir.join(slug).join(file);
    let canon_dir = fonts_dir.canonicalize().ok()?;
    let canon_path = path.canonicalize().ok()?;
    if !canon_path.starts_with(&canon_dir) {
        return None;
    }
    std::fs::read(canon_path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write(root: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, bytes).unwrap();
        p
    }

    // ---- read_font_asset_in ----

    #[test]
    fn reads_existing_file() {
        let dir = tempdir().unwrap();
        write(dir.path(), "inter/0.woff2", b"OTTO");
        let bytes = read_font_asset_in(dir.path(), "inter", "0.woff2");
        assert_eq!(bytes.as_deref(), Some(&b"OTTO"[..]));
    }

    #[test]
    fn returns_none_for_missing_file() {
        let dir = tempdir().unwrap();
        assert!(read_font_asset_in(dir.path(), "inter", "0.woff2").is_none());
    }

    #[test]
    fn refuses_dotdot_in_slug() {
        let parent = tempdir().unwrap();
        let fonts = parent.path().join("fonts");
        fs::create_dir_all(&fonts).unwrap();
        write(parent.path(), "outside.woff2", b"OTTO");
        assert!(read_font_asset_in(&fonts, "..", "outside.woff2").is_none());
    }

    #[test]
    fn refuses_dotdot_in_file() {
        let parent = tempdir().unwrap();
        let fonts = parent.path().join("fonts");
        let inter = fonts.join("inter");
        fs::create_dir_all(&inter).unwrap();
        write(parent.path(), "outside.woff2", b"OTTO");
        assert!(read_font_asset_in(&fonts, "inter", "../../outside.woff2").is_none());
    }

    #[test]
    fn refuses_absolute_file_path() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let abs = write(outside.path(), "x.woff2", b"OTTO");
        assert!(read_font_asset_in(dir.path(), "inter", abs.to_str().unwrap()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escape() {
        let parent = tempdir().unwrap();
        let fonts = parent.path().join("fonts");
        let inter = fonts.join("inter");
        fs::create_dir_all(&inter).unwrap();
        let secret = parent.path().join("secret.woff2");
        fs::write(&secret, b"OTTO").unwrap();
        std::os::unix::fs::symlink(&secret, inter.join("smuggled.woff2")).unwrap();
        assert!(read_font_asset_in(&fonts, "inter", "smuggled.woff2").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_inside_fonts_dir() {
        let dir = tempdir().unwrap();
        let inter = dir.path().join("inter");
        fs::create_dir_all(&inter).unwrap();
        fs::write(inter.join("real.woff2"), b"OTTO").unwrap();
        std::os::unix::fs::symlink(inter.join("real.woff2"), inter.join("alias.woff2")).unwrap();
        let bytes = read_font_asset_in(dir.path(), "inter", "alias.woff2");
        assert_eq!(bytes.as_deref(), Some(&b"OTTO"[..]));
    }

    // ---- family_slug ----

    #[test]
    fn slug_basic_lowercase() {
        assert_eq!(family_slug("Inter"), "inter");
    }

    #[test]
    fn slug_replaces_spaces_with_hyphens() {
        assert_eq!(family_slug("Tokyo Night"), "tokyo-night");
        assert_eq!(family_slug("JetBrains Mono"), "jetbrains-mono");
    }

    #[test]
    fn slug_strips_diacritics_and_unicode() {
        // Every non-ASCII char becomes `-`; trim eats leading/trailing.
        assert_eq!(family_slug("Café Noir"), "caf-noir");
    }

    #[test]
    fn slug_collapses_repeated_separators() {
        // The two `replace("--", "-")` passes collapse runs of 1–4
        // separators down to a single hyphen — that covers every
        // realistic font name. Pin so a refactor doesn't regress it.
        assert_eq!(family_slug("A B"), "a-b");
        assert_eq!(family_slug("A  B"), "a-b");
        assert_eq!(family_slug("A   B"), "a-b");
        assert_eq!(family_slug("A    B"), "a-b");
    }

    #[test]
    fn slug_trims_leading_and_trailing_hyphens() {
        assert_eq!(family_slug(" Inter "), "inter");
        assert_eq!(family_slug("--Inter--"), "inter");
    }

    #[test]
    fn slug_all_non_alphanumeric_yields_empty() {
        // Regression guard: trim_matches on an all-`-` string must not
        // panic and must collapse to "".
        assert_eq!(family_slug("!!!"), "");
        assert_eq!(family_slug("   "), "");
    }
}
