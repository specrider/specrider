use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::state::WindowsState;

/// Image extensions the protocol will serve. Anything else is rejected
/// even if the path is otherwise legal — keeps the surface narrow and
/// stops authors from accidentally sourcing arbitrary files.
const ALLOWED_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Resolves a plan-relative or root-relative image reference against
/// the canonicalized plans root. Refuses to escape the root via `..`
/// or symlink traversal. Returns `None` on any failure (missing file,
/// extension not in the allowlist, traversal escape).
pub fn resolve_image(plans_root: &Path, requested: &str) -> Option<(PathBuf, &'static str)> {
    let canon_root = plans_root.canonicalize().ok()?;
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        canon_root.join(requested)
    };
    let canon_path = candidate.canonicalize().ok()?;
    if !canon_path.starts_with(&canon_root) {
        return None;
    }
    let ext = canon_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())?;
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    if !ALLOWED_EXTS.iter().any(|e| *e == ext) {
        return None;
    }
    Some((canon_path, mime))
}

/// Reads bytes for a `specrider-img://<webview>/<path>` request. The
/// requesting webview's plans root is the only place reads are allowed
/// from — every other window's root is off-limits.
pub fn read_image_for_webview(
    app: &AppHandle,
    webview_label: &str,
    requested: &str,
) -> Option<(Vec<u8>, &'static str)> {
    let windows: tauri::State<'_, WindowsState> = app.state();
    let ws = windows.get_or_create(webview_label);
    let root = ws.plans_root.lock().ok()?.clone()?;
    let (path, mime) = resolve_image(&root, requested)?;
    let bytes = std::fs::read(path).ok()?;
    Some((bytes, mime))
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

    #[test]
    fn resolves_simple_relative_path() {
        let dir = tempdir().unwrap();
        write(dir.path(), "img/a.png", b"\x89PNG");
        let (path, mime) = resolve_image(dir.path(), "img/a.png").unwrap();
        assert!(path.ends_with("img/a.png"));
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn assigns_mime_from_extension() {
        let dir = tempdir().unwrap();
        write(dir.path(), "a.png", b"");
        write(dir.path(), "b.jpg", b"");
        write(dir.path(), "c.jpeg", b"");
        write(dir.path(), "d.gif", b"");
        write(dir.path(), "e.webp", b"");
        write(dir.path(), "f.svg", b"<svg/>");
        assert_eq!(resolve_image(dir.path(), "a.png").unwrap().1, "image/png");
        assert_eq!(resolve_image(dir.path(), "b.jpg").unwrap().1, "image/jpeg");
        assert_eq!(resolve_image(dir.path(), "c.jpeg").unwrap().1, "image/jpeg");
        assert_eq!(resolve_image(dir.path(), "d.gif").unwrap().1, "image/gif");
        assert_eq!(resolve_image(dir.path(), "e.webp").unwrap().1, "image/webp");
        assert_eq!(
            resolve_image(dir.path(), "f.svg").unwrap().1,
            "image/svg+xml"
        );
    }

    #[test]
    fn extension_match_is_case_insensitive() {
        let dir = tempdir().unwrap();
        write(dir.path(), "A.PNG", b"");
        let (_, mime) = resolve_image(dir.path(), "A.PNG").unwrap();
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn refuses_extension_not_in_allowlist() {
        let dir = tempdir().unwrap();
        write(dir.path(), "secrets.txt", b"hi");
        assert!(resolve_image(dir.path(), "secrets.txt").is_none());

        write(dir.path(), "config.json", b"{}");
        assert!(resolve_image(dir.path(), "config.json").is_none());

        write(dir.path(), "evil.html", b"<script>");
        assert!(resolve_image(dir.path(), "evil.html").is_none());
    }

    #[test]
    fn refuses_files_with_no_extension() {
        let dir = tempdir().unwrap();
        write(dir.path(), "noext", b"");
        assert!(resolve_image(dir.path(), "noext").is_none());
    }

    #[test]
    fn refuses_missing_files() {
        let dir = tempdir().unwrap();
        assert!(resolve_image(dir.path(), "missing.png").is_none());
    }

    #[test]
    fn refuses_dotdot_traversal() {
        // Build a layout where the plans root is a child dir, and a
        // sibling holds a file the request tries to escape into.
        let parent = tempdir().unwrap();
        let plans = parent.path().join("plans");
        fs::create_dir_all(&plans).unwrap();
        write(parent.path(), "outside.png", b"\x89PNG");
        // Sanity: the file exists and is readable directly.
        assert!(parent.path().join("outside.png").exists());
        // …but the protocol must refuse the escape.
        assert!(resolve_image(&plans, "../outside.png").is_none());
    }

    #[test]
    fn refuses_absolute_path_outside_root() {
        let inside = tempdir().unwrap();
        let outside = tempdir().unwrap();
        write(outside.path(), "x.png", b"\x89PNG");
        let abs = outside.path().join("x.png").to_string_lossy().into_owned();
        assert!(resolve_image(inside.path(), &abs).is_none());
    }

    #[test]
    fn allows_absolute_path_inside_root() {
        let dir = tempdir().unwrap();
        write(dir.path(), "img/x.png", b"\x89PNG");
        // Use canonicalize so the comparison survives `/private/var`-style
        // prefixes the OS may apply on macOS.
        let abs_inside = dir
            .path()
            .canonicalize()
            .unwrap()
            .join("img/x.png")
            .to_string_lossy()
            .into_owned();
        let resolved = resolve_image(dir.path(), &abs_inside);
        assert!(resolved.is_some());
    }

    #[test]
    fn refuses_symlink_escape() {
        // A symlink inside plans-root pointing at a file outside —
        // canonicalize must follow it and reject. Skipped on platforms
        // where symlinks need extra privileges (Windows CI etc.).
        #[cfg(unix)]
        {
            let parent = tempdir().unwrap();
            let plans = parent.path().join("plans");
            fs::create_dir_all(&plans).unwrap();
            let outside_target = parent.path().join("secret.png");
            fs::write(&outside_target, b"\x89PNG").unwrap();
            let link_path = plans.join("smuggled.png");
            std::os::unix::fs::symlink(&outside_target, &link_path).unwrap();
            assert!(resolve_image(&plans, "smuggled.png").is_none());
        }
    }

    #[test]
    fn handles_path_with_spaces() {
        let dir = tempdir().unwrap();
        write(dir.path(), "my pictures/cat.png", b"\x89PNG");
        let resolved = resolve_image(dir.path(), "my pictures/cat.png");
        assert!(resolved.is_some());
    }
}
