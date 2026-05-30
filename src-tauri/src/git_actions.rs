// Git write actions + repo status surface.
//
// Thin wrappers over the system `git` binary. We deliberately don't
// pull in `libgit2` — shelling out preserves credential helpers,
// hooks, signing, and config without per-feature reimplementation.
//
// Every command resolves to the active window's plansRoot, walks up
// to the enclosing repo via `git_diff::find_repo_root`, and refuses
// cleanly when no repo is found.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, Window};

use crate::collab::workspace_config::linked_repos_from_root;
use crate::config::ConfigState;
use crate::git_diff::find_repo_root;
use crate::git_runner::{
    self, check_ownership, redact_credentials, validate_path_arg, validate_ref,
};
use crate::state::WindowsState;
use crate::workspace_trust::{trust_for, TrustDecision};

// ─── Status ─────────────────────────────────────────────────────────────

/// Working-tree change classification, surfaced as a single chip in
/// the Pending Changes panel.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    /// Either a `UU`/`AA`/`DD` conflict or a more exotic combination.
    /// Conflicted files are also surfaced separately under
    /// `GitStatus.conflicts` for easy banner targeting.
    Conflicted,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Repo-relative forward-slash path.
    pub path: String,
    /// Plans-root-relative path when the file lives under plansRoot,
    /// else None. UI uses this to decide whether to grey the row.
    pub rel_to_plans: Option<String>,
    pub kind: ChangeKind,
    /// Renames carry the source path as well.
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictedFile {
    pub path: String,
    pub rel_to_plans: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InProgressOp {
    None,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

/// Snapshot of the working tree + remote-tracking state for one repo.
/// All fields are populated in a single `git` invocation pair so the
/// frontend can render the status cluster in one round-trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// True when plansRoot is inside a Git work tree.
    pub in_repo: bool,
    /// Branch name, or "HEAD" when detached.
    pub branch: String,
    pub detached: bool,
    /// Current HEAD short SHA. `None` pre-initial-commit.
    pub short_sha: Option<String>,
    /// Configured upstream (e.g. "origin/main") if any.
    pub upstream: Option<String>,
    /// Local commits the upstream doesn't have.
    pub ahead: u32,
    /// Upstream commits the local branch doesn't have.
    pub behind: u32,
    /// True when the working tree has tracked changes vs. HEAD or any
    /// untracked files in the repo. Distinct from `changes.len() > 0`
    /// because `changes` is filtered to just the working-tree set the
    /// commit dialog cares about.
    pub dirty: bool,
    pub conflicts: Vec<ConflictedFile>,
    pub changes: Vec<ChangedFile>,
    pub in_progress: InProgressOp,
}

impl Default for GitStatus {
    fn default() -> Self {
        Self {
            in_repo: false,
            branch: String::new(),
            detached: false,
            short_sha: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            conflicts: Vec::new(),
            changes: Vec::new(),
            in_progress: InProgressOp::None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchArgs {
    pub repo_handle: Option<String>,
    pub manual: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoActionArgs {
    pub repo_handle: Option<String>,
    pub expected_branch: Option<String>,
}

/// Run a read-only git command. Pinned to `core.hooksPath=/dev/null`
/// and `safe.directory=<canonical repo root>` by [`git_runner`]. The
/// caller is responsible for the ownership precondition (see
/// [`require_repo`]).
fn run_git(repo_root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    git_runner::run_read(repo_root, args)
}

/// Look up the per-root `run_git_hooks` toggle. Defaults to `false`
/// (hooks disabled) when the root has no override.
fn root_allows_hooks(state: &State<'_, ConfigState>, repo_root: &Path) -> bool {
    let canon = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    let cfg = state.0.lock().unwrap();
    cfg.git_settings_per_root
        .get(&canon)
        .and_then(|s| s.run_git_hooks)
        .unwrap_or(false)
}

/// Run a write-side git command. Hook execution is gated by the
/// per-root `run_git_hooks` toggle (default off).
fn run_git_write(
    state: &State<'_, ConfigState>,
    repo_root: &Path,
    args: &[&str],
) -> Result<std::process::Output, String> {
    git_runner::run_write(repo_root, args, root_allows_hooks(state, repo_root))
}

fn detect_in_progress(repo_root: &Path) -> InProgressOp {
    let git_dir = repo_root.join(".git");
    if git_dir.join("MERGE_HEAD").exists() {
        return InProgressOp::Merge;
    }
    if git_dir.join("rebase-apply").exists() || git_dir.join("rebase-merge").exists() {
        return InProgressOp::Rebase;
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return InProgressOp::CherryPick;
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return InProgressOp::Revert;
    }
    InProgressOp::None
}

/// `XY PATH` (or `XY ORIG -> PATH`) decoder for `git status --porcelain=v1`.
/// We intentionally use v1 over v2 here — v1 is simpler, includes
/// rename pairs in one line, and gives us conflicts via the same `XY`
/// pair codes the rest of the world recognizes.
fn parse_porcelain_v1(
    stdout: &str,
    repo_root: &Path,
    plans_root: &Path,
) -> (Vec<ChangedFile>, Vec<ConflictedFile>) {
    let mut changes = Vec::new();
    let mut conflicts = Vec::new();
    let canon_plans = plans_root
        .canonicalize()
        .unwrap_or_else(|_| plans_root.to_path_buf());
    let canon_repo = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());

    for raw in stdout.lines() {
        if raw.len() < 3 {
            continue;
        }
        let xy = &raw[..2];
        let rest = &raw[3..];
        let (path, old_path) = if let Some(idx) = rest.find(" -> ") {
            (rest[idx + 4..].to_string(), Some(rest[..idx].to_string()))
        } else {
            (rest.to_string(), None)
        };

        let bytes = xy.as_bytes();
        let x = bytes[0];
        let y = bytes[1];
        let is_conflict = matches!((x, y), (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D'));
        let kind = if is_conflict {
            ChangeKind::Conflicted
        } else if xy == "??" {
            ChangeKind::Untracked
        } else {
            // Prefer the staged (X) status, fall back to the worktree (Y).
            match if x != b' ' && x != b'?' { x } else { y } {
                b'A' => ChangeKind::Added,
                b'M' | b'T' => ChangeKind::Modified,
                b'D' => ChangeKind::Deleted,
                b'R' => ChangeKind::Renamed,
                b'C' => ChangeKind::Copied,
                _ => ChangeKind::Other,
            }
        };

        let rel_to_plans = {
            let abs = canon_repo.join(&path);
            abs.strip_prefix(&canon_plans)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        };

        if is_conflict {
            conflicts.push(ConflictedFile {
                path: path.clone(),
                rel_to_plans: rel_to_plans.clone(),
            });
        }

        changes.push(ChangedFile {
            path,
            rel_to_plans,
            kind,
            old_path,
        });
    }
    (changes, conflicts)
}

/// Parses `git rev-list --count --left-right <upstream>...HEAD`. Output
/// is a single line `BEHIND<TAB>AHEAD`. Falls back to `(0, 0)` on any
/// parse error.
fn parse_ahead_behind(stdout: &str) -> (u32, u32) {
    let line = stdout.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let behind: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

#[tauri::command]
pub fn git_status(
    args: Option<GitRepoActionArgs>,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<GitStatus, String> {
    let args = args.unwrap_or_default();
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(GitStatus::default()),
    };
    let Some(repo_handle) = args
        .repo_handle
        .as_deref()
        .filter(|handle| !handle.is_empty())
    else {
        return git_status_for_plans_root(&plans_root);
    };
    let repo_root = match resolve_fetch_repo_root(&plans_root, Some(repo_handle), &config)
        .map_err(|e| e.message)?
    {
        Some(r) => r,
        None => return Ok(GitStatus::default()),
    };
    git_status_for_repo_root(&repo_root, &plans_root)
}

fn git_status_for_plans_root(plans_root: &Path) -> Result<GitStatus, String> {
    let repo_root = match find_repo_root(plans_root) {
        Some(r) => r,
        None => return Ok(GitStatus::default()),
    };
    git_status_for_repo_root(&repo_root, plans_root)
}

fn git_status_for_repo_root(repo_root: &Path, plans_root: &Path) -> Result<GitStatus, String> {
    // Refuse to read status against a repo owned by a different user —
    // a malicious .git/config in such a repo could redirect git
    // through `core.sshCommand`, `core.fsmonitor`, etc. on subsequent
    // invocations (CVE-2022-24765 family).
    if let Err(untrusted) = check_ownership(repo_root) {
        return Err(untrusted.into_message());
    }

    // Branch + short sha.
    let (branch, detached) = match run_git(repo_root, &["symbolic-ref", "--short", "HEAD"]) {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                ("HEAD".to_string(), true)
            } else {
                (s, false)
            }
        }
        _ => ("HEAD".to_string(), true),
    };
    let short_sha = run_git(repo_root, &["rev-parse", "--short", "HEAD"])
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            } else {
                None
            }
        });

    // Upstream + ahead/behind.
    let upstream = run_git(
        repo_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .and_then(|o| {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        } else {
            None
        }
    });
    let (ahead, behind) = if let Some(up) = upstream.as_deref() {
        match run_git(
            repo_root,
            &[
                "rev-list",
                "--count",
                "--left-right",
                &format!("{up}...HEAD"),
            ],
        ) {
            Ok(o) if o.status.success() => parse_ahead_behind(&String::from_utf8_lossy(&o.stdout)),
            _ => (0, 0),
        }
    } else {
        (0, 0)
    };

    // Working-tree changes + conflicts.
    let porcelain = run_git(
        repo_root,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )?;
    let (changes, conflicts) = if porcelain.status.success() {
        parse_porcelain_v1(
            &String::from_utf8_lossy(&porcelain.stdout),
            repo_root,
            plans_root,
        )
    } else {
        (Vec::new(), Vec::new())
    };
    let dirty = !changes.is_empty();

    Ok(GitStatus {
        in_repo: true,
        branch,
        detached,
        short_sha,
        upstream,
        ahead,
        behind,
        dirty,
        conflicts,
        changes,
        in_progress: detect_in_progress(repo_root),
    })
}

// ─── Branch listing ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    pub name: String,
    /// True for `refs/remotes/<remote>/<name>` entries.
    pub is_remote: bool,
    /// "<remote>/<name>" when remote, else None.
    pub remote: Option<String>,
    /// Last-commit author time (unix seconds).
    pub last_commit_secs: i64,
    pub last_commit_subject: String,
    /// Commits ahead of the default branch (e.g. main).
    pub ahead_main: u32,
    /// Commits behind the default branch.
    pub behind_main: u32,
    pub is_current: bool,
}

fn detect_default_branch_name(repo_root: &Path) -> String {
    if let Ok(o) = run_git(
        repo_root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if let Some(stripped) = s.strip_prefix("origin/") {
                if !stripped.is_empty() {
                    return stripped.to_string();
                }
            }
        }
    }
    for candidate in ["main", "master", "trunk"] {
        let exists = run_git(repo_root, &["rev-parse", "--verify", "--quiet", candidate])
            .map(|o| o.status.success())
            .unwrap_or(false);
        if exists {
            return candidate.to_string();
        }
    }
    "main".to_string()
}

