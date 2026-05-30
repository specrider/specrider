use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State, Window};

use crate::commands::resolve_inside;
use crate::state::WindowsState;

// Unlike `write_plan`, lifecycle ops are not tombstoned: the watcher
// events are what refresh listings and active-plan state.

/// Returns the active window's plans root, or an error string when
/// it isn't configured. Every command in this module routes through
/// this so we never touch the filesystem with a bare relative path.
fn plans_root(window: &Window, windows: &State<'_, WindowsState>) -> Result<PathBuf, String> {
    let ws = windows.get_or_create(window.label());
    let root = ws.plans_root.lock().unwrap().clone();
    root.ok_or_else(|| "plans root not configured".to_string())
}

/// Resolves a root-relative destination path that may not yet exist.
/// Leading separators are ignored, parent directories are created as
/// needed, and the canonical parent must stay inside `root`.
fn resolve_inside_new(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/').trim_start_matches('\\');
    if rel.is_empty() {
        return Err("empty path".into());
    }
    if Path::new(rel).is_absolute() {
        return Err("absolute paths not allowed".into());
    }
    let abs = root.join(rel);
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize root: {e}"))?;
    let parent = abs.parent().ok_or("invalid path: no parent")?;
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    let cparent = parent
        .canonicalize()
        .map_err(|e| format!("canonicalize parent: {e}"))?;
    let target = cparent.join(abs.file_name().ok_or("invalid path: no file name")?);
    if !target.starts_with(&canon_root) {
        return Err("path escapes plans root".into());
    }
    Ok(target)
}

/// Reject filenames that would create unintended path semantics or
/// shell-friendly hazards. Blocks separators, leading dots (hidden
/// files), and the empty string.
fn validate_basename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name cannot be empty".into());
    }
    if name.starts_with('.') {
        return Err("name cannot start with '.'".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("name contains an invalid character".into());
    }
    if name == "." || name == ".." {
        return Err("invalid name".into());
    }
    Ok(())
}

#[tauri::command]
pub fn move_plan(
    from_rel: String,
    to_rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), String> {
    let root = plans_root(&window, &windows)?;
    move_plan_in_root(&root, &from_rel, &to_rel)
}

fn move_plan_in_root(root: &Path, from_rel: &str, to_rel: &str) -> Result<(), String> {
    let from_abs = resolve_inside(root, from_rel)?;
    let to_abs = resolve_inside_new(root, to_rel)?;
    if !from_abs.is_file() {
        return Err(format!("{} is not a file", from_rel));
    }
    if to_abs.exists() {
        return Err(format!("{} already exists", to_rel));
    }
    if let Some(parent) = to_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::rename(&from_abs, &to_abs).map_err(|e| format!("rename: {e}"))
}

