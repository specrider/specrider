use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::watcher::WatcherState;

/// Per-window mutable state. Each window owns its own plans root and
/// its own watcher; the analyze cache (path-keyed) stays app-wide.
pub struct WindowState {
    pub plans_root: Mutex<Option<PathBuf>>,
    pub watcher: WatcherState,
    /// One-shot plan path the new window should land on instead of the
    /// default newest-mtime selection. Set by `open_plan_in_new_window`
    /// before the webview is built; consumed (cleared) by the
    /// frontend's first `get_initial_state` call.
    pub pending_initial_plan: Mutex<Option<String>>,
}

impl WindowState {
    pub fn new() -> Self {
        Self {
            plans_root: Mutex::new(None),
            watcher: WatcherState::new(),
            pending_initial_plan: Mutex::new(None),
        }
    }
}

/// Container for per-window state, keyed by Tauri window label
/// (`"main"`, `"window-2"`, …).
pub struct WindowsState {
    inner: Mutex<HashMap<String, Arc<WindowState>>>,
}

impl WindowsState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Returns the existing `WindowState` for `label`, creating it if
    /// this is the first command from that window.
    pub fn get_or_create(&self, label: &str) -> Arc<WindowState> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(WindowState::new()))
            .clone()
    }
}
