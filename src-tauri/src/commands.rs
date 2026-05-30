use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

use crate::app_icon;
use crate::config::{AppSettings, ConfigState, DefaultTrustPolicy};
use crate::state::WindowsState;

/// Hard ceiling on `WalkDir` recursion. Plans repos rarely nest more
/// than a handful of levels; this protects against pathological deep
/// trees (e.g. a malicious clone with a 10k-deep symlink-loop-cousin
/// directory) wedging a worker without falling back to "first error".
const MAX_PLAN_TREE_DEPTH: usize = 32;

#[derive(Clone)]
pub struct CachedAnalysis {
    pub line_count: u32,
    pub word_count: u32,
    pub task_done: u32,
    pub task_total: u32,
    pub frontmatter: Option<serde_json::Value>,
    /// First top-level `# ` heading in the body (after frontmatter,
    /// outside fenced code), with the leading `#` and trailing
    /// whitespace stripped. None if the doc has no H1.
    pub h1: Option<String>,
}

/// Per-path analysis cache keyed by file mtime. Skips re-parsing files
/// whose mtime hasn't moved since last `list_plans`. Non-essential at
/// the project's current scale (~50 plans), but pays off as the corpus
/// grows.
#[derive(Default)]
pub struct AnalyzeCache {
    inner: Mutex<HashMap<PathBuf, (u64, CachedAnalysis)>>,
}

impl AnalyzeCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, path: &Path, mtime: u64) -> Option<CachedAnalysis> {
        let inner = self.inner.lock().unwrap();
        inner
            .get(path)
            .and_then(|(t, a)| if *t == mtime { Some(a.clone()) } else { None })
    }

    fn put(&self, path: PathBuf, mtime: u64, analysis: CachedAnalysis) {
        let mut inner = self.inner.lock().unwrap();
        inner.insert(path, (mtime, analysis));
    }
}

/// Shared root-change logic used by both the `set_plans_root` command and
/// the native menu's "Open Plans Folder…" handler. Persists to config,
/// re-aims the per-window watcher, and emits `plans-root-changed`
/// scoped to the calling window so other windows aren't affected.
pub fn apply_plans_root(app: &AppHandle, window_label: &str, path: PathBuf) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    let cfg_state: State<'_, ConfigState> = app.state();
    let windows_state: State<'_, WindowsState> = app.state();
    let ws = windows_state.get_or_create(window_label);

    *ws.plans_root.lock().unwrap() = Some(path.clone());
    {
        let mut cfg = cfg_state.0.lock().unwrap();
        cfg.set_root_for(window_label, Some(path.clone()));
        cfg.remember_recent_project_root(path.clone());
        cfg.save(app)?;
    }
    ws.watcher
        .watch_for(app, window_label.to_string(), path.clone())
        .map_err(|e| format!("watch failed: {e}"))?;

    let path_str = path.to_string_lossy().into_owned();
    let _ = app.emit_to(
        EventTarget::webview_window(window_label),
        "plans-root-changed",
        path_str,
    );
    crate::rebuild_menu(app);
    Ok(())
}

/// Variant of `apply_plans_root` that also primes the per-window
/// `pending_initial_plan` so the frontend's next `getInitialState`
/// pickup lands on a specific file. Used by the "Open File…" menu
/// handler — picking a single `.md` file sets the parent dir as the
/// plans-root and queues the filename as the auto-selected plan.
pub fn apply_plans_root_with_initial_plan(
    app: &AppHandle,
    window_label: &str,
    path: PathBuf,
    initial_plan: String,
) -> Result<(), String> {
    {
        let windows_state: State<'_, WindowsState> = app.state();
        let ws = windows_state.get_or_create(window_label);
        *ws.pending_initial_plan.lock().unwrap() = Some(initial_plan);
    }
    apply_plans_root(app, window_label, path)
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanFileMeta {
    /// Forward-slash relative path from `plansRoot`, e.g. `active/foo.md`.
    pub path: String,
    pub modified_secs: u64,
    pub size: u64,
    pub line_count: u32,
    pub word_count: u32,
    pub task_done: u32,
    pub task_total: u32,
    /// Raw frontmatter as a JSON object, or `null` if absent / malformed.
    pub frontmatter: Option<serde_json::Value>,
    /// First H1 heading in the body, with `#` and trimming applied.
    pub h1: Option<String>,
}

const IGNORED_PLAN_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "dist-ssr",
    "build",
    "target",
    "_build",
    "deps",
    "coverage",
    "playwright-report",
    "test-results",
];

fn should_walk_plan_entry(entry: &walkdir::DirEntry) -> bool {
    let Some(name) = entry.file_name().to_str() else {
        return false;
    };
    if entry.depth() == 0 {
        return true;
    }
    if name.starts_with('.') {
        return false;
    }
    if entry.file_type().is_dir() && IGNORED_PLAN_DIRS.contains(&name) {
        return false;
    }
    true
}