fn current_branch(repo_root: &Path) -> Option<String> {
    let o = run_git(repo_root, &["symbolic-ref", "--short", "HEAD"]).ok()?;
    if !o.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Hard cap on branches returned to keep `git_branches` snappy on
/// repos with hundreds of long-lived feature branches. Each entry
/// past this point would trigger another `rev-list --count --left-right`
/// — the bottleneck. The picker keeps a search field for the long tail.
const BRANCH_LIST_LIMIT: usize = 50;
/// Skip the per-branch ahead/behind shellout once we've already
/// computed it for this many entries. The first N (newest) get the
/// full counts; the rest just show last-commit metadata.
const BRANCH_AHEAD_BEHIND_LIMIT: usize = 25;

#[tauri::command]
pub fn git_branches(
    include_remote: bool,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<Vec<BranchEntry>, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(Vec::new()),
    };
    git_branches_for_plans_root(&plans_root, include_remote)
}

fn git_branches_for_plans_root(
    plans_root: &Path,
    include_remote: bool,
) -> Result<Vec<BranchEntry>, String> {
    let repo_root = match find_repo_root(plans_root) {
        Some(r) => r,
        None => return Ok(Vec::new()),
    };
    if check_ownership(&repo_root).is_err() {
        // Same rationale as `git_status`. Surface as an empty list
        // rather than an error to avoid breaking the picker when the
        // user navigates away.
        return Ok(Vec::new());
    }

    let default_branch = detect_default_branch_name(&repo_root);
    let head = current_branch(&repo_root);

    // `for-each-ref` formatted line: refname<TAB>committerdate-unix<TAB>subject
    let format = "%(refname)%09%(committerdate:unix)%09%(contents:subject)";
    let mut args = vec!["for-each-ref", "--sort=-committerdate"];
    let format_arg = format!("--format={format}");
    args.push(&format_arg);
    args.push("refs/heads");
    if include_remote {
        args.push("refs/remotes");
    }
    let out = run_git(&repo_root, &args)?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);

    let mut entries = Vec::new();
    for line in stdout.lines() {
        if entries.len() >= BRANCH_LIST_LIMIT {
            break;
        }
        let mut parts = line.splitn(3, '\t');
        let refname = parts.next().unwrap_or("");
        let secs: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let subject = parts.next().unwrap_or("").to_string();

        let (name, is_remote, remote) = if let Some(rest) = refname.strip_prefix("refs/heads/") {
            (rest.to_string(), false, None)
        } else if let Some(rest) = refname.strip_prefix("refs/remotes/") {
            if rest.ends_with("/HEAD") {
                continue;
            }
            let remote = rest.split_once('/').map(|(r, _)| r.to_string());
            (rest.to_string(), true, remote)
        } else {
            continue;
        };

        // Compute ahead/behind vs. default branch only for the first
        // BRANCH_AHEAD_BEHIND_LIMIT entries — each takes a `rev-list`
        // shellout, which adds up on repos with lots of stale
        // branches. Sorted by recency so the entries that get the
        // counts are the ones the user most likely cares about.
        let (ahead_main, behind_main) = if name == default_branch
            || refname == format!("refs/remotes/origin/{default_branch}")
        {
            (0, 0)
        } else if entries.len() < BRANCH_AHEAD_BEHIND_LIMIT {
            let rev = if is_remote {
                refname
                    .strip_prefix("refs/remotes/")
                    .unwrap_or(refname)
                    .to_string()
            } else {
                name.clone()
            };
            match run_git(
                &repo_root,
                &[
                    "rev-list",
                    "--count",
                    "--left-right",
                    &format!("{default_branch}...{rev}"),
                ],
            ) {
                Ok(o) if o.status.success() => {
                    parse_ahead_behind(&String::from_utf8_lossy(&o.stdout))
                }
                _ => (0, 0),
            }
        } else {
            (0, 0)
        };

        let is_current = !is_remote && head.as_deref() == Some(name.as_str());
        entries.push(BranchEntry {
            name,
            is_remote,
            remote,
            last_commit_secs: secs,
            last_commit_subject: subject,
            ahead_main,
            behind_main,
            is_current,
        });
    }
    Ok(entries)
}

