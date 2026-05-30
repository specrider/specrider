use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::git_actions::PerRootGitSettings;
use crate::pins::Pins;
use crate::workspace_trust::TrustDecision;

pub const MAX_RECENT_PROJECT_ROOTS: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PerWindowConfig {
    pub plans_root: Option<PathBuf>,
}

/// Persisted application settings. Every field is optional — `None`
/// means "use the hardcoded default", surfaced to the frontend so it
/// can render a sensible default value while keeping the on-disk
/// config sparse.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: Option<String>,          // "system" or any theme id
    pub theme_light_id: Option<String>, // chosen light theme when system mode
    pub theme_dark_id: Option<String>,  // chosen dark theme when system mode
    pub accent: Option<String>,         // CSS color string (e.g. oklch(...) or #hex)
    pub body_size: Option<u32>,         // px
    pub ui_size: Option<u32>, // px — chrome (titlebar, browser, outline, status bar, settings)
    pub mono_size: Option<u32>, // px — code blocks, frontmatter, status bar code, agent terminal
    pub line_height: Option<f32>,
    pub density: Option<String>, // "comfortable" | "dense"
    pub font_serif: Option<String>,
    pub font_sans: Option<String>,
    pub font_mono: Option<String>,
    pub editor_line_numbers: Option<bool>,
    pub editor_soft_wrap: Option<bool>,
    pub editor_tab_size: Option<u32>,
    pub default_plans_root: Option<PathBuf>,
    pub keep_app_alive: Option<bool>,
    /// "filename" or "heading" — controls what's shown in the document
    /// list when a file has no frontmatter `title`. None falls back to
    /// the hardcoded default ("heading").
    pub plan_title_source: Option<String>,
    pub hyphenation: Option<bool>,
    pub body_ligatures: Option<bool>,
    pub mono_ligatures: Option<bool>,
    /// Show unstaged-vs-HEAD change markers in the gutter, outline,
    /// reader, and status bar. None = use default ("on").
    pub show_change_indicators: Option<bool>,
    /// Diff baseline. v1 only supports "head".
    pub compare_against: Option<String>,
    /// Per-line blame annotation in the editor. Off by default — git
    /// blame is heavier and visually denser than the change indicators.
    pub show_line_blame: Option<bool>,
    /// Outline pane: surface task list items (`- [ ]`). Default on.
    pub outline_show_tasks: Option<bool>,
    /// Outline pane: surface ordered-list items (`1.`, `2.`). Default
    /// on — they often represent procedures or sub-sections worth
    /// jumping to.
    pub outline_show_numbered_lists: Option<bool>,
    /// Outline pane: surface bulleted list items (`-`, `*`). Default
    /// off — usually intra-paragraph elaboration; opt-in for docs that
    /// use bullets structurally.
    pub outline_show_bulleted_lists: Option<bool>,
    /// What mode newly-loaded plans open in. "read" | "edit" | "split".
    pub default_reader_mode: Option<String>,
    /// Two-way scroll sync between editor and preview in split mode.
    /// Off by default — divisive UX; ship behind the toggle.
    pub split_scroll_sync: Option<bool>,
    /// Render the SVG lane glyph column in the diff explorer's commit
    /// history rail. Default on; off → rows show only refs + subject +
    /// metadata.
    pub show_commit_graph: Option<bool>,
    /// User-level new-branch namespace prefix (e.g. "specs/"). Empty
    /// or None disables prefilling. Per-root overrides live under
    /// `AppConfig.git_settings_per_root`.
    pub git_branch_prefix: Option<String>,
    /// "ff-only" | "rebase". None falls back to "ff-only".
    pub git_pull_strategy: Option<String>,
    /// Background fetch interval in seconds. 0 disables. None falls
    /// back to 300 (5 minutes).
    pub git_fetch_interval_secs: Option<u32>,
    /// User-level policy for UI pushes to main/master/trunk. None
    /// falls back to allowed; false keeps a local hard block.
    pub git_allow_direct_push_to_main: Option<bool>,
    /// Ask before UI pushes to main/master/trunk when direct pushes
    /// are allowed. None falls back to true.
    pub git_confirm_direct_push_to_main: Option<bool>,
    /// Show the status-bar git cluster. None defaults to true.
    pub git_show_status_cluster: Option<bool>,
    /// In Tags / Assignees grouping modes, include archive plans
    /// inline by default. None falls back to false (archive plans
    /// hidden behind a `+N archived` pill).
    pub docs_show_archived_by_default: Option<bool>,
    /// Variant id (e.g. "default", "dark") for the persistent app
    /// icon override. None means "use the bundled .icns". Resolved by
    /// `app_icon` to `Contents/Resources/icons/variants/<id>.png`.
    pub app_icon: Option<String>,
    /// Opt-in scrubber for the agent terminal's environment. When on,
    /// env vars whose key contains `api_key` / `token` / `secret` /
    /// `password` (case-insensitive) are dropped before spawning a
    /// PTY. Default off — most users *want* their keys in the agent
    /// terminal so `claude` / `codex` can authenticate; the toggle
    /// is for screen-sharing / demo mode.
    pub terminal_scrub_secrets: Option<bool>,
    /// Mirror canvas-painted terminal output into a hidden textarea
    /// so screen readers can read it. Off by default — synthesizing
    /// the mirror is non-trivial under heavy terminal output.
    pub terminal_announce_output: Option<bool>,
    /// Default workspace-trust policy applied the first time a
    /// previously-unseen plans root is opened. None falls back to
    /// `alwaysAsk`. `alwaysTrust` / `alwaysUntrust` skip the prompt
    /// and persist the corresponding decision silently.
    pub default_trust_policy: Option<DefaultTrustPolicy>,
    /// Run the silent updater check on launch. Default on; the user
    /// can opt out via Settings → System & Updates.
    pub check_for_updates_on_launch: Option<bool>,
    /// Updater channel selector. `stable` (default) or `pre`. Both
    /// values currently resolve to the same endpoint — pre-release
    /// channel wiring is deferred until there's measurable demand.
    pub update_channel: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DefaultTrustPolicy {
    #[serde(rename = "alwaysAsk")]
    Ask,
    #[serde(rename = "alwaysTrust")]
    Trust,
    #[serde(rename = "alwaysUntrust")]
    Untrust,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    /// Per-window configs keyed by Tauri window label.
    #[serde(default)]
    pub windows: HashMap<String, PerWindowConfig>,
    /// Most recently opened project/plans folders, newest first.
    #[serde(default)]
    pub recent_project_roots: Vec<PathBuf>,
    /// App-wide settings (theme, fonts, etc).
    #[serde(default)]
    pub settings: AppSettings,
    /// Per-plans-root pins. Keyed by canonical plans-root path so two
    /// projects don't collide and a path with symlink variations
    /// resolves to the same bucket.
    #[serde(default)]
    pub pins: HashMap<PathBuf, Pins>,
    /// Per-plans-root overrides for git settings (branch prefix +
    /// allow-direct-push-to-main). Keyed by canonical plans-root path.
    #[serde(default)]
    pub git_settings_per_root: HashMap<PathBuf, PerRootGitSettings>,
    /// Per-plans-root workspace-trust decisions. Absence of an entry
    /// means "no decision yet" — the frontend prompts the user on
    /// first open. Keyed by canonical plans-root path.
    #[serde(default)]
    pub workspace_trust_per_root: HashMap<PathBuf, TrustDecision>,
    /// Linked repository read grants. These are intentionally separate
    /// from `workspace_trust_per_root`: workspace trust gates outbound
    /// remote content, while this gates read-only local Git access for
    /// repos named by `.specrider/workspace.json`.
    #[serde(default)]
    pub linked_repo_read_trust: HashMap<PathBuf, TrustDecision>,
}