fn empty_analysis() -> CachedAnalysis {
    CachedAnalysis {
        line_count: 0,
        word_count: 0,
        task_done: 0,
        task_total: 0,
        frontmatter: None,
        h1: None,
    }
}

/// Returns Err with a user-visible message when a write of `new` over
/// `existing` looks like a stale-buffer / plan-switch race rather than
/// a legitimate edit; otherwise Ok.
///
/// The check is intentionally narrow: refuse when `existing` has > 64
/// bytes of non-whitespace content and `new` has ≤ 32 bytes. This
/// catches the "completely erased" case where any frontend bug — race,
/// accidental clear, blank buffer — would wipe out a real document,
/// without blocking legitimate rewrites, header changes, or first
/// writes to an empty file.
pub(crate) fn validate_write_safety(
    existing: &str,
    new: &str,
    rel_path: &str,
) -> Result<(), String> {
    let existing_trim = existing.trim();
    let new_trim = new.trim();
    if existing_trim.len() > 64 && new_trim.len() <= 32 {
        return Err(format!(
            "refusing to write {}: would replace {} bytes of existing content with only {} bytes. Likely a stale or empty buffer; reload and retry.",
            rel_path,
            existing_trim.len(),
            new_trim.len(),
        ));
    }
    Ok(())
}

/// Returns `Some(true)` for a checked task (`- [x]`, `* [x]`, `+ [x]`),
/// `Some(false)` for an unchecked one, `None` for any other line.
/// CommonMark allows `-`, `*`, or `+` as the bullet marker, so the
/// docs-pane progress tally has to match the frontend's CommonMark
/// parser to avoid 0/0 totals on docs that use `*` (e.g. Scratchpad).
fn task_kind(line: &str) -> Option<bool> {
    let s = line.trim_start();
    let bytes = s.as_bytes();
    // `<marker> [_]` minimum: 5 bytes (e.g. "- [ ]").
    if bytes.len() < 5 {
        return None;
    }
    if !matches!(bytes[0], b'-' | b'*' | b'+') {
        return None;
    }
    if bytes[1] != b' ' || bytes[2] != b'[' || bytes[4] != b']' {
        return None;
    }
    match bytes[3] {
        b' ' => Some(false),
        b'x' | b'X' => Some(true),
        _ => None,
    }
}

/// Reads the file once and pulls out: line count, word count (skipping
/// fenced code blocks), task tallies, and the YAML frontmatter parsed
/// into a JSON-shaped value the frontend can consume directly.
fn analyze_file_inner(abs: &Path) -> CachedAnalysis {
    let content = match std::fs::read_to_string(abs) {
        Ok(s) => s,
        Err(_) => return empty_analysis(),
    };

    // Frontmatter: leading `---` line, then YAML, then closing `---`.
    let mut body_start_line = 0usize;
    let mut frontmatter_yaml = String::new();
    let mut iter = content.lines().enumerate();
    if let Some((_, first)) = iter.next() {
        if first.trim() == "---" {
            for (idx, line) in iter.by_ref() {
                if line.trim() == "---" {
                    body_start_line = idx + 1;
                    break;
                }
                frontmatter_yaml.push_str(line);
                frontmatter_yaml.push('\n');
            }
        }
    }

    let mut frontmatter: Option<serde_json::Value> = None;
    if !frontmatter_yaml.is_empty() {
        // serde_yml is the maintained drop-in fork of serde_yaml — the
        // upstream crate is archived and won't get future fixes.
        match serde_yml::from_str::<serde_json::Value>(&frontmatter_yaml) {
            Ok(v) if v.is_object() => frontmatter = Some(v),
            Ok(_) => {} // top-level not a map → ignore
            Err(e) => {
                eprintln!("frontmatter parse failed for {}: {e}", abs.display());
            }
        }
    }

    let mut in_code = false;
    let mut line_count: u32 = 0;
    let mut word_count: u32 = 0;
    let mut task_done: u32 = 0;
    let mut task_total: u32 = 0;
    let mut h1: Option<String> = None;

    for (idx, line) in content.lines().enumerate() {
        line_count += 1;
        if idx < body_start_line {
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if h1.is_none() {
            if let Some(rest) = trimmed.strip_prefix('#') {
                if rest.chars().next().is_some_and(char::is_whitespace) {
                    let text = rest.trim();
                    if !text.is_empty() {
                        h1 = Some(text.to_string());
                    }
                }
            }
        }
        match task_kind(line) {
            Some(true) => {
                task_total += 1;
                task_done += 1;
            }
            Some(false) => {
                task_total += 1;
            }
            None => {}
        }
        word_count += line.split_whitespace().count() as u32;
    }

    CachedAnalysis {
        line_count,
        word_count,
        task_done,
        task_total,
        frontmatter,
        h1,
    }
}

/// Returns the cached analysis if the file's mtime hasn't moved,
/// otherwise re-reads + parses + writes through.
fn analyze_file(abs: &Path, mtime_secs: u64, cache: &AnalyzeCache) -> CachedAnalysis {
    if let Some(cached) = cache.get(abs, mtime_secs) {
        return cached;
    }
    let analysis = analyze_file_inner(abs);
    cache.put(abs.to_path_buf(), mtime_secs, analysis.clone());
    analysis
}

fn list_plan_files(
    root: &Path,
    cache: &AnalyzeCache,
    analyze: bool,
) -> Result<Vec<PlanFileMeta>, String> {
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_PLAN_TREE_DEPTH)
        .into_iter()
        .filter_entry(should_walk_plan_entry)
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let rel = p
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_path_buf();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let analysis = if analyze {
            analyze_file(p, modified_secs, cache)
        } else {
            empty_analysis()
        };
        out.push(PlanFileMeta {
            path: rel.to_string_lossy().replace('\\', "/"),
            modified_secs,
            size: meta.len(),
            line_count: analysis.line_count,
            word_count: analysis.word_count,
            task_done: analysis.task_done,
            task_total: analysis.task_total,
            frontmatter: analysis.frontmatter,
            h1: analysis.h1,
        });
    }
    out.sort_by_key(|file| std::cmp::Reverse(file.modified_secs));
    Ok(out)
}