#[tauri::command]
pub fn rename_plan(
    rel: String,
    new_basename: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<String, String> {
    let root = plans_root(&window, &windows)?;
    rename_plan_in_root(&root, &rel, &new_basename)
}

fn rename_plan_in_root(root: &Path, rel: &str, new_basename: &str) -> Result<String, String> {
    validate_basename(new_basename)?;
    let from_abs = resolve_inside(root, rel)?;
    if !from_abs.is_file() {
        return Err(format!("{} is not a file", rel));
    }
    // Preserve the .md extension if the user didn't include one.
    let final_name = if new_basename.contains('.') {
        new_basename.to_string()
    } else {
        format!("{new_basename}.md")
    };
    let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let to_rel = if parent_rel.is_empty() {
        final_name.clone()
    } else {
        format!("{parent_rel}/{final_name}")
    };
    let to_abs = resolve_inside_new(root, &to_rel)?;
    if to_abs == from_abs {
        return Ok(to_rel);
    }
    if to_abs.exists() {
        return Err(format!("{} already exists", to_rel));
    }
    std::fs::rename(&from_abs, &to_abs).map_err(|e| format!("rename: {e}"))?;
    Ok(to_rel)
}

#[tauri::command]
pub fn delete_plan(
    rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), String> {
    let root = plans_root(&window, &windows)?;
    delete_plan_in_root(&root, &rel)
}

fn delete_plan_in_root(root: &Path, rel: &str) -> Result<(), String> {
    delete_plan_in_root_with(root, rel, |path| {
        trash::delete(path).map_err(|e| format!("trash: {e}"))
    })
}

fn delete_plan_in_root_with<F>(root: &Path, rel: &str, delete: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let abs = resolve_inside(root, rel)?;
    if !abs.is_file() {
        return Err(format!("{} is not a file", rel));
    }
    delete(&abs)
}

#[tauri::command]
pub fn duplicate_plan(
    rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<String, String> {
    let root = plans_root(&window, &windows)?;
    duplicate_plan_in_root(&root, &rel)
}

fn duplicate_plan_in_root(root: &Path, rel: &str) -> Result<String, String> {
    let from_abs = resolve_inside(root, rel)?;
    if !from_abs.is_file() {
        return Err(format!("{} is not a file", rel));
    }
    let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let basename = rel.rsplit('/').next().ok_or("invalid path")?;
    let (stem, ext) = match basename.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (basename.to_string(), String::new()),
    };
    // Try `<stem>-copy<ext>`, `<stem>-copy-2<ext>`, ... until we find
    // a free slot.
    let make_rel = |candidate: &str| {
        if parent_rel.is_empty() {
            candidate.to_string()
        } else {
            format!("{parent_rel}/{candidate}")
        }
    };
    let mut chosen_rel = make_rel(&format!("{stem}-copy{ext}"));
    let mut chosen_abs = resolve_inside_new(root, &chosen_rel)?;
    let mut n = 2;
    while chosen_abs.exists() {
        chosen_rel = make_rel(&format!("{stem}-copy-{n}{ext}"));
        chosen_abs = resolve_inside_new(root, &chosen_rel)?;
        n += 1;
    }
    std::fs::copy(&from_abs, &chosen_abs).map_err(|e| format!("copy: {e}"))?;
    Ok(chosen_rel)
}

// ─── Folder ops ──────────────────────────────────────────────────────

/// Returns true if the directory has any entries (tracked or not).
/// Used by `delete_folder` to decide whether the `force` flag is
/// required.
fn dir_is_empty(path: &Path) -> Result<bool, String> {
    let mut iter = std::fs::read_dir(path).map_err(|e| format!("read_dir: {e}"))?;
    Ok(iter.next().is_none())
}

#[tauri::command]
pub fn create_folder(
    rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), String> {
    let root = plans_root(&window, &windows)?;
    create_folder_in_root(&root, &rel)
}

fn create_folder_in_root(root: &Path, rel: &str) -> Result<(), String> {
    let abs = resolve_inside_new(root, rel)?;
    if abs.exists() {
        return Err(format!("{} already exists", rel));
    }
    std::fs::create_dir_all(&abs).map_err(|e| format!("mkdir: {e}"))
}

#[tauri::command]
pub fn move_folder(
    from_rel: String,
    to_rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), String> {
    let root = plans_root(&window, &windows)?;
    move_folder_in_root(&root, &from_rel, &to_rel)
}

fn move_folder_in_root(root: &Path, from_rel: &str, to_rel: &str) -> Result<(), String> {
    let from_abs = resolve_inside(root, from_rel)?;
    let to_abs = resolve_inside_new(root, to_rel)?;
    if !from_abs.is_dir() {
        return Err(format!("{} is not a folder", from_rel));
    }
    if to_abs.exists() {
        return Err(format!("{} already exists", to_rel));
    }
    // Reject moving a folder under itself — that'd produce nonsense
    // paths and confuse the watcher.
    if to_abs.starts_with(&from_abs) {
        return Err("cannot move a folder under itself".into());
    }
    if let Some(parent) = to_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    // Folder rename fires per-file Remove/Create events under the
    // hood; we don't tombstone every descendant because that scales
    // with folder size. The watcher's existing debounce + the
    // analyze-cache mtime keying handles the burst gracefully.
    std::fs::rename(&from_abs, &to_abs).map_err(|e| format!("rename: {e}"))
}

#[tauri::command]
pub fn rename_folder(
    rel: String,
    new_basename: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<String, String> {
    let root = plans_root(&window, &windows)?;
    rename_folder_in_root(&root, &rel, &new_basename)
}

fn rename_folder_in_root(root: &Path, rel: &str, new_basename: &str) -> Result<String, String> {
    if new_basename.is_empty()
        || new_basename.contains('/')
        || new_basename.contains('\\')
        || new_basename == "."
        || new_basename == ".."
        || new_basename.starts_with('.')
    {
        return Err("invalid folder name".into());
    }
    let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let to_rel = if parent_rel.is_empty() {
        new_basename.to_string()
    } else {
        format!("{parent_rel}/{new_basename}")
    };
    move_folder_in_root(root, rel, &to_rel)?;
    Ok(to_rel)
}

#[tauri::command]
pub fn delete_folder(
    rel: String,
    force: Option<bool>,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), String> {
    let root = plans_root(&window, &windows)?;
    delete_folder_in_root(&root, &rel, force.unwrap_or(false))
}

fn delete_folder_in_root(root: &Path, rel: &str, force: bool) -> Result<(), String> {
    delete_folder_in_root_with(root, rel, force, |path| {
        trash::delete(path).map_err(|e| format!("trash: {e}"))
    })
}

fn delete_folder_in_root_with<F>(
    root: &Path,
    rel: &str,
    force: bool,
    delete: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let abs = resolve_inside(root, rel)?;
    if !abs.is_dir() {
        return Err(format!("{} is not a folder", rel));
    }
    if !force && !dir_is_empty(&abs)? {
        return Err("folder is not empty".into());
    }
    delete(&abs)
}

/// Reveal the plan in the OS file manager (highlighting the file when
/// the platform supports it). On macOS uses `open -R`; on Windows uses
/// `explorer /select,`; on Linux falls back to opening the parent dir
/// since "select" isn't standard.
#[tauri::command]
pub fn reveal_plan(
    rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), String> {
    let root = plans_root(&window, &windows)?;
    let abs = resolve_inside(&root, &rel)?;
    if !abs.exists() {
        return Err(format!("{} does not exist", rel));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&abs)
            .spawn()
            .map_err(|e| format!("open -R: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", abs.display()))
            .spawn()
            .map_err(|e| format!("explorer: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let parent = abs.parent().ok_or("invalid path: no parent")?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
        Ok(())
    }
}

/// One-shot snapshot consumed by the frontend on first paint. Returns
/// the active window's plansRoot (so a freshly-spawned window doesn't
/// have to wait for the auto-derived path) plus an optional active
/// plan to seed `activeId` before `list_plans` resolves. The active
/// plan is consumed (cleared) so a window refresh later picks up the
/// default newest-mtime selection instead of re-jumping.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialState {
    pub plans_root: Option<String>,
    pub active_plan: Option<String>,
}

#[tauri::command]
pub fn get_initial_state(window: Window, windows: State<'_, WindowsState>) -> InitialState {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .map(|p| p.to_string_lossy().into_owned());
    let active_plan = ws.pending_initial_plan.lock().unwrap().take();
    InitialState {
        plans_root,
        active_plan,
    }
}

/// Spawn a fresh window pointed at the *current* window's plansRoot
/// with `plan_rel` pre-selected. Distinct from `File → New Window`
/// (which loads the user's configured default folder).
#[tauri::command]
pub fn open_plan_in_new_window(
    plan_rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
    app: AppHandle,
) -> Result<(), String> {
    let ws = windows.get_or_create(window.label());
    let root = ws.plans_root.lock().unwrap().clone();
    crate::spawn_new_window_for_plan(app, root, Some(plan_rel))
}

#[tauri::command]
pub fn create_plan(
    rel: String,
    initial: Option<String>,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<String, String> {
    let root = plans_root(&window, &windows)?;
    create_plan_in_root(&root, &rel, initial)
}

fn create_plan_in_root(root: &Path, rel: &str, initial: Option<String>) -> Result<String, String> {
    // Auto-append `.md` if the user supplied a bare name without one.
    let final_rel = if rel.ends_with(".md") {
        rel.to_string()
    } else {
        format!("{rel}.md")
    };
    let abs = resolve_inside_new(root, &final_rel)?;
    if abs.exists() {
        return Err(format!("{} already exists", final_rel));
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    // Default seed: an H1 with the basename so the new file is
    // immediately visible in the browser without an empty-state.
    let body = initial.unwrap_or_else(|| {
        let basename = final_rel
            .rsplit('/')
            .next()
            .unwrap_or(&final_rel)
            .trim_end_matches(".md");
        let title = basename
            .split(['-', '_'])
            .filter(|s| !s.is_empty())
            .map(|s| {
                let mut chars = s.chars();
                match chars.next() {
                    Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        format!("# {title}\n")
    });
    std::fs::write(&abs, body).map_err(|e| format!("write: {e}"))?;
    Ok(final_rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // ─── validate_basename ──────────────────────────────────────────

    #[test]
    fn validate_basename_accepts_ordinary_names() {
        assert!(validate_basename("foo.md").is_ok());
        assert!(validate_basename("Foo Bar.md").is_ok());
        assert!(validate_basename("foo_bar-baz.md").is_ok());
    }

    #[test]
    fn validate_basename_rejects_empty() {
        assert!(validate_basename("").is_err());
    }

    #[test]
    fn validate_basename_rejects_dotfiles() {
        assert!(validate_basename(".hidden").is_err());
        assert!(validate_basename(".git").is_err());
        assert!(validate_basename(".").is_err());
        assert!(validate_basename("..").is_err());
    }

    #[test]
    fn validate_basename_rejects_separators() {
        assert!(validate_basename("foo/bar.md").is_err());
        assert!(validate_basename("foo\\bar.md").is_err());
        assert!(validate_basename("../escape.md").is_err());
    }

    #[test]
    fn validate_basename_rejects_null_byte() {
        assert!(validate_basename("foo\0.md").is_err());
    }

    // ─── resolve_inside_new ─────────────────────────────────────────

    #[test]
    fn resolve_inside_new_rejects_empty() {
        let dir = tempdir().unwrap();
        assert!(resolve_inside_new(dir.path(), "").is_err());
    }

    #[test]
    fn resolve_inside_new_absolute_outside_does_not_escape() {
        // Like `resolve_inside`, the new-file variant strips a leading
        // `/` and treats the rest as plans-root-relative. We don't
        // require an error — we require that the resolved path can
        // never escape the canonicalized plans root.
        let inside = tempdir().unwrap();
        let canon_root = inside.path().canonicalize().unwrap();
        let outside = tempdir().unwrap();
        let abs = outside.path().join("x.md").to_string_lossy().into_owned();
        let result = resolve_inside_new(inside.path(), &abs);
        if let Ok(resolved) = result {
            assert!(
                resolved.starts_with(&canon_root),
                "resolved path {} escaped root {}",
                resolved.display(),
                canon_root.display(),
            );
        }
    }

    #[test]
    fn resolve_inside_new_rejects_dotdot_escape() {
        let parent = tempdir().unwrap();
        let plans = parent.path().join("plans");
        fs::create_dir_all(&plans).unwrap();
        let err = resolve_inside_new(&plans, "../sneaky.md").unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("canonicalize"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn resolve_inside_new_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let resolved = resolve_inside_new(dir.path(), "a/b/c/new.md").unwrap();
        assert!(resolved.ends_with("new.md"));
        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[test]
    fn resolve_inside_new_strips_leading_slash() {
        let dir = tempdir().unwrap();
        let resolved = resolve_inside_new(dir.path(), "/foo.md").unwrap();
        assert!(resolved.ends_with("foo.md"));
    }

    #[test]
    #[cfg(unix)]
    fn resolve_inside_new_rejects_symlinked_parent_escape() {
        // Plans root contains a symlink directory that points outside.
        // A new-file resolution into that subdir must still be refused.
        let parent = tempdir().unwrap();
        let plans = parent.path().join("plans");
        fs::create_dir_all(&plans).unwrap();
        let outside_dir = parent.path().join("outside");
        fs::create_dir_all(&outside_dir).unwrap();
        let link = plans.join("escape");
        std::os::unix::fs::symlink(&outside_dir, &link).unwrap();
        let err = resolve_inside_new(&plans, "escape/new.md").unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("canonicalize"),
            "unexpected error: {err}"
        );
    }

    // ─── dir_is_empty ────────────────────────────────────────────────

    #[test]
    fn dir_is_empty_true_for_empty() {
        let dir = tempdir().unwrap();
        assert!(dir_is_empty(dir.path()).unwrap());
    }

    #[test]
    fn dir_is_empty_false_when_populated() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), b"").unwrap();
        assert!(!dir_is_empty(dir.path()).unwrap());
    }

    #[test]
    fn dir_is_empty_false_with_nested_dir() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("nested")).unwrap();
        assert!(!dir_is_empty(dir.path()).unwrap());
    }

    // ─── lifecycle helpers ──────────────────────────────────────────

    #[test]
    fn plan_lifecycle_helpers_create_move_rename_duplicate_and_delete() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        let created = create_plan_in_root(root, "drafts/alpha", None).unwrap();
        assert_eq!(created, "drafts/alpha.md");
        assert_eq!(
            fs::read_to_string(root.join("drafts/alpha.md")).unwrap(),
            "# Alpha\n"
        );

        move_plan_in_root(root, "drafts/alpha.md", "active/alpha.md").unwrap();
        assert!(!root.join("drafts/alpha.md").exists());
        assert!(root.join("active/alpha.md").is_file());

        let renamed = rename_plan_in_root(root, "active/alpha.md", "beta").unwrap();
        assert_eq!(renamed, "active/beta.md");
        assert!(root.join("active/beta.md").is_file());

        let duplicate = duplicate_plan_in_root(root, "active/beta.md").unwrap();
        assert_eq!(duplicate, "active/beta-copy.md");
        assert_eq!(
            fs::read_to_string(root.join("active/beta-copy.md")).unwrap(),
            "# Alpha\n"
        );

        delete_plan_in_root_with(root, "active/beta-copy.md", |path| {
            fs::remove_file(path).map_err(|e| format!("remove_file: {e}"))
        })
        .unwrap();
        assert!(!root.join("active/beta-copy.md").exists());
    }

    #[test]
    fn folder_lifecycle_helpers_create_move_rename_guard_and_delete() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        create_folder_in_root(root, "archive/2026").unwrap();
        assert!(root.join("archive/2026").is_dir());

        let err = move_folder_in_root(root, "archive", "archive/2026/archive").unwrap_err();
        assert!(err.contains("under itself"));

        move_folder_in_root(root, "archive", "active/archive").unwrap();
        assert!(!root.join("archive").exists());
        assert!(root.join("active/archive/2026").is_dir());

        let renamed = rename_folder_in_root(root, "active/archive", "done").unwrap();
        assert_eq!(renamed, "active/done");
        assert!(root.join("active/done/2026").is_dir());

        fs::write(root.join("active/done/2026/alpha.md"), "# Alpha\n").unwrap();
        let err = delete_folder_in_root_with(root, "active/done", false, |path| {
            fs::remove_dir_all(path).map_err(|e| format!("remove_dir_all: {e}"))
        })
        .unwrap_err();
        assert!(err.contains("not empty"));
        delete_folder_in_root_with(root, "active/done", true, |path| {
            fs::remove_dir_all(path).map_err(|e| format!("remove_dir_all: {e}"))
        })
        .unwrap();
        assert!(!root.join("active/done").exists());
    }
}