// ─── Checkout / create branch ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOpError {
    /// Short machine-friendly tag the UI can switch on.
    /// "dirty-tree" | "non-ff" | "main-protected" | "conflict" | "no-upstream"
    /// | "in-progress" | "no-repo" | "git" | "other"
    pub code: String,
    pub message: String,
}

impl GitOpError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

fn require_repo(plans_root: &Option<PathBuf>) -> Result<(PathBuf, PathBuf), GitOpError> {
    let plans_root = plans_root
        .clone()
        .ok_or_else(|| GitOpError::new("no-repo", "No plans root configured."))?;
    let repo_root = find_repo_root(&plans_root)
        .ok_or_else(|| GitOpError::new("no-repo", "Not in a git repository."))?;
    if let Err(untrusted) = check_ownership(&repo_root) {
        return Err(GitOpError::new("untrusted-repo", untrusted.into_message()));
    }
    Ok((plans_root, repo_root))
}

fn require_repo_for_handle(
    plans_root: &Option<PathBuf>,
    repo_handle: Option<&str>,
    config: &State<'_, ConfigState>,
) -> Result<(PathBuf, PathBuf), GitOpError> {
    let plans_root = plans_root
        .clone()
        .ok_or_else(|| GitOpError::new("no-repo", "No plans root configured."))?;
    let repo_root = resolve_fetch_repo_root(&plans_root, repo_handle, config)?
        .ok_or_else(|| GitOpError::new("no-repo", "Not in a git repository."))?;
    if let Err(untrusted) = check_ownership(&repo_root) {
        return Err(GitOpError::new("untrusted-repo", untrusted.into_message()));
    }
    Ok((plans_root, repo_root))
}