#[tauri::command]
pub fn get_plans_root(window: Window, windows: State<'_, WindowsState>) -> Option<String> {
    let ws = windows.get_or_create(window.label());
    let root = ws.plans_root.lock().unwrap();
    root.as_ref().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn set_plans_root(path: String, window: Window, app: AppHandle) -> Result<(), String> {
    apply_plans_root(&app, window.label(), PathBuf::from(path))
}

#[tauri::command]
pub fn set_window_title(title: String, window: Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::set_window_title_and_reapply(window, title)
    }

    #[cfg(not(target_os = "macos"))]
    {
        window.set_title(&title).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArgs {
    /// Default file name shown in the save dialog (basename only —
    /// the OS picker decides the directory).
    pub default_name: String,
    pub filters: Vec<ExportFilter>,
    pub contents: String,
}

/// Export the rendered plan to a user-chosen file. The native save
/// dialog runs *inside* Rust so the destination path never round-
/// trips through the frontend — there's no window where a renderer
/// bug or misuse from JS could substitute a different write target
/// (`~/.zshrc`, `~/.ssh/authorized_keys`, …) between picker and
/// write. Returns the chosen path on success or `None` if the user
/// cancelled the dialog.
#[tauri::command]
pub fn export_with_dialog(args: ExportArgs, app: AppHandle) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file();
    if !args.default_name.is_empty() {
        builder = builder.set_file_name(&args.default_name);
    }
    for filter in &args.filters {
        let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &exts);
    }
    let chosen = builder.blocking_save_file();
    let Some(file_path) = chosen else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("dialog returned an unusable path: {e}"))?;
    if !path.is_absolute() {
        return Err(format!("export path must be absolute: {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            return Err(format!(
                "export parent directory does not exist: {}",
                parent.display()
            ));
        }
    }
    std::fs::write(&path, &args.contents).map_err(|e| format!("write failed: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Most-recently-opened plans roots, filtered to ones that still
/// exist on disk. Returned newest-first with `name` derived from the
/// project dir (skipping `docs`/`plans` wrapper segments to mirror
/// the native menu's labelling).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub display_path: String,
}

#[tauri::command]
pub fn list_recent_projects(state: State<'_, ConfigState>) -> Vec<RecentProject> {
    let cfg = state.0.lock().unwrap();
    cfg.recent_project_roots
        .iter()
        .filter(|p| p.is_dir())
        .map(|p| RecentProject {
            path: p.to_string_lossy().into_owned(),
            name: crate::project_name_from_path(p).unwrap_or_else(|| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Project")
                    .to_string()
            }),
            display_path: crate::display_path(p),
        })
        .collect()
}

/// Open a single Markdown file: sets the plans-root to the file's
/// parent directory and queues the filename as the auto-selected plan.
/// Frontend-callable counterpart to the "Open File…" native menu item,
/// used by the empty-state CTA.
#[tauri::command]
pub fn open_single_file(path: String, window: Window, app: AppHandle) -> Result<(), String> {
    let abs = PathBuf::from(&path);
    let parent = abs
        .parent()
        .ok_or_else(|| format!("file has no parent: {path}"))?
        .to_path_buf();
    let filename = abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("invalid file name: {path}"))?
        .to_string();
    apply_plans_root_with_initial_plan(&app, window.label(), parent, filename)
}

#[tauri::command]
pub fn list_plans(
    window: Window,
    windows: State<'_, WindowsState>,
    cache: State<'_, AnalyzeCache>,
) -> Result<Vec<PlanFileMeta>, String> {
    let ws = windows.get_or_create(window.label());
    let root = match ws.plans_root.lock().unwrap().clone() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    list_plan_files(&root, &cache, false)
}

#[tauri::command]
pub fn analyze_plans(
    window: Window,
    windows: State<'_, WindowsState>,
    cache: State<'_, AnalyzeCache>,
) -> Result<Vec<PlanFileMeta>, String> {
    let ws = windows.get_or_create(window.label());
    let root = match ws.plans_root.lock().unwrap().clone() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    list_plan_files(&root, &cache, true)
}

