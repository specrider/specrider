use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};

use crate::collab::workspace_config::WORKSPACE_CONFIG_REL;

/// How long after a self-write we ignore filesystem events for that
/// path. The renderer just wrote the bytes; if we re-emit, it'll
/// reload and clobber any in-flight edits — the data-loss surface.
const TOMBSTONE_TTL: Duration = Duration::from_secs(2);

/// Per-path debounce. Editors (and the OS) often fire several events
/// for one logical save; collapse anything within this window.
const EMIT_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Serialize, Clone)]
struct PlanChangeEvent {
    path: String,
    kind: &'static str,
}

#[derive(Serialize, Clone)]
struct WorkspaceConfigChangeEvent {
    path: String,
    kind: &'static str,
}

struct WatcherInner {
    watcher: Option<RecommendedWatcher>,
    /// Paths we just wrote ourselves; events touching these for ~2s are dropped
    /// so the frontend doesn't refetch its own writes.
    tombstones: Vec<(PathBuf, Instant)>,
    /// Last emit time per path, used for 300ms debouncing.
    last_emit: HashMap<PathBuf, Instant>,
}

pub struct WatcherState {
    inner: Arc<Mutex<WatcherInner>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WatcherInner {
                watcher: None,
                tombstones: Vec::new(),
                last_emit: HashMap::new(),
            })),
        }
    }

    /// Drop any existing watcher and start a fresh one rooted at `root`.
    /// Events emit only to the window identified by `window_label`.
    ///
    /// Both the watch target and the prefix used to strip event paths
    /// are canonicalized — without that, symlink resolution (e.g.
    /// `/Users/jake/Sites` → `/System/Volumes/Data/Users/jake/Sites`
    /// on macOS) breaks `strip_prefix` and silently drops every event.
    pub fn watch_for(
        &self,
        app: &AppHandle,
        window_label: String,
        root: PathBuf,
    ) -> notify::Result<()> {
        let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        let inner_arc = self.inner.clone();
        let app_clone = app.clone();
        let root_for_strip = canon_root.clone();

        // Drop the old watcher (if any) before creating a new one.
        {
            let mut inner = self.inner.lock().unwrap();
            inner.watcher = None;
            inner.last_emit.clear();
        }

        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    handle_event(
                        &inner_arc,
                        &app_clone,
                        &window_label,
                        &root_for_strip,
                        event,
                    );
                }
            })?;
        watcher.watch(&canon_root, RecursiveMode::Recursive)?;

        let mut inner = self.inner.lock().unwrap();
        inner.watcher = Some(watcher);
        Ok(())
    }

    pub fn tombstone(&self, path: PathBuf) {
        let mut inner = self.inner.lock().unwrap();
        record_tombstone(&mut inner, path, Instant::now());
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.watcher = None;
        inner.tombstones.clear();
        inner.last_emit.clear();
    }
}

/// Insert a tombstone, evicting any older than `TOMBSTONE_TTL` so the
/// list doesn't grow unbounded across long sessions.
fn record_tombstone(inner: &mut WatcherInner, path: PathBuf, now: Instant) {
    inner
        .tombstones
        .retain(|(_, t)| now.duration_since(*t) < TOMBSTONE_TTL);
    inner.tombstones.push((path, now));
}

/// Should this canonical path emit a change event right now?
///
/// Two filters: tombstones (we just wrote it ourselves) and per-path
/// debounce (the OS already fired this event 50 ms ago). Mutates
/// `inner` so the next call sees this emit recorded — keep all the
/// state changes in one place rather than scattering them across the
/// caller.
fn should_emit(inner: &mut WatcherInner, canon_path: &Path, now: Instant) -> bool {
    inner
        .tombstones
        .retain(|(_, t)| now.duration_since(*t) < TOMBSTONE_TTL);
    if inner.tombstones.iter().any(|(p, _)| p == canon_path) {
        return false;
    }
    if let Some(last) = inner.last_emit.get(canon_path) {
        if now.duration_since(*last) < EMIT_DEBOUNCE {
            return false;
        }
    }
    inner.last_emit.insert(canon_path.to_path_buf(), now);
    true
}