fn require_expected_branch(
    repo_root: &Path,
    expected_branch: Option<&str>,
) -> Result<(), GitOpError> {
    let Some(expected) = expected_branch.filter(|branch| !branch.is_empty()) else {
        return Ok(());
    };
    validate_ref(expected)
        .map_err(|e| GitOpError::new("invalid-ref", format!("invalid expected branch: {e}")))?;
    let current = current_branch(repo_root).unwrap_or_else(|| "HEAD".to_string());
    if current != expected {
        return Err(GitOpError::new(
            "branch-mismatch",
            format!(
                "Expected `{expected}` to be checked out, but `{current}` is checked out in this linked repo folder."
            ),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn git_init(window: Window, windows: State<'_, WindowsState>) -> Result<(), GitOpError> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| GitOpError::new("no-repo", "No plans root configured."))?;
    git_init_for_plans_root(&plans_root)
}

fn git_init_for_plans_root(plans_root: &Path) -> Result<(), GitOpError> {
    if let Some(repo_root) = find_repo_root(plans_root) {
        if let Err(untrusted) = check_ownership(&repo_root) {
            return Err(GitOpError::new("untrusted-repo", untrusted.into_message()));
        }
        return Ok(());
    }

    let root = plans_root
        .canonicalize()
        .map_err(|e| GitOpError::new("other", format!("Plans root is unavailable: {e}")))?;
    if !root.is_dir() {
        return Err(GitOpError::new(
            "other",
            format!("Plans root is not a directory: {}", root.display()),
        ));
    }

    match git_runner::run_write(&root, &["init"], false) {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(GitOpError::new("git", stderr_message(&o.stderr))),
        Err(e) => Err(GitOpError::new("git", redact_credentials(&e))),
    }
}

/// Stderr → `String`, with embedded URL credentials redacted before
/// the message ever reaches the frontend. Use this anywhere we'd
/// otherwise pipe `String::from_utf8_lossy(&o.stderr)` straight into
/// a [`GitOpError`].
fn stderr_message(stderr: &[u8]) -> String {
    redact_credentials(&String::from_utf8_lossy(stderr))
        .trim()
        .to_string()
}

#[tauri::command]
pub fn git_checkout(
    branch_name: String,
    track_remote: Option<bool>,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<(), GitOpError> {
    validate_ref(&branch_name)
        .map_err(|e| GitOpError::new("invalid-ref", format!("invalid branch name: {e}")))?;
    let ws = windows.get_or_create(window.label());
    let (_plans_root, repo_root) = require_repo(&ws.plans_root.lock().unwrap().clone())?;

    // Refuse on dirty tree (matches plan: "Commit or discard changes…").
    let dirty = run_git(&repo_root, &["diff", "--quiet", "HEAD"])
        .map(|o| o.status.code() == Some(1))
        .unwrap_or(false);
    let untracked = run_git(&repo_root, &["ls-files", "--others", "--exclude-standard"])
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false);
    if dirty || untracked {
        return Err(GitOpError::new(
            "dirty-tree",
            "Commit or discard changes before switching branches.",
        ));
    }

    let tracking_arg;
    let result = if track_remote.unwrap_or(false) {
        tracking_arg = format!("origin/{branch_name}");
        run_git_write(&config, &repo_root, &["checkout", "--track", &tracking_arg])
    } else {
        run_git_write(&config, &repo_root, &["checkout", &branch_name])
    };
    match result {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(GitOpError::new("git", stderr_message(&o.stderr))),
        Err(e) => Err(GitOpError::new("git", redact_credentials(&e))),
    }
}

#[tauri::command]
pub fn git_create_branch(
    name: String,
    base: Option<String>,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<(), GitOpError> {
    validate_ref(&name)
        .map_err(|e| GitOpError::new("invalid-ref", format!("invalid branch name: {e}")))?;
    if let Some(b) = base.as_deref().filter(|s| !s.is_empty()) {
        validate_ref(b)
            .map_err(|e| GitOpError::new("invalid-ref", format!("invalid base ref: {e}")))?;
    }
    let ws = windows.get_or_create(window.label());
    let (_plans_root, repo_root) = require_repo(&ws.plans_root.lock().unwrap().clone())?;

    let mut args = vec!["checkout", "-b", &name];
    if let Some(b) = base.as_deref() {
        if !b.is_empty() {
            args.push(b);
        }
    }
    match run_git_write(&config, &repo_root, &args) {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(GitOpError::new("git", stderr_message(&o.stderr))),
        Err(e) => Err(GitOpError::new("git", redact_credentials(&e))),
    }
}

// ─── Commit / discard ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: String,
    pub short_sha: String,
}

#[derive(Debug, Clone, Serialize)]
struct GitRefreshEvent {
    path: String,
    kind: &'static str,
}

#[tauri::command]
pub fn git_commit(
    message: String,
    paths: Vec<String>,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<CommitResult, GitOpError> {
    let ws = windows.get_or_create(window.label());
    let (plans_root, repo_root) = require_repo(&ws.plans_root.lock().unwrap().clone())?;
    let result = git_commit_in_repo(
        &repo_root,
        &message,
        &paths,
        root_allows_hooks(&config, &repo_root),
    )?;
    emit_commit_refresh(&window, &plans_root, &repo_root, &paths);
    Ok(result)
}

fn emit_commit_refresh(window: &Window, plans_root: &Path, repo_root: &Path, paths: &[String]) {
    let canon_plans = plans_root
        .canonicalize()
        .unwrap_or_else(|_| plans_root.to_path_buf());
    let canon_repo = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    for path in paths {
        let abs = canon_repo.join(path);
        let Ok(rel) = abs.strip_prefix(&canon_plans) else {
            continue;
        };
        let _ = window.emit(
            "plan-changed",
            GitRefreshEvent {
                path: rel.to_string_lossy().replace('\\', "/"),
                kind: "modified",
            },
        );
    }
    let _ = window.emit(
        "plan-changed",
        GitRefreshEvent {
            path: String::new(),
            kind: "modified",
        },
    );
}

fn git_commit_in_repo(
    repo_root: &Path,
    message: &str,
    paths: &[String],
    allow_hooks: bool,
) -> Result<CommitResult, GitOpError> {
    if message.trim().is_empty() {
        return Err(GitOpError::new("other", "Commit message cannot be empty."));
    }

    if paths.is_empty() {
        return Err(GitOpError::new("other", "No files selected to commit."));
    }

    // Reject paths that would be parsed as flags (`-p`, `--interactive`,
    // …). The `--` separator stops git from re-parsing as ref/option,
    // but path-list options would still be honored without the
    // up-front check.
    for p in paths {
        validate_path_arg(p)
            .map_err(|e| GitOpError::new("invalid-path", format!("rejected path: {e}: {p}")))?;
    }

    // `git add` each path explicitly. Using `-A` would include
    // unrelated changes outside what the user picked.
    let mut add_args: Vec<String> = vec!["add".to_string(), "--".to_string()];
    add_args.extend(paths.iter().cloned());
    let add_args_ref: Vec<&str> = add_args.iter().map(String::as_str).collect();
    let added = git_runner::run_write(repo_root, &add_args_ref, allow_hooks).map_err(|e| {
        GitOpError::new("git", format!("git add failed: {}", redact_credentials(&e)))
    })?;
    if !added.status.success() {
        return Err(GitOpError::new("git", stderr_message(&added.stderr)));
    }

    let committed = git_runner::run_write(repo_root, &["commit", "-m", message], allow_hooks);
    match committed {
        Ok(o) if o.status.success() => {
            let sha = run_git(repo_root, &["rev-parse", "HEAD"])
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let short = sha.chars().take(7).collect();
            Ok(CommitResult {
                sha,
                short_sha: short,
            })
        }
        Ok(o) => Err(GitOpError::new("git", stderr_message(&o.stderr))),
        Err(e) => Err(GitOpError::new("git", redact_credentials(&e))),
    }
}

#[tauri::command]
pub fn git_discard_file(
    path: String,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<(), GitOpError> {
    let ws = windows.get_or_create(window.label());
    let (_plans_root, repo_root) = require_repo(&ws.plans_root.lock().unwrap().clone())?;
    git_discard_file_in_repo(&repo_root, &path)
}

fn git_discard_file_in_repo(repo_root: &Path, path: &str) -> Result<(), GitOpError> {
    validate_path_arg(path)
        .map_err(|e| GitOpError::new("invalid-path", format!("rejected path: {e}: {path}")))?;
    // Try the modern restore command first; fall back to checkout for
    // older Git versions. Both use repo-relative paths.
    let restore = run_git(
        repo_root,
        &["restore", "--worktree", "--staged", "--", path],
    );
    if let Ok(o) = &restore {
        if o.status.success() {
            return Ok(());
        }
    }
    let fallback = run_git(repo_root, &["checkout", "--", path]);
    match fallback {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(GitOpError::new("git", stderr_message(&o.stderr))),
        Err(e) => Err(GitOpError::new("git", redact_credentials(&e))),
    }
}

// ─── Pull / push ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub subject: String,
    pub time_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    pub commits: Vec<PulledCommit>,
    /// True when the pull was a no-op (already up to date).
    pub up_to_date: bool,
}

#[tauri::command]
pub fn git_pull(
    mode: Option<String>,
    args: Option<GitRepoActionArgs>,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<PullSummary, GitOpError> {
    let args = args.unwrap_or_default();
    let ws = windows.get_or_create(window.label());
    let (_plans_root, repo_root) = require_repo_for_handle(
        &ws.plans_root.lock().unwrap().clone(),
        args.repo_handle.as_deref(),
        &config,
    )?;
    require_expected_branch(&repo_root, args.expected_branch.as_deref())?;
    git_pull_in_repo(
        &repo_root,
        mode.as_deref().unwrap_or("ff-only"),
        root_allows_hooks(&config, &repo_root),
    )
}

fn git_pull_in_repo(
    repo_root: &Path,
    mode: &str,
    allow_hooks: bool,
) -> Result<PullSummary, GitOpError> {
    // Capture HEAD before pulling so we can summarize new commits.
    let before = run_git(repo_root, &["rev-parse", "HEAD"])
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    let mut args = vec!["pull"];
    match mode {
        "rebase" => args.push("--rebase"),
        _ => args.push("--ff-only"),
    }
    let result = git_runner::run_write(repo_root, &args, allow_hooks);
    let output = match result {
        Ok(o) => o,
        Err(e) => return Err(GitOpError::new("git", redact_credentials(&e))),
    };

    if !output.status.success() {
        let stderr = redact_credentials(&String::from_utf8_lossy(&output.stderr));
        let lower = stderr.to_lowercase();
        let code = if lower.contains("not possible to fast-forward")
            || lower.contains("non-fast-forward")
            || lower.contains("diverged")
        {
            "non-ff"
        } else if lower.contains("conflict") {
            "conflict"
        } else if lower.contains("there is no tracking")
            || lower.contains("no remote")
            || lower.contains("no tracking information")
        {
            "no-upstream"
        } else if is_auth_failure(&lower) {
            "auth"
        } else {
            "git"
        };
        return Err(GitOpError::new(code, stderr.trim().to_string()));
    }

    let after = run_git(repo_root, &["rev-parse", "HEAD"])
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    let mut commits = Vec::new();
    let mut up_to_date = true;
    if let (Some(b), Some(a)) = (before.as_ref(), after.as_ref()) {
        if b != a {
            up_to_date = false;
            // FIELD_SEP = \x1f (matches git_diff.rs convention).
            let pretty = "--pretty=format:%H\x1f%h\x1f%an\x1f%at\x1f%s";
            let range = format!("{b}..{a}");
            let log = run_git(repo_root, &["log", "--no-color", pretty, &range]);
            if let Ok(o) = log {
                if o.status.success() {
                    let text = String::from_utf8_lossy(&o.stdout);
                    for line in text.lines() {
                        let mut parts = line.splitn(5, '\x1f');
                        let sha = parts.next().unwrap_or("").to_string();
                        let short_sha = parts.next().unwrap_or("").to_string();
                        let author = parts.next().unwrap_or("").to_string();
                        let time_secs: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                        let subject = parts.next().unwrap_or("").to_string();
                        if !sha.is_empty() {
                            commits.push(PulledCommit {
                                sha,
                                short_sha,
                                author,
                                subject,
                                time_secs,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(PullSummary {
        commits,
        up_to_date,
    })
}

#[tauri::command]
pub fn git_push(
    allow_main: Option<bool>,
    args: Option<GitRepoActionArgs>,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<(), GitOpError> {
    let args = args.unwrap_or_default();
    let ws = windows.get_or_create(window.label());
    let (_plans_root, repo_root) = require_repo_for_handle(
        &ws.plans_root.lock().unwrap().clone(),
        args.repo_handle.as_deref(),
        &config,
    )?;
    require_expected_branch(&repo_root, args.expected_branch.as_deref())?;
    git_push_in_repo(
        &repo_root,
        allow_main.unwrap_or(true),
        root_allows_hooks(&config, &repo_root),
    )
}

fn git_push_in_repo(
    repo_root: &Path,
    allow_main: bool,
    allow_hooks: bool,
) -> Result<(), GitOpError> {
    if !allow_main {
        if let Some(branch) = current_branch(repo_root) {
            if matches!(branch.as_str(), "main" | "master" | "trunk") {
                return Err(GitOpError::new(
                    "main-protected",
                    format!(
                        "Pushing directly to {branch} is disabled in Settings. Enable direct pushes, create a branch first, or run from terminal if intentional."
                    ),
                ));
            }
        }
    }

    let result = git_runner::run_write(repo_root, &["push"], allow_hooks);
    match result {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let stderr = redact_credentials(&String::from_utf8_lossy(&o.stderr));
            let lower = stderr.to_lowercase();
            let code = if lower.contains("non-fast-forward") || lower.contains("rejected") {
                "non-ff"
            } else if lower.contains("no upstream")
                || lower.contains("no configured push destination")
            {
                "no-upstream"
            } else if is_auth_failure(&lower) {
                "auth"
            } else {
                "git"
            };
            Err(GitOpError::new(code, stderr.trim().to_string()))
        }
        Err(e) => Err(GitOpError::new("git", redact_credentials(&e))),
    }
}

/// Heuristic detection of "git couldn't authenticate" — covers the
/// SSH BatchMode rejections and HTTPS credential-helper failures we
/// expect now that we suppress the parent terminal's tty prompts.
fn is_auth_failure(stderr_lower: &str) -> bool {
    stderr_lower.contains("permission denied (publickey)")
        || stderr_lower.contains("host key verification failed")
        || stderr_lower.contains("could not read username")
        || stderr_lower.contains("could not read password")
        || stderr_lower.contains("authentication failed")
        || stderr_lower.contains("terminal prompts disabled")
        || (stderr_lower.contains("ssh") && stderr_lower.contains("batch"))
}

// ─── Abort merge / rebase ───────────────────────────────────────────────

#[tauri::command]
pub fn git_abort_merge(
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<(), GitOpError> {
    let ws = windows.get_or_create(window.label());
    let (_plans_root, repo_root) = require_repo(&ws.plans_root.lock().unwrap().clone())?;

    let in_progress = detect_in_progress(&repo_root);
    let result = match in_progress {
        InProgressOp::Rebase => run_git_write(&config, &repo_root, &["rebase", "--abort"]),
        InProgressOp::CherryPick => run_git_write(&config, &repo_root, &["cherry-pick", "--abort"]),
        InProgressOp::Revert => run_git_write(&config, &repo_root, &["revert", "--abort"]),
        // Fall back to merge --abort for both Merge and None (None
        // covers the case where the user lands a `UU` from a merge
        // that's already been completed; no-op safe.).
        _ => run_git_write(&config, &repo_root, &["merge", "--abort"]),
    };
    match result {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(GitOpError::new("git", stderr_message(&o.stderr))),
        Err(e) => Err(GitOpError::new("git", redact_credentials(&e))),
    }
}

// ─── Background fetch ───────────────────────────────────────────────────

fn resolve_fetch_repo_root(
    plans_root: &Path,
    repo_handle: Option<&str>,
    config: &State<'_, ConfigState>,
) -> Result<Option<PathBuf>, GitOpError> {
    let Some(handle) = repo_handle.filter(|handle| !handle.is_empty()) else {
        return Ok(find_repo_root(plans_root));
    };
    if handle == "self" {
        return Ok(find_repo_root(plans_root));
    }

    let repos = linked_repos_from_root(plans_root)
        .map_err(|err| GitOpError::new("git", err.to_string()))?;
    let repo = repos
        .iter()
        .find(|repo| repo.handle == handle)
        .ok_or_else(|| GitOpError::new("git", format!("unknown linked repo handle `{handle}`")))?;

    let cfg = config.0.lock().unwrap();
    match trust_for(&cfg.linked_repo_read_trust, &repo.path) {
        Some(TrustDecision::Trusted) => {}
        Some(TrustDecision::Untrusted) => {
            return Err(GitOpError::new(
                "untrusted-repo",
                format!("linked repo `{handle}` is not trusted for read access"),
            ))
        }
        None => {
            return Err(GitOpError::new(
                "untrusted-repo",
                format!("linked repo `{handle}` has not been trusted for read access"),
            ))
        }
    }
    drop(cfg);

    let root = find_repo_root(&repo.path).ok_or_else(|| {
        GitOpError::new(
            "no-repo",
            format!("linked repo `{handle}` is not a git repository"),
        )
    })?;
    Ok(Some(root))
}

fn fetch_error_from_output(output: &std::process::Output) -> GitOpError {
    let stderr = stderr_message(&output.stderr);
    let lower = stderr.to_lowercase();
    let code = if is_auth_failure(&lower) {
        "auth"
    } else if lower.contains("no remote")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("could not read from remote repository")
    {
        "no-upstream"
    } else {
        "git"
    };
    let message = if stderr.is_empty() {
        "git fetch failed.".to_string()
    } else {
        stderr
    };
    GitOpError::new(code, message)
}

/// Fire-and-forget background `git fetch`. The frontend triggers this
/// on a timer and doesn't wait for the result; success/failure shows
/// up indirectly via the next `git_status` ahead/behind refresh.
#[tauri::command]
pub fn git_fetch(
    args: Option<GitFetchArgs>,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
    app: AppHandle,
) -> Result<bool, GitOpError> {
    let args = args.unwrap_or_default();
    let manual = args.manual.unwrap_or(false);
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(false),
    };
    let repo_root =
        match resolve_fetch_repo_root(&plans_root, args.repo_handle.as_deref(), &config)? {
            Some(r) => r,
            None => return Ok(false),
        };
    // Fetch is a network op against potentially attacker-controlled
    // remotes; we still want safe.directory + ownership enforcement.
    if let Err(untrusted) = check_ownership(&repo_root) {
        if manual {
            return Err(GitOpError::new("untrusted-repo", untrusted.into_message()));
        }
        return Ok(false);
    }
    // Background fetch detaches from the SSH agent so gnome-keyring-daemon
    // doesn't pop "Unlock private key storage" on every launch. Trade-off:
    // SSH-keyed remotes won't auto-fetch (BatchMode already prevented them
    // from completing here anyway). User-initiated Fetch/Pull/Push use
    // the agent via the standard write path.
    let fetch_args = ["fetch", "--all", "--prune", "--quiet"];
    let result = if manual {
        git_runner::run_write(
            &repo_root,
            &fetch_args,
            root_allows_hooks(&config, &repo_root),
        )
    } else {
        git_runner::run_write_no_ssh_agent(
            &repo_root,
            &fetch_args,
            root_allows_hooks(&config, &repo_root),
        )
    };
    let ok = matches!(result, Ok(ref output) if output.status.success());
    let _ = app.emit_to(
        tauri::EventTarget::webview_window(window.label()),
        "git-fetch-complete",
        ok,
    );
    match result {
        Ok(output) if output.status.success() => Ok(true),
        Ok(output) if manual => Err(fetch_error_from_output(&output)),
        Ok(_) => Ok(false),
        Err(err) if manual => Err(GitOpError::new("git", redact_credentials(&err))),
        Err(_) => Ok(false),
    }
}

// ─── Per-root git settings (push protection + branch prefix) ────────────
//
// Per-plans-root overrides for the user-level git settings live in
// `AppConfig.git_settings_per_root`. We expose two getters/setters so
// the Settings → Git pane can render and update them without leaking
// the canonical-path keying detail to the frontend.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PerRootGitSettings {
    /// New-branch namespace prefix (e.g. "specs/"). None → user-level fallback.
    pub branch_prefix: Option<String>,
    /// Allow UI pushes to main/master/trunk. None → user-level fallback (true).
    pub allow_direct_push_to_main: Option<bool>,
    /// Allow `pre-commit` / `post-checkout` etc. to execute on
    /// write-side git operations (commit / checkout / pull / push /
    /// merge / fetch). Defaults to `false` — we treat hooks in a
    /// freshly opened plans root as untrusted code unless the user
    /// has explicitly opted in for this root.
    pub run_git_hooks: Option<bool>,
}

#[tauri::command]
pub fn git_get_per_root_settings(
    window: Window,
    windows: State<'_, WindowsState>,
    state: State<'_, ConfigState>,
) -> Result<PerRootGitSettings, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(PerRootGitSettings::default()),
    };
    let canon = plans_root.canonicalize().unwrap_or(plans_root);
    let cfg = state.0.lock().unwrap();
    Ok(cfg
        .git_settings_per_root
        .get(&canon)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
pub fn git_set_per_root_settings(
    settings: PerRootGitSettings,
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
    let canon = plans_root.canonicalize().unwrap_or(plans_root);
    let mut cfg = state.0.lock().unwrap();
    if settings.branch_prefix.is_none()
        && settings.allow_direct_push_to_main.is_none()
        && settings.run_git_hooks.is_none()
    {
        cfg.git_settings_per_root.remove(&canon);
    } else {
        cfg.git_settings_per_root.insert(canon, settings);
    }
    cfg.save(&app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn run(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("git {} failed to spawn: {e}", args.join(" ")));
        assert!(
            output.status.success(),
            "git {} failed\nstdout:\n{}\nstderr:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init"]);
        run(dir.path(), &["config", "user.name", "Spec Rider"]);
        run(dir.path(), &["config", "user.email", "spec@example.com"]);
        run(dir.path(), &["branch", "-M", "main"]);
        fs::create_dir_all(dir.path().join("plans")).unwrap();
        dir
    }

    fn commit_file(repo: &Path, rel: &str, body: &str, message: &str) -> String {
        let abs = repo.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, body).unwrap();
        run(repo, &["add", "--", rel]);
        run(repo, &["commit", "-m", message]);
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn parses_porcelain_v1() {
        let out = " M docs/foo.md\nA  src/bar.rs\n?? new.md\nUU conflict.md\nR  old.md -> new.md\n";
        let plans_root = std::env::temp_dir();
        let repo_root = plans_root.clone();
        let (changes, conflicts) = parse_porcelain_v1(out, &repo_root, &plans_root);
        assert_eq!(changes.len(), 5);
        assert_eq!(conflicts.len(), 1);
        assert!(matches!(changes[0].kind, ChangeKind::Modified));
        assert!(matches!(changes[1].kind, ChangeKind::Added));
        assert!(matches!(changes[2].kind, ChangeKind::Untracked));
        assert!(matches!(changes[3].kind, ChangeKind::Conflicted));
        assert!(matches!(changes[4].kind, ChangeKind::Renamed));
        assert_eq!(changes[4].old_path.as_deref(), Some("old.md"));
    }

    #[test]
    fn parses_ahead_behind_pair() {
        assert_eq!(parse_ahead_behind("3\t5\n"), (5, 3));
        assert_eq!(parse_ahead_behind(""), (0, 0));
    }

    #[test]
    fn git_status_reports_changes_and_in_progress_state() {
        let repo = init_repo();
        let plans = repo.path().join("plans");
        commit_file(repo.path(), "plans/alpha.md", "# Alpha\n", "initial");
        fs::write(plans.join("alpha.md"), "# Alpha\n\nchanged\n").unwrap();
        fs::write(plans.join("new.md"), "# New\n").unwrap();
        fs::write(repo.path().join(".git").join("MERGE_HEAD"), "deadbeef\n").unwrap();

        let status = git_status_for_plans_root(&plans).unwrap();

        assert!(status.in_repo);
        assert_eq!(status.branch, "main");
        assert!(status.dirty);
        assert!(matches!(status.in_progress, InProgressOp::Merge));
        assert!(status
            .changes
            .iter()
            .any(|change| change.rel_to_plans.as_deref() == Some("alpha.md")
                && matches!(change.kind, ChangeKind::Modified)));
        assert!(status
            .changes
            .iter()
            .any(|change| change.rel_to_plans.as_deref() == Some("new.md")
                && matches!(change.kind, ChangeKind::Untracked)));
    }

    #[test]
    fn git_init_creates_repo_at_plans_root() {
        let dir = tempfile::tempdir().unwrap();

        git_init_for_plans_root(dir.path()).unwrap();
        let status = git_status_for_plans_root(dir.path()).unwrap();

        assert!(dir.path().join(".git").exists());
        assert!(status.in_repo);
    }

    #[test]
    fn git_branches_lists_current_and_feature_branches() {
        let repo = init_repo();
        let plans = repo.path().join("plans");
        commit_file(repo.path(), "plans/alpha.md", "# Alpha\n", "initial");
        run(repo.path(), &["checkout", "-b", "feature/spec"]);
        commit_file(repo.path(), "plans/beta.md", "# Beta\n", "feature commit");
        run(repo.path(), &["checkout", "main"]);

        let branches = git_branches_for_plans_root(&plans, false).unwrap();

        let main = branches.iter().find(|b| b.name == "main").unwrap();
        assert!(main.is_current);
        let feature = branches.iter().find(|b| b.name == "feature/spec").unwrap();
        assert_eq!(feature.ahead_main, 1);
        assert!(!feature.is_remote);
    }

    #[test]
    fn git_commit_stages_selected_paths_and_discard_restores_tracked_file() {
        let repo = init_repo();
        commit_file(repo.path(), "plans/alpha.md", "# Alpha\n", "initial");
        fs::write(repo.path().join("plans/alpha.md"), "# Alpha\n\ncommitted\n").unwrap();

        let result = git_commit_in_repo(
            repo.path(),
            "commit selected plan",
            &["plans/alpha.md".to_string()],
            false,
        )
        .unwrap();

        assert_eq!(result.short_sha.len(), 7);
        fs::write(repo.path().join("plans/alpha.md"), "# Alpha\n\nscratch\n").unwrap();
        git_discard_file_in_repo(repo.path(), "plans/alpha.md").unwrap();
        let restored = fs::read_to_string(repo.path().join("plans/alpha.md")).unwrap();
        assert_eq!(restored, "# Alpha\n\ncommitted\n");
    }

    #[test]
    fn git_pull_and_push_return_guard_errors_without_network() {
        let repo = init_repo();
        commit_file(repo.path(), "plans/alpha.md", "# Alpha\n", "initial");

        let protected = git_push_in_repo(repo.path(), false, false).unwrap_err();
        assert_eq!(protected.code, "main-protected");

        let push_no_upstream = git_push_in_repo(repo.path(), true, false).unwrap_err();
        assert_eq!(push_no_upstream.code, "no-upstream");

        let pull_no_upstream = git_pull_in_repo(repo.path(), "ff-only", false).unwrap_err();
        assert_eq!(pull_no_upstream.code, "no-upstream");
    }
}