#[tauri::command]
pub fn read_plan(
    rel_path: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<String, String> {
    let ws = windows.get_or_create(window.label());
    let root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "plans root not configured".to_string())?;
    let abs = resolve_inside(&root, &rel_path)?;
    std::fs::read_to_string(&abs).map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
pub fn write_plan(
    rel_path: String,
    contents: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), String> {
    let ws = windows.get_or_create(window.label());
    let root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "plans root not configured".to_string())?;
    let abs = resolve_inside(&root, &rel_path)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }

    // Defense-in-depth: refuse writes that look like a stale-buffer /
    // plan-switch race rather than a legitimate edit. See
    // `validate_write_safety` for the specific checks.
    if let Ok(existing) = std::fs::read_to_string(&abs) {
        validate_write_safety(&existing, &contents, &rel_path)?;
    }

    // Suppress this window's watcher from refetching our own writes.
    ws.watcher.tombstone(abs.clone());

    // Write atomically via temp + rename, falling back to direct write on
    // cross-FS rename failures (e.g. plans root on a network share).
    let tmp = abs.with_extension("md.tmp");
    if let Err(e) = std::fs::write(&tmp, &contents) {
        let _ = std::fs::write(&abs, &contents);
        return Err(format!("tmp write: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &abs) {
        let _ = std::fs::write(&abs, &contents);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename: {e}"));
    }
    Ok(())
}

/// Joins `rel` onto `root` and verifies the canonical result stays inside
/// the canonical root. Leading separators are treated as root-relative;
/// `..` and symlink escapes are refused by the canonical prefix check.
pub(crate) fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
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
    let canon_target = if abs.exists() {
        abs.canonicalize()
            .map_err(|e| format!("canonicalize target: {e}"))?
    } else {
        // For new-file writes, canonicalize the parent (creating it if needed).
        let parent = abs.parent().ok_or("invalid path: no parent")?;
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
        }
        let cparent = parent
            .canonicalize()
            .map_err(|e| format!("canonicalize parent: {e}"))?;
        cparent.join(abs.file_name().ok_or("invalid path: no file name")?)
    };
    if !canon_target.starts_with(&canon_root) {
        return Err("path escapes plans root".into());
    }
    Ok(canon_target)
}

#[cfg(test)]
mod resolve_inside_tests {
    use super::resolve_inside;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rejects_empty_string() {
        let dir = tempdir().unwrap();
        assert!(resolve_inside(dir.path(), "").is_err());
    }