/// Resolve an event path to `(canonical, root-relative-string)` for
/// emission. Prefers the canonical form (so dedupe / tombstone keys
/// match across symlink variants); falls back to the raw path when
/// canonicalization fails — typically `Remove` events on a file that
/// no longer exists. Returns `None` when neither form is under the
/// canonical root, in which case the event isn't ours to emit.
fn resolve_event_path(canon_root: &Path, raw_path: &Path) -> Option<(PathBuf, String)> {
    let canon_path = raw_path
        .canonicalize()
        .unwrap_or_else(|_| raw_path.to_path_buf());
    if let Ok(rel) = canon_path.strip_prefix(canon_root) {
        let rel_string = rel.to_string_lossy().replace('\\', "/");
        return Some((canon_path, rel_string));
    }
    if let Ok(rel) = raw_path.strip_prefix(canon_root) {
        return Some((
            raw_path.to_path_buf(),
            rel.to_string_lossy().replace('\\', "/"),
        ));
    }
    None
}

fn handle_event(
    inner: &Arc<Mutex<WatcherInner>>,
    app: &AppHandle,
    window_label: &str,
    root: &Path,
    event: notify::Event,
) {
    let now = Instant::now();
    for path in &event.paths {
        let maybe_plan = path.extension().and_then(|s| s.to_str()) == Some("md");
        let maybe_workspace_config =
            path.file_name().and_then(|s| s.to_str()) == Some("workspace.json");
        if !maybe_plan && !maybe_workspace_config {
            continue;
        }
        let (canon_path, rel) = match resolve_event_path(root, path) {
            Some(v) => v,
            None => {
                eprintln!(
                    "watcher: event path {} not under root {}",
                    path.display(),
                    root.display()
                );
                continue;
            }
        };

        let kind = match event.kind {
            EventKind::Create(_) => "created",
            EventKind::Remove(_) => "removed",
            _ => "modified",
        };

        let event_name = if rel == WORKSPACE_CONFIG_REL {
            Some("workspace-config-changed")
        } else if maybe_plan {
            Some("plan-changed")
        } else {
            None
        };
        let Some(event_name) = event_name else {
            continue;
        };

        let emit = {
            let mut inner_g = inner.lock().unwrap();
            should_emit(&mut inner_g, &canon_path, now)
        };

        if emit {
            let target = EventTarget::webview_window(window_label);
            if event_name == "workspace-config-changed" {
                let _ = app.emit_to(
                    target,
                    event_name,
                    WorkspaceConfigChangeEvent { path: rel, kind },
                );
            } else {
                let _ = app.emit_to(target, event_name, PlanChangeEvent { path: rel, kind });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn fresh_inner() -> WatcherInner {
        WatcherInner {
            watcher: None,
            tombstones: Vec::new(),
            last_emit: HashMap::new(),
        }
    }

    // ---- should_emit ----

    #[test]
    fn fresh_path_emits() {
        let mut inner = fresh_inner();
        let p = PathBuf::from("/x/a.md");
        let now = Instant::now();
        assert!(should_emit(&mut inner, &p, now));
        assert!(inner.last_emit.contains_key(&p));
    }

    #[test]
    fn fresh_tombstone_suppresses_emit() {
        let mut inner = fresh_inner();
        let p = PathBuf::from("/x/a.md");
        let t0 = Instant::now();
        record_tombstone(&mut inner, p.clone(), t0);
        let now = t0 + Duration::from_secs(1);
        assert!(!should_emit(&mut inner, &p, now));
    }

    #[test]
    fn stale_tombstone_does_not_suppress() {
        let mut inner = fresh_inner();
        let p = PathBuf::from("/x/a.md");
        let t0 = Instant::now();
        record_tombstone(&mut inner, p.clone(), t0);
        let now = t0 + Duration::from_secs(3);
        assert!(should_emit(&mut inner, &p, now));
        assert!(inner.tombstones.is_empty());
    }

    #[test]
    fn debounces_within_window() {
        let mut inner = fresh_inner();
        let p = PathBuf::from("/x/a.md");
        let t0 = Instant::now();
        assert!(should_emit(&mut inner, &p, t0));
        let t1 = t0 + Duration::from_millis(200);
        assert!(!should_emit(&mut inner, &p, t1));
    }

    #[test]
    fn allows_emit_past_debounce_window() {
        let mut inner = fresh_inner();
        let p = PathBuf::from("/x/a.md");
        let t0 = Instant::now();
        assert!(should_emit(&mut inner, &p, t0));
        let t1 = t0 + Duration::from_millis(301);
        assert!(should_emit(&mut inner, &p, t1));
    }

    #[test]
    fn debounce_is_per_path() {
        let mut inner = fresh_inner();
        let a = PathBuf::from("/x/a.md");
        let b = PathBuf::from("/x/b.md");
        let t0 = Instant::now();
        assert!(should_emit(&mut inner, &a, t0));
        assert!(should_emit(&mut inner, &b, t0));
    }

    #[test]
    fn tombstone_is_per_path() {
        let mut inner = fresh_inner();
        let a = PathBuf::from("/x/a.md");
        let b = PathBuf::from("/x/b.md");
        let t0 = Instant::now();
        record_tombstone(&mut inner, a.clone(), t0);
        assert!(should_emit(&mut inner, &b, t0));
    }

    // ---- record_tombstone ----

    #[test]
    fn record_tombstone_prunes_on_insert() {
        let mut inner = fresh_inner();
        let p = PathBuf::from("/x/a.md");
        let t0 = Instant::now();
        record_tombstone(&mut inner, p.clone(), t0);
        let t1 = t0 + Duration::from_secs(5);
        record_tombstone(&mut inner, PathBuf::from("/x/b.md"), t1);
        assert_eq!(inner.tombstones.len(), 1);
        assert_eq!(inner.tombstones[0].0, PathBuf::from("/x/b.md"));
    }

    #[test]
    fn record_tombstone_keeps_recent_entries() {
        let mut inner = fresh_inner();
        let t0 = Instant::now();
        record_tombstone(&mut inner, PathBuf::from("/x/a.md"), t0);
        let t1 = t0 + Duration::from_millis(500);
        record_tombstone(&mut inner, PathBuf::from("/x/b.md"), t1);
        assert_eq!(inner.tombstones.len(), 2);
    }

    #[test]
    fn empty_tombstone_prune_does_not_panic() {
        let mut inner = fresh_inner();
        let p = PathBuf::from("/x/a.md");
        assert!(should_emit(&mut inner, &p, Instant::now()));
    }

    // ---- resolve_event_path ----

    #[test]
    fn resolves_real_file_under_root() {
        let dir = tempdir().unwrap();
        let canon_root = dir.path().canonicalize().unwrap();
        let file = canon_root.join("plan.md");
        fs::write(&file, b"hi").unwrap();

        let (canon, rel) = resolve_event_path(&canon_root, &file).unwrap();
        assert!(canon.starts_with(&canon_root));
        assert_eq!(rel, "plan.md");
    }

    #[test]
    fn resolves_via_raw_when_canonicalize_fails() {
        // File doesn't exist (e.g. Remove event) → canonicalize fails
        // → falls back to raw path. As long as the raw path is under
        // the canonical root, we still emit.
        let dir = tempdir().unwrap();
        let canon_root = dir.path().canonicalize().unwrap();
        let missing = canon_root.join("gone.md");

        let (canon, rel) = resolve_event_path(&canon_root, &missing).unwrap();
        assert_eq!(canon, missing);
        assert_eq!(rel, "gone.md");
    }

    #[test]
    fn returns_none_for_path_outside_root() {
        let inside = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let inside_canon = inside.path().canonicalize().unwrap();
        let stray = outside.path().join("oops.md");
        assert!(resolve_event_path(&inside_canon, &stray).is_none());
    }

    #[test]
    fn resolves_nested_path_to_relative_string() {
        let dir = tempdir().unwrap();
        let canon_root = dir.path().canonicalize().unwrap();
        let nested = canon_root.join("a/b/c.md");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, b"").unwrap();

        let (_, rel) = resolve_event_path(&canon_root, &nested).unwrap();
        assert_eq!(rel, "a/b/c.md");
    }
}
