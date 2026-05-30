//! Per-plans-root "do you trust this folder?" decision.
//!
//! Trust gates *outbound* network egress on render — remote images
//! and external links — without affecting whether local content
//! renders. The decision lives in `AppConfig.workspace_trust_per_root`,
//! keyed by the canonicalized plans-root path so symlink variants of
//! the same workspace share state.
//!
//! Three states the frontend needs to distinguish:
//!   - `Trusted`   — remote refs render normally.
//!   - `Untrusted` — remote refs become click-to-load placeholders.
//!   - "no decision yet" — represented by the absence of a map entry.
//!     The frontend prompts the user; the answer is then persisted.
//!
//! A global `DefaultTrustPolicy` (on `AppSettings`) lets power users
//! short-circuit the prompt — `alwaysTrust` / `alwaysUntrust` skip it
//! entirely and apply the policy silently the first time we see a
//! root.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, Window};

use crate::collab::workspace_config::{linked_repos_from_root, ResolvedLinkedRepo};
use crate::config::ConfigState;
use crate::state::WindowsState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustDecision {
    Trusted,
    Untrusted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTrustState {
    /// `None` means "no decision recorded for this root yet" — distinct
    /// from `Untrusted`, which is a remembered "no". The frontend uses
    /// this to decide whether to show the first-open prompt.
    pub decision: Option<TrustDecision>,
    /// Every linked repository from workspace config, paired with its
    /// current trust decision so the shield can show what is already
    /// trusted, not just what still needs attention.
    #[serde(default)]
    pub linked_repos: Vec<LinkedRepoTrustEntry>,
    /// Linked repositories from workspace config that have not yet had
    /// a read-only trust decision recorded.
    #[serde(default)]
    pub pending_linked_repos: Vec<LinkedRepoTrustTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRepoTrustTarget {
    pub handle: String,
    pub path: String,
    pub configured_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRepoTrustEntry {
    pub handle: String,
    pub path: String,
    pub configured_path: String,
    pub decision: Option<TrustDecision>,
}

/// Canonicalize the lookup key. Falls back to the raw path when the
/// folder no longer resolves (deleted, permissions changed) so callers
/// still get a stable answer instead of erroring.
fn trust_key(plans_root: &Path) -> PathBuf {
    plans_root
        .canonicalize()
        .unwrap_or_else(|_| plans_root.to_path_buf())
}

/// Pure lookup. The IPC command is just this plus the window→root +
/// state-mutex unwrap.
pub fn trust_for(
    map: &HashMap<PathBuf, TrustDecision>,
    plans_root: &Path,
) -> Option<TrustDecision> {
    map.get(&trust_key(plans_root)).copied()
}

/// Pure mutation. `Some(d)` records / overwrites the decision; `None`
/// clears it (back to "no decision yet").
pub fn apply_trust(
    map: &mut HashMap<PathBuf, TrustDecision>,
    plans_root: &Path,
    decision: Option<TrustDecision>,
) {
    let key = trust_key(plans_root);
    match decision {
        Some(d) => {
            map.insert(key, d);
        }
        None => {
            map.remove(&key);
        }
    }
}

pub fn pending_linked_repo_trust(
    map: &HashMap<PathBuf, TrustDecision>,
    repos: &[ResolvedLinkedRepo],
) -> Vec<LinkedRepoTrustTarget> {
    repos
        .iter()
        .filter(|repo| trust_for(map, &repo.path).is_none())
        .map(|repo| LinkedRepoTrustTarget {
            handle: repo.handle.clone(),
            path: repo.path.to_string_lossy().into_owned(),
            configured_path: repo.configured_path.clone(),
        })
        .collect()
}

pub fn linked_repo_trust_entries(
    map: &HashMap<PathBuf, TrustDecision>,
    repos: &[ResolvedLinkedRepo],
) -> Vec<LinkedRepoTrustEntry> {
    repos
        .iter()
        .map(|repo| LinkedRepoTrustEntry {
            handle: repo.handle.clone(),
            path: repo.path.to_string_lossy().into_owned(),
            configured_path: repo.configured_path.clone(),
            decision: trust_for(map, &repo.path),
        })
        .collect()
}

pub fn apply_linked_repo_trust(
    map: &mut HashMap<PathBuf, TrustDecision>,
    repos: &[ResolvedLinkedRepo],
    decision: TrustDecision,
) {
    for repo in repos {
        apply_trust(map, &repo.path, Some(decision));
    }
}

fn linked_repo_candidates(plans_root: &Path) -> Vec<ResolvedLinkedRepo> {
    match linked_repos_from_root(plans_root) {
        Ok(repos) => repos,
        Err(err) => {
            eprintln!(
                "linked repo config read failed for {}: {err}",
                plans_root.display()
            );
            Vec::new()
        }
    }
}

fn trust_state_for(
    cfg: &crate::config::AppConfig,
    plans_root: &Path,
    linked_repos: &[ResolvedLinkedRepo],
) -> WorkspaceTrustState {
    WorkspaceTrustState {
        decision: trust_for(&cfg.workspace_trust_per_root, plans_root),
        linked_repos: linked_repo_trust_entries(&cfg.linked_repo_read_trust, linked_repos),
        pending_linked_repos: pending_linked_repo_trust(&cfg.linked_repo_read_trust, linked_repos),
    }
}

#[tauri::command]
pub fn get_workspace_trust(
    window: Window,
    windows: State<'_, WindowsState>,
    state: State<'_, ConfigState>,
) -> Result<WorkspaceTrustState, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => {
            return Ok(WorkspaceTrustState {
                decision: None,
                linked_repos: Vec::new(),
                pending_linked_repos: Vec::new(),
            })
        }
    };
    let linked_repos = linked_repo_candidates(&plans_root);
    let cfg = state.0.lock().unwrap();
    Ok(trust_state_for(&cfg, &plans_root, &linked_repos))
}

#[tauri::command]
pub fn set_workspace_trust(
    decision: Option<TrustDecision>,
    apply_root: Option<bool>,
    apply_pending_linked_repos: Option<bool>,
    window: Window,
    windows: State<'_, WindowsState>,
    state: State<'_, ConfigState>,
    app: AppHandle,
) -> Result<(), String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Err("no plans root configured".into()),
    };
    let linked_repos = linked_repo_candidates(&plans_root);
    let next_state = {
        let mut cfg = state.0.lock().unwrap();
        if apply_root.unwrap_or(true) {
            apply_trust(&mut cfg.workspace_trust_per_root, &plans_root, decision);
        }
        if apply_pending_linked_repos.unwrap_or(false) {
            match decision {
                Some(decision) => {
                    apply_linked_repo_trust(
                        &mut cfg.linked_repo_read_trust,
                        &linked_repos,
                        decision,
                    );
                }
                None => {
                    for repo in &linked_repos {
                        apply_trust(&mut cfg.linked_repo_read_trust, &repo.path, None);
                    }
                }
            }
        }
        cfg.save(&app)?;
        trust_state_for(&cfg, &plans_root, &linked_repos)
    };
    // Notify the originating window so its renderer re-decides what
    // to load. Other windows on different roots aren't affected; each
    // window watches its own state.
    let _ = app.emit_to(
        tauri::EventTarget::webview_window(window.label()),
        "trust-changed",
        next_state,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn unset_root_returns_none() {
        let dir = tempdir().unwrap();
        let map: HashMap<PathBuf, TrustDecision> = HashMap::new();
        assert_eq!(trust_for(&map, dir.path()), None);
    }

    #[test]
    fn trusted_round_trip() {
        let dir = tempdir().unwrap();
        let mut map = HashMap::new();
        apply_trust(&mut map, dir.path(), Some(TrustDecision::Trusted));
        assert_eq!(trust_for(&map, dir.path()), Some(TrustDecision::Trusted));
    }

    #[test]
    fn untrusted_round_trip() {
        let dir = tempdir().unwrap();
        let mut map = HashMap::new();
        apply_trust(&mut map, dir.path(), Some(TrustDecision::Untrusted));
        assert_eq!(trust_for(&map, dir.path()), Some(TrustDecision::Untrusted));
    }

    #[test]
    fn none_clears_existing_entry() {
        let dir = tempdir().unwrap();
        let mut map = HashMap::new();
        apply_trust(&mut map, dir.path(), Some(TrustDecision::Trusted));
        apply_trust(&mut map, dir.path(), None);
        assert_eq!(trust_for(&map, dir.path()), None);
        assert!(map.is_empty());
    }

    #[test]
    fn none_on_unset_root_is_noop() {
        let dir = tempdir().unwrap();
        let mut map = HashMap::new();
        apply_trust(&mut map, dir.path(), None);
        assert!(map.is_empty());
    }

    #[test]
    fn overwrites_existing_decision() {
        let dir = tempdir().unwrap();
        let mut map = HashMap::new();
        apply_trust(&mut map, dir.path(), Some(TrustDecision::Trusted));
        apply_trust(&mut map, dir.path(), Some(TrustDecision::Untrusted));
        assert_eq!(trust_for(&map, dir.path()), Some(TrustDecision::Untrusted));
    }

    #[test]
    fn distinct_roots_are_independent() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let mut map = HashMap::new();
        apply_trust(&mut map, a.path(), Some(TrustDecision::Trusted));
        apply_trust(&mut map, b.path(), Some(TrustDecision::Untrusted));
        assert_eq!(trust_for(&map, a.path()), Some(TrustDecision::Trusted));
        assert_eq!(trust_for(&map, b.path()), Some(TrustDecision::Untrusted));
    }

    #[test]
    fn linked_repo_pending_filters_trusted_paths() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let repos = vec![
            ResolvedLinkedRepo {
                handle: "code".to_string(),
                path: a.path().to_path_buf(),
                configured_path: "../code".to_string(),
            },
            ResolvedLinkedRepo {
                handle: "landing".to_string(),
                path: b.path().to_path_buf(),
                configured_path: "../landing".to_string(),
            },
        ];
        let mut map = HashMap::new();
        apply_trust(&mut map, a.path(), Some(TrustDecision::Trusted));

        let pending = pending_linked_repo_trust(&map, &repos);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].handle, "landing");
    }

    #[test]
    fn linked_repo_trust_records_all_candidates() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let repos = vec![
            ResolvedLinkedRepo {
                handle: "code".to_string(),
                path: a.path().to_path_buf(),
                configured_path: "../code".to_string(),
            },
            ResolvedLinkedRepo {
                handle: "landing".to_string(),
                path: b.path().to_path_buf(),
                configured_path: "../landing".to_string(),
            },
        ];
        let mut map = HashMap::new();
        apply_linked_repo_trust(&mut map, &repos, TrustDecision::Trusted);

        assert_eq!(trust_for(&map, a.path()), Some(TrustDecision::Trusted));
        assert_eq!(trust_for(&map, b.path()), Some(TrustDecision::Trusted));
        assert!(pending_linked_repo_trust(&map, &repos).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_root_shares_decision() {
        // Two paths pointing at the same canonicalized folder must see
        // the same entry — that's the whole point of canonicalizing on
        // both read and write.
        let parent = tempdir().unwrap();
        let real = parent.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let linked = parent.path().join("linked");
        std::os::unix::fs::symlink(&real, &linked).unwrap();

        let mut map = HashMap::new();
        apply_trust(&mut map, &real, Some(TrustDecision::Trusted));
        // Reading via the symlinked path returns the same decision…
        assert_eq!(trust_for(&map, &linked), Some(TrustDecision::Trusted));
        // …and writing via the symlink doesn't create a duplicate entry.
        apply_trust(&mut map, &linked, Some(TrustDecision::Untrusted));
        assert_eq!(map.len(), 1);
        assert_eq!(trust_for(&map, &real), Some(TrustDecision::Untrusted));
    }
}