    #[test]
    fn absolute_outside_path_does_not_escape() {
        // `resolve_inside` strips leading `/` (documented: leading
        // slashes are treated as plans-root-relative), then validates
        // canonically. A would-be system-absolute escape attempt is
        // coerced into a plans-root-relative path; if the resulting
        // canonical path still escapes the canonicalized plans root,
        // we refuse.
        let dir = tempdir().unwrap();
        let canon_root = dir.path().canonicalize().unwrap();
        let outside = tempdir().unwrap();
        let escape = outside
            .path()
            .join("secret.md")
            .to_string_lossy()
            .into_owned();
        let result = resolve_inside(dir.path(), &escape);
        // Either the call errored (preferred), or the resolved path
        // stayed inside the plans root. We assert no escape, not a
        // specific error — the contract is "no path leaves the root."
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
    fn strips_leading_slashes_then_resolves() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("foo.md"), b"# hi").unwrap();
        // Leading `/` and `\\` are stripped, not honored as
        // OS-absolute. The remaining path is treated as plans-root
        // relative.
        let resolved = resolve_inside(dir.path(), "/foo.md").unwrap();
        assert!(resolved.ends_with("foo.md"));
    }

    #[test]
    fn rejects_dotdot_traversal_for_existing_file() {
        let parent = tempdir().unwrap();
        let plans = parent.path().join("plans");
        fs::create_dir_all(&plans).unwrap();
        fs::write(parent.path().join("outside.md"), b"# hi").unwrap();
        let err = resolve_inside(&plans, "../outside.md").unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("canonicalize"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn rejects_dotdot_traversal_for_new_file() {
        // For a path that doesn't exist yet, `resolve_inside` falls
        // back to canonicalizing the parent. The escape guard must
        // still trip.
        let parent = tempdir().unwrap();
        let plans = parent.path().join("plans");
        fs::create_dir_all(&plans).unwrap();
        let err = resolve_inside(&plans, "../new.md").unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("canonicalize"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn allows_nested_existing_path() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a/b")).unwrap();
        fs::write(dir.path().join("a/b/c.md"), b"").unwrap();
        let resolved = resolve_inside(dir.path(), "a/b/c.md").unwrap();
        assert!(resolved.ends_with("c.md"));
    }

    #[test]
    fn allows_nested_new_path_creating_parents() {
        let dir = tempdir().unwrap();
        let resolved = resolve_inside(dir.path(), "a/b/new.md").unwrap();
        assert!(resolved.ends_with("new.md"));
        assert!(dir.path().join("a/b").is_dir());
    }

    #[test]
    #[cfg(unix)]
    fn rejects_symlink_escape() {
        let parent = tempdir().unwrap();
        let plans = parent.path().join("plans");
        fs::create_dir_all(&plans).unwrap();
        let outside = parent.path().join("secret.md");
        fs::write(&outside, b"hi").unwrap();
        let link = plans.join("smuggled.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(resolve_inside(&plans, "smuggled.md").is_err());
    }
}

#[cfg(test)]
mod write_safety_tests {
    use super::validate_write_safety;

    // Guard against stale-buffer overwrites that would replace substantial
    // content with an empty or tiny payload.
    #[test]
    fn rejects_empty_over_substantial() {
        let existing = "# Plan B\n\n- [ ] Important task one\n- [ ] Important task two\n- [ ] Important task three\n";
        let new = "";
        assert!(validate_write_safety(existing, new, "active/plan-b.md").is_err());
    }

    #[test]
    fn rejects_whitespace_over_substantial() {
        let existing = "# Plan B\n\n- [ ] Important task one\n- [ ] Important task two\n- [ ] Important task three\n";
        let new = "   \n\n  \t\n";
        assert!(validate_write_safety(existing, new, "active/plan-b.md").is_err());
    }

    #[test]
    fn rejects_tiny_over_substantial() {
        let existing = "# Plan B\n\n- [ ] Important task one\n- [ ] Important task two\n- [ ] Important task three\n";
        let new = "# x"; // 3 bytes after trim
        assert!(validate_write_safety(existing, new, "active/plan-b.md").is_err());
    }

    // Renaming the H1 used to be rejected by a strict-equality guard
    // here; that blocked legitimate renames. Plan-switch races are
    // already caught upstream in `decideSaveSnapshot` (owner mismatch),
    // so this layer only enforces the byte-threshold backstop.
    #[test]
    fn allows_h1_rename() {
        let existing =
            "# Plan B\n\nB body that crosses the substantial threshold so it isn't trivial.\n";
        let new =
            "# Plan B2\n\nB body that crosses the substantial threshold so it isn't trivial.\n";
        assert!(validate_write_safety(existing, new, "active/plan-b.md").is_ok());
    }

    // Legitimate paths must not trip the guard.
    #[test]
    fn allows_first_write_to_empty_file() {
        let existing = "";
        let new = "# Brand new doc\n\nFresh content goes here.\n";
        assert!(validate_write_safety(existing, new, "active/new.md").is_ok());
    }

    #[test]
    fn allows_first_write_to_seeded_file() {
        // create_plan seeds new files with `# Title\n` (~10 bytes).
        let existing = "# Title\n";
        let new = "# Title\n\nFirst paragraph the user types.\n";
        assert!(validate_write_safety(existing, new, "active/new.md").is_ok());
    }

    #[test]
    fn allows_in_place_edit_keeping_h1() {
        let existing = "# Plan B\n\n- [ ] Important task one\n- [ ] Important task two\n- [ ] Important task three\n";
        let new = "# Plan B\n\n- [x] Important task one\n- [ ] Important task two\n- [ ] Important task three\n";
        assert!(validate_write_safety(existing, new, "active/plan-b.md").is_ok());
    }

    #[test]
    fn allows_substantial_rewrite_with_same_h1() {
        let existing = "# Plan B\n\n- [ ] Important task one\n- [ ] Important task two\n- [ ] Important task three\n";
        let new = "# Plan B\n\nCompletely rewritten body, but the H1 still identifies this as Plan B and the new content is substantial.\n";
        assert!(validate_write_safety(existing, new, "active/plan-b.md").is_ok());
    }

    #[test]
    fn allows_headerless_to_headerless_edit() {
        // Headerless docs are allowed as long as the new content is not
        // a tiny replacement for a substantial existing file.
        let existing = "Just some plain prose that goes on for more than sixty-four bytes total to clear the threshold.\n";
        let new = "Different prose that also clears sixty-four bytes so the trivial guard doesn't fire on this case.\n";
        assert!(validate_write_safety(existing, new, "active/notes.md").is_ok());
    }

    #[test]
    fn allows_short_edit_when_existing_is_short() {
        let existing = "# Tiny\n\nshort";
        let new = "# Tiny\n\nstill short";
        assert!(validate_write_safety(existing, new, "active/tiny.md").is_ok());
    }
}

#[cfg(test)]
mod h1_tests {
    use super::analyze_file_inner;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn extracts_commonmark_h1() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("plan.md");
        fs::write(&path, "intro\n# Title\n## Details\n").unwrap();
        let analysis = analyze_file_inner(&path);
        assert_eq!(analysis.h1.as_deref(), Some("Title"));
    }

    #[test]
    fn ignores_hash_without_heading_space() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("plan.md");
        fs::write(&path, "#not a heading\n# Real Title\n").unwrap();
        let analysis = analyze_file_inner(&path);
        assert_eq!(analysis.h1.as_deref(), Some("Real Title"));
    }
}

#[cfg(test)]
mod walk_depth_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Build a chain of `depth` nested directories under `root`,
    /// dropping a `.md` file at each level. Returns the leaf path.
    fn build_chain(root: &Path, depth: usize) -> PathBuf {
        let mut cur = root.to_path_buf();
        for i in 0..depth {
            cur = cur.join(format!("level{i}"));
            fs::create_dir(&cur).unwrap();
            fs::write(cur.join("plan.md"), b"# x\n").unwrap();
        }
        cur
    }

    #[test]
    fn list_plan_files_caps_at_max_depth() {
        let root = tempdir().unwrap();
        let beyond = MAX_PLAN_TREE_DEPTH + 5;
        let _ = build_chain(root.path(), beyond);
        let cache = AnalyzeCache::new();
        let files = list_plan_files(root.path(), &cache, false).unwrap();
        // Some plans should be visible; at least one should be cut.
        assert!(!files.is_empty(), "no plans returned at all");
        assert!(
            files.len() < beyond,
            "depth cap let all {beyond} plans through"
        );
        // No surfaced plan path should be deeper than the cap allows.
        for f in &files {
            let segments = f.path.split('/').count();
            assert!(
                segments <= MAX_PLAN_TREE_DEPTH,
                "found plan past depth cap: {} ({segments} segments)",
                f.path
            );
        }
    }
}