impl AppConfig {
    fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("resolve config dir: {e}"))?;
        Ok(dir.join("config.json"))
    }

    pub fn load(app: &AppHandle) -> Self {
        let path = match Self::config_path(app) {
            Ok(p) => p,
            Err(_) => return Self::default(),
        };
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = Self::config_path(app)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir config dir: {e}"))?;
        }
        let bytes =
            serde_json::to_vec_pretty(self).map_err(|e| format!("serialize config: {e}"))?;
        std::fs::write(&path, bytes).map_err(|e| format!("write config: {e}"))
    }

    pub fn for_window<'a>(&'a self, label: &str) -> Option<&'a PerWindowConfig> {
        self.windows.get(label)
    }

    pub fn set_root_for(&mut self, label: &str, root: Option<PathBuf>) {
        self.windows
            .entry(label.to_string())
            .or_default()
            .plans_root = root;
    }

    pub fn remember_recent_project_root(&mut self, root: PathBuf) -> bool {
        promote_recent_root(
            &mut self.recent_project_roots,
            root,
            MAX_RECENT_PROJECT_ROOTS,
        )
    }

    pub fn forget_recent_project_root(&mut self, root: &std::path::Path) -> bool {
        let root = normalize_recent_project_root(root.to_path_buf());
        let before = self.recent_project_roots.clone();
        self.recent_project_roots
            .retain(|existing| normalize_recent_project_root(existing.clone()) != root);
        self.recent_project_roots != before
    }

    pub fn clear_recent_project_roots(&mut self) -> bool {
        if self.recent_project_roots.is_empty() {
            return false;
        }
        self.recent_project_roots.clear();
        true
    }
}