#[cfg(test)]
mod frontmatter_tests {
    use super::analyze_file_inner;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn parses_simple_frontmatter_after_serde_yml_swap() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("plan.md");
        fs::write(
            &path,
            "---\ntitle: Hello\nbranches:\n  - main\n  - feat/foo\n---\n# Hello\n",
        )
        .unwrap();
        let analysis = analyze_file_inner(&path);
        let fm = analysis.frontmatter.expect("frontmatter parsed");
        assert_eq!(fm["title"], "Hello");
        assert_eq!(fm["branches"][0], "main");
        assert_eq!(fm["branches"][1], "feat/foo");
    }

    #[test]
    fn ignores_top_level_non_object_frontmatter() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("plan.md");
        // YAML where top level is a sequence — we ignore (matches
        // pre-migration behavior).
        fs::write(&path, "---\n- one\n- two\n---\nbody\n").unwrap();
        let analysis = analyze_file_inner(&path);
        assert!(analysis.frontmatter.is_none());
    }

    #[test]
    fn tolerates_malformed_yaml_without_panicking() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("plan.md");
        fs::write(&path, "---\n: : not yaml\n---\nbody\n").unwrap();
        let analysis = analyze_file_inner(&path);
        assert!(analysis.frontmatter.is_none());
    }
}

// ─── Settings ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(state: State<'_, ConfigState>) -> AppSettings {
    state.0.lock().unwrap().settings.clone()
}

#[tauri::command]
pub fn set_setting(
    key: String,
    value: serde_json::Value,
    app: AppHandle,
    state: State<'_, ConfigState>,
) -> Result<(), String> {
    let snapshot = {
        let mut cfg = state.0.lock().unwrap();
        apply_setting(&mut cfg.settings, &key, &value)?;
        cfg.save(&app)?;
        cfg.settings.clone()
    };
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

/// Persistently swap the running app's dock/Finder icon to the given
/// variant. The setting is stored separately via `set_setting`; this
/// command performs the actual NSWorkspace + NSApp swap. We don't fold
/// it into `set_setting` because the side effect needs the AppHandle
/// for resource resolution and is macOS-specific.
#[tauri::command]
pub fn set_app_icon(variant: String, app: AppHandle) -> Result<(), String> {
    app_icon::apply_async(&app, &variant);
    Ok(())
}

#[tauri::command]
pub fn reset_settings(
    section: String,
    app: AppHandle,
    state: State<'_, ConfigState>,
) -> Result<(), String> {
    let snapshot = {
        let mut cfg = state.0.lock().unwrap();
        let s = &mut cfg.settings;
        match section.as_str() {
            "appearance" => {
                s.theme = None;
                s.theme_light_id = None;
                s.theme_dark_id = None;
                s.accent = None;
                s.density = None;
                s.app_icon = None;
            }
            "themes" => {
                s.theme = None;
                s.theme_light_id = None;
                s.theme_dark_id = None;
            }
            "typography" => {
                s.font_serif = None;
                s.font_sans = None;
                s.font_mono = None;
                s.body_size = None;
                s.ui_size = None;
                s.mono_size = None;
                s.line_height = None;
                s.hyphenation = None;
                s.body_ligatures = None;
                s.mono_ligatures = None;
            }
            "documents" | "plans" => {
                s.default_plans_root = None;
                s.plan_title_source = None;
                s.default_reader_mode = None;
            }
            "editor" => {
                s.editor_line_numbers = None;
                s.editor_soft_wrap = None;
                s.editor_tab_size = None;
                s.outline_show_tasks = None;
                s.outline_show_numbered_lists = None;
                s.outline_show_bulleted_lists = None;
                s.split_scroll_sync = None;
            }
            "git" => {
                s.show_change_indicators = None;
                s.compare_against = None;
                s.show_line_blame = None;
                s.show_commit_graph = None;
                s.git_branch_prefix = None;
                s.git_pull_strategy = None;
                s.git_fetch_interval_secs = None;
                s.git_allow_direct_push_to_main = None;
                s.git_confirm_direct_push_to_main = None;
                s.git_show_status_cluster = None;
            }
            "version-control" => {
                s.show_change_indicators = None;
                s.compare_against = None;
                s.show_line_blame = None;
                s.show_commit_graph = None;
            }
            "security" => {
                s.default_trust_policy = None;
                s.terminal_announce_output = None;
            }
            "app" => {
                s.keep_app_alive = None;
                s.check_for_updates_on_launch = None;
                s.update_channel = None;
            }
            "behavior" => {
                s.keep_app_alive = None;
            }
            "updates" => {
                s.check_for_updates_on_launch = None;
                s.update_channel = None;
            }
            "all" => *s = AppSettings::default(),
            _ => return Err(format!("unknown settings section: {section}")),
        }
        cfg.save(&app)?;
        cfg.settings.clone()
    };
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

/// Reveal the calling window. Windows are spawned hidden (via
/// tauri.conf.json `visible: false` for the cold-start main window
/// and `.visible(false)` on the WebviewWindowBuilder for settings /
/// extra workspaces) and the React bundle calls this once
/// `useApplyCss` has painted the polarity-correct theme. Without this
/// hide-until-painted dance the WKWebView shows its default opaque
/// white during the first frame and dark-theme users see a flash.
#[tauri::command]
pub fn show_window(window: Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

/// Tells the JS side what kind of binary it's running inside so it can
/// decide whether to surface auto-update affordances. The returned
/// string drives `src/lib/updater.ts`:
///
///   - `"macos"`         — full updater (we ship aarch64 only; the
///                         updater plugin handles arch matching).
///   - `"linux-appimage"` — full updater (`APPIMAGE` env var is set
///                         by the AppImage runtime).
///   - `"linux-deb-or-rpm"` — installed via system package manager;
///                         updater is hidden, UI points users at the
///                         package manager.
///   - `"windows"`       — UI points users at GitHub Releases for
///                         manual download; in-app updater not yet
///                         wired for Windows.
///   - `"unsupported"`   — anything else (BSD, mobile, exotic targets).
#[tauri::command]
pub fn updater_install_kind() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        // The AppImage runtime sets APPIMAGE to the absolute path of
        // the .AppImage file when running from one. Absence means the
        // user installed via `apt`, `dnf`, `pacman`, etc.
        if std::env::var_os("APPIMAGE").is_some() {
            "linux-appimage"
        } else {
            "linux-deb-or-rpm"
        }
    } else {
        "unsupported"
    }
}

/// Restart the app — used after the updater finishes installing.
/// Splits the JS install path from the OS-level relaunch so we don't
/// pull in a separate `tauri-plugin-process` just for one call.
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    app.restart();
}

// ─── Custom themes ───────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(default)]
    pub author: Option<String>,
    pub variables: HashMap<String, String>,
    #[serde(default, rename = "sourcePath")]
    pub source_path: String,
}