/// App-wide config wrapper — Tauri-managed state.
pub struct ConfigState(pub Mutex<AppConfig>);

fn normalize_recent_project_root(root: PathBuf) -> PathBuf {
    root.canonicalize().unwrap_or(root)
}

/// Promote `root` to the front of the recents list, dropping prior
/// entries that resolve to the same canonical path and truncating to
/// `max_len`. Returns whether anything actually changed (so callers can
/// skip a redundant `save()` on no-op).
pub fn promote_recent_root(list: &mut Vec<PathBuf>, root: PathBuf, max_len: usize) -> bool {
    let root = normalize_recent_project_root(root);
    let before = list.clone();
    list.retain(|existing| normalize_recent_project_root(existing.clone()) != root);
    list.insert(0, root);
    list.truncate(max_len);
    *list != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn promote_into_empty_list() {
        let mut list = Vec::new();
        let changed = promote_recent_root(&mut list, p("/a"), 5);
        assert!(changed);
        assert_eq!(list, vec![p("/a")]);
    }

    #[test]
    fn promote_moves_existing_to_front() {
        let mut list = vec![p("/a"), p("/b"), p("/c")];
        let changed = promote_recent_root(&mut list, p("/c"), 5);
        assert!(changed);
        assert_eq!(list, vec![p("/c"), p("/a"), p("/b")]);
    }

    #[test]
    fn promote_at_front_is_noop() {
        let mut list = vec![p("/a"), p("/b")];
        let before = list.clone();
        let changed = promote_recent_root(&mut list, p("/a"), 5);
        assert!(!changed);
        assert_eq!(list, before);
    }

    #[test]
    fn promote_truncates_to_max_len() {
        let mut list: Vec<PathBuf> = (0..10).map(|i| p(&format!("/r{i}"))).collect();
        promote_recent_root(&mut list, p("/new"), 5);
        assert_eq!(list.len(), 5);
        assert_eq!(list[0], p("/new"));
    }

    #[test]
    fn promote_dedupes_when_re_added() {
        let mut list = vec![p("/a"), p("/b"), p("/a")];
        promote_recent_root(&mut list, p("/a"), 5);
        // All `/a` entries collapse into one at the front.
        assert_eq!(list, vec![p("/a"), p("/b")]);
    }
}