#[tauri::command]
pub fn list_custom_themes(app: AppHandle) -> Vec<CustomTheme> {
    let themes_dir = match app.path().app_config_dir() {
        Ok(d) => d.join("themes"),
        Err(_) => return vec![],
    };
    if !themes_dir.is_dir() {
        return vec![];
    }
    let entries = match std::fs::read_dir(&themes_dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        match serde_json::from_str::<CustomTheme>(&content) {
            Ok(mut t) => {
                t.source_path = path.to_string_lossy().into_owned();
                out.push(t);
            }
            Err(e) => {
                eprintln!("custom theme parse failed for {}: {e}", path.display());
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Push the active app theme's chrome colors into the GTK menubar.
/// Linux-only effect; macOS/Windows accept the call but no-op so the
/// frontend doesn't have to gate per-platform. The frontend resolves
/// `--paper`/`--ink` to rgb on its end (via canvas) so GTK 3's CSS
/// parser, which doesn't understand `oklch()`, gets values it can use.
#[tauri::command]
pub fn set_menu_theme(app: AppHandle, bg: String, fg: String, is_dark: bool) {
    #[cfg(target_os = "linux")]
    {
        let _ = app.run_on_main_thread(move || {
            crate::gtk_menu_theme::apply_on_main_thread(&bg, &fg, is_dark);
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, bg, fg, is_dark);
    }
}

/// Track light/dark for native Windows chrome (title bar + menu).
/// Windows-only effect; macOS/Linux accept the call but no-op so the
/// frontend doesn't have to gate per-platform. Custom palette colors
/// from the app theme are NOT honored — Windows menus only have a
/// light and a dark palette. See `win_dark_mode.rs` for the rationale.
#[tauri::command]
pub fn set_window_dark_mode(app: AppHandle, is_dark: bool) {
    #[cfg(target_os = "windows")]
    {
        crate::win_dark_mode::apply_to_all_windows(&app, is_dark);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, is_dark);
    }
}

fn apply_setting(s: &mut AppSettings, key: &str, v: &serde_json::Value) -> Result<(), String> {
    let null = v.is_null();
    match key {
        "theme" => {
            s.theme = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "themeLightId" => {
            s.theme_light_id = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "themeDarkId" => {
            s.theme_dark_id = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "accent" => {
            s.accent = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "bodySize" => {
            s.body_size = if null {
                None
            } else {
                v.as_u64().map(|n| n as u32)
            }
        }
        "uiSize" => {
            s.ui_size = if null {
                None
            } else {
                v.as_u64().map(|n| n as u32)
            }
        }
        "monoSize" => {
            s.mono_size = if null {
                None
            } else {
                v.as_u64().map(|n| n as u32)
            }
        }
        "lineHeight" => {
            s.line_height = if null {
                None
            } else {
                v.as_f64().map(|n| n as f32)
            }
        }
        "density" => {
            s.density = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "fontSerif" => {
            s.font_serif = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "fontSans" => {
            s.font_sans = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "fontMono" => {
            s.font_mono = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "editorLineNumbers" => s.editor_line_numbers = if null { None } else { v.as_bool() },
        "editorSoftWrap" => s.editor_soft_wrap = if null { None } else { v.as_bool() },
        "editorTabSize" => {
            s.editor_tab_size = if null {
                None
            } else {
                v.as_u64().map(|n| n as u32)
            }
        }
        "defaultPlansRoot" => {
            s.default_plans_root = if null {
                None
            } else {
                v.as_str().map(PathBuf::from)
            }
        }
        "keepAppAlive" => s.keep_app_alive = if null { None } else { v.as_bool() },
        "planTitleSource" => {
            s.plan_title_source = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "hyphenation" => s.hyphenation = if null { None } else { v.as_bool() },
        "bodyLigatures" => s.body_ligatures = if null { None } else { v.as_bool() },
        "monoLigatures" => s.mono_ligatures = if null { None } else { v.as_bool() },
        "showChangeIndicators" => s.show_change_indicators = if null { None } else { v.as_bool() },
        "compareAgainst" => {
            s.compare_against = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "showLineBlame" => s.show_line_blame = if null { None } else { v.as_bool() },
        "outlineShowTasks" => s.outline_show_tasks = if null { None } else { v.as_bool() },
        "outlineShowNumberedLists" => {
            s.outline_show_numbered_lists = if null { None } else { v.as_bool() }
        }
        "outlineShowBulletedLists" => {
            s.outline_show_bulleted_lists = if null { None } else { v.as_bool() }
        }
        "defaultReaderMode" => {
            s.default_reader_mode = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "splitScrollSync" => s.split_scroll_sync = if null { None } else { v.as_bool() },
        "showCommitGraph" => s.show_commit_graph = if null { None } else { v.as_bool() },
        "gitBranchPrefix" => {
            s.git_branch_prefix = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "gitPullStrategy" => {
            s.git_pull_strategy = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "gitFetchIntervalSecs" => {
            s.git_fetch_interval_secs = if null {
                None
            } else {
                v.as_u64().map(|n| n as u32)
            }
        }
        "gitAllowDirectPushToMain" => {
            s.git_allow_direct_push_to_main = if null { None } else { v.as_bool() }
        }
        "gitConfirmDirectPushToMain" => {
            s.git_confirm_direct_push_to_main = if null { None } else { v.as_bool() }
        }
        "gitShowStatusCluster" => s.git_show_status_cluster = if null { None } else { v.as_bool() },
        "docsShowArchivedByDefault" => {
            s.docs_show_archived_by_default = if null { None } else { v.as_bool() }
        }
        "appIcon" => {
            s.app_icon = if null {
                None
            } else {
                v.as_str().map(String::from)
            }
        }
        "defaultTrustPolicy" => {
            s.default_trust_policy = if null {
                None
            } else {
                match v.as_str() {
                    Some("alwaysAsk") => Some(DefaultTrustPolicy::Ask),
                    Some("alwaysTrust") => Some(DefaultTrustPolicy::Trust),
                    Some("alwaysUntrust") => Some(DefaultTrustPolicy::Untrust),
                    _ => return Err(format!("invalid defaultTrustPolicy: {v}")),
                }
            }
        }
        "checkForUpdatesOnLaunch" => {
            s.check_for_updates_on_launch = if null { None } else { v.as_bool() }
        }
        "updateChannel" => {
            s.update_channel = if null {
                None
            } else {
                match v.as_str() {
                    Some("stable") | Some("pre") => v.as_str().map(String::from),
                    _ => return Err(format!("invalid updateChannel: {v}")),
                }
            }
        }
        _ => return Err(format!("unknown setting: {key}")),
    }
    Ok(())
}
