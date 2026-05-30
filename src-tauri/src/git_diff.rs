use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{State, Window};

use crate::collab::workspace_config::linked_repos_from_root;
use crate::config::ConfigState;
use crate::git_runner::{self, validate_ref};
use crate::state::WindowsState;
use crate::workspace_trust::{trust_for, TrustDecision};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub added: Vec<u32>,
    pub modified: Vec<u32>,
    /// Working-tree line number after which a deleted block sits.
    /// Renderers display a marker between this line and the next.
    pub deleted_after: Vec<u32>,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPlan {
    pub rel: String,
    pub added_count: u32,
    pub modified_count: u32,
    pub removed_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Branch name (e.g. "main") or "HEAD" when the working tree is in
    /// a detached state.
    pub name: String,
    pub detached: bool,
    /// Short sha (~7 chars) of the current `HEAD`. Always populated
    /// when the repo has any commits. Useful for the title bar's
    /// "detached @ a1b2c3d" rendering.
    pub short_sha: Option<String>,
}

const CACHE_TTL: Duration = Duration::from_secs(2);
type UnstagedFingerprint = (String, u64);
type UnstagedDetailEntry = (UnstagedFingerprint, CommitDetail);
type CommitGraphCacheKey = (PathBuf, String, u64, u32, Option<String>, Option<String>);

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoArgs {
    pub repo_handle: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitReadAccess {
    Workspace,
    Linked,
}

#[derive(Debug, Clone)]
struct RepoTarget {
    root: PathBuf,
    access: GitReadAccess,
}

fn run_repo_read(target: &RepoTarget, args: &[&str]) -> Result<std::process::Output, String> {
    match target.access {
        GitReadAccess::Workspace => git_runner::run_read(&target.root, args),
        GitReadAccess::Linked => git_runner::run_linked_repo_read(&target.root, args),
    }
}

fn run_repo_read_with_path(
    target: &RepoTarget,
    args: &[&str],
    path: &Path,
) -> Result<std::process::Output, String> {
    if target.access == GitReadAccess::Linked {
        git_runner::validate_linked_repo_read_args(args)?;
    }
    git_runner::run_read_with_path(&target.root, args, path)
}

fn resolve_workspace_repo(plans_root: &Path) -> Result<RepoTarget, String> {
    let root = find_repo_root(plans_root).ok_or_else(|| "not in a git repository".to_string())?;
    Ok(RepoTarget {
        root,
        access: GitReadAccess::Workspace,
    })
}

fn resolve_repo_target(
    plans_root: &Path,
    repo_handle: Option<&str>,
    config: &State<'_, ConfigState>,
) -> Result<RepoTarget, String> {
    let Some(handle) = repo_handle.filter(|handle| !handle.is_empty()) else {
        return resolve_workspace_repo(plans_root);
    };
    if handle == "self" {
        return resolve_workspace_repo(plans_root);
    }

    let repos = linked_repos_from_root(plans_root).map_err(|err| err.to_string())?;
    let repo = repos
        .iter()
        .find(|repo| repo.handle == handle)
        .ok_or_else(|| format!("unknown linked repo handle `{handle}`"))?;

    let cfg = config.0.lock().unwrap();
    match trust_for(&cfg.linked_repo_read_trust, &repo.path) {
        Some(TrustDecision::Trusted) => {}
        Some(TrustDecision::Untrusted) => {
            return Err(format!(
                "linked repo `{handle}` is not trusted for read access"
            ))
        }
        None => {
            return Err(format!(
                "linked repo `{handle}` has not been trusted for read access"
            ))
        }
    }
    drop(cfg);

    let root = find_repo_root(&repo.path)
        .ok_or_else(|| format!("linked repo `{handle}` is not a git repository"))?;
    Ok(RepoTarget {
        root,
        access: GitReadAccess::Linked,
    })
}

#[derive(Default)]
pub struct DiffCache {
    inner: Mutex<HashMap<(PathBuf, u64), (Instant, ChangeSet)>>,
}

impl DiffCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &(PathBuf, u64)) -> Option<ChangeSet> {
        let mut inner = self.inner.lock().unwrap();
        if let Some((t, v)) = inner.get(key) {
            if t.elapsed() < CACHE_TTL {
                return Some(v.clone());
            }
        }
        inner.remove(key);
        None
    }

    fn put(&self, key: (PathBuf, u64), v: ChangeSet) {
        let mut inner = self.inner.lock().unwrap();
        inner.insert(key, (Instant::now(), v));
    }
}

/// Walks up from `start` until a `.git` entry is found. Works for files
/// (in which case we begin at the parent dir) or directories.
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur = if start.is_dir() {
        start.to_path_buf()
    } else {
        start.parent()?.to_path_buf()
    };
    loop {
        if cur.join(".git").exists() {
            return Some(cur);
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn file_mtime_secs(path: &Path) -> u64 {
    path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub fn diff_plan(
    plan_rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
    cache: State<'_, DiffCache>,
) -> Result<ChangeSet, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(ChangeSet::default()),
    };
    diff_plan_for_root(&plans_root, &plan_rel, &cache)
}

fn diff_plan_for_root(
    plans_root: &Path,
    plan_rel: &str,
    cache: &DiffCache,
) -> Result<ChangeSet, String> {
    let abs = plans_root.join(plan_rel);
    if !abs.is_file() {
        return Ok(ChangeSet::default());
    }
    let mtime = file_mtime_secs(&abs);
    let cache_key = (abs.clone(), mtime);
    if let Some(cs) = cache.get(&cache_key) {
        return Ok(cs);
    }
    let repo_root = match find_repo_root(&abs) {
        Some(r) => r,
        None => {
            let cs = ChangeSet::default();
            cache.put(cache_key, cs.clone());
            return Ok(cs);
        }
    };
    let rel_to_repo = match abs.strip_prefix(&repo_root) {
        Ok(p) => p.to_path_buf(),
        Err(_) => {
            // canonicalize fallback in case of symlink mismatches
            let canon_abs = abs.canonicalize().unwrap_or_else(|_| abs.clone());
            let canon_repo = repo_root
                .canonicalize()
                .unwrap_or_else(|_| repo_root.clone());
            match canon_abs.strip_prefix(&canon_repo) {
                Ok(p) => p.to_path_buf(),
                Err(_) => {
                    let cs = ChangeSet::default();
                    cache.put(cache_key, cs.clone());
                    return Ok(cs);
                }
            }
        }
    };
    let output = git_runner::run_read_with_path(
        &repo_root,
        &["diff", "--no-color", "--unified=0", "HEAD", "--"],
        &rel_to_repo,
    );
    let cs = match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let hunks = parse_hunks(&stdout);
            build_changeset(hunks)
        }
        _ => ChangeSet::default(),
    };
    cache.put(cache_key, cs.clone());
    Ok(cs)
}

#[tauri::command]
pub fn list_changed_plans(
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<Vec<ChangedPlan>, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    list_changed_plans_for_root(&plans_root)
}

fn list_changed_plans_for_root(plans_root: &Path) -> Result<Vec<ChangedPlan>, String> {
    let canon_plans_root = plans_root
        .canonicalize()
        .unwrap_or_else(|_| plans_root.to_path_buf());
    let repo_root = match find_repo_root(&canon_plans_root) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let canon_repo_root = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.clone());

    let output = git_runner::run_read(&canon_repo_root, &["diff", "--numstat", "HEAD"]);
    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Ok(vec![]),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.split('\t');
        let added = parts.next().and_then(|s| s.parse::<u32>().ok());
        let removed = parts.next().and_then(|s| s.parse::<u32>().ok());
        let path = parts.next();
        let (Some(added), Some(removed), Some(path)) = (added, removed, path) else {
            continue;
        };
        if !path.ends_with(".md") {
            continue;
        }
        let abs_in_repo = canon_repo_root.join(path);
        // Only surface plans inside the active plans_root.
        let rel_to_plans = match abs_in_repo.strip_prefix(&canon_plans_root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        out.push(ChangedPlan {
            rel: rel_to_plans,
            added_count: added,
            modified_count: 0,
            removed_count: removed,
        });
    }
    Ok(out)
}

fn parse_hunks(diff_output: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut current: Option<Hunk> = None;
    for line in diff_output.lines() {
        if line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            current = parse_hunk_header(line);
        } else if let Some(h) = current.as_mut() {
            // Skip "\ No newline at end of file" markers — they're not
            // diff content even though they don't start with - or +.
            if line.starts_with('\\') {
                continue;
            }
            if let Some(rest) = line.strip_prefix('-') {
                h.before.push_str(rest);
                h.before.push('\n');
            } else if let Some(rest) = line.strip_prefix('+') {
                h.after.push_str(rest);
                h.after.push('\n');
            }
        }
    }
    if let Some(h) = current.take() {
        hunks.push(h);
    }
    hunks
}

fn parse_hunk_header(line: &str) -> Option<Hunk> {
    // @@ -L[,C] +L'[,C'] @@ <optional context>
    let rest = line.strip_prefix("@@ ")?;
    let end_idx = rest.find(" @@")?;
    let header = &rest[..end_idx];
    let mut parts = header.split_whitespace();
    let old_part = parts.next()?.strip_prefix('-')?;
    let new_part = parts.next()?.strip_prefix('+')?;
    let (old_start, old_lines) = parse_range(old_part);
    let (new_start, new_lines) = parse_range(new_part);
    Some(Hunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        before: String::new(),
        after: String::new(),
    })
}

fn parse_range(s: &str) -> (u32, u32) {
    if let Some((start, count)) = s.split_once(',') {
        (start.parse().unwrap_or(0), count.parse().unwrap_or(0))
    } else {
        // Unified-zero never elides count, but be permissive.
        (s.parse().unwrap_or(0), 1)
    }
}

fn build_changeset(hunks: Vec<Hunk>) -> ChangeSet {
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut deleted_after = Vec::new();
    for h in &hunks {
        if h.old_lines == 0 && h.new_lines > 0 {
            for i in 0..h.new_lines {
                added.push(h.new_start + i);
            }
        } else if h.old_lines > 0 && h.new_lines == 0 {
            // Pure deletion: new_start is the working-tree line *before* the deletion.
            deleted_after.push(h.new_start);
        } else if h.old_lines > 0 && h.new_lines > 0 {
            for i in 0..h.new_lines {
                modified.push(h.new_start + i);
            }
        }
    }
    ChangeSet {
        added,
        modified,
        deleted_after,
        hunks,
    }
}

// ─── Blame ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    /// Short SHA (8 chars). Empty when `uncommitted`.
    pub sha: String,
    pub author: String,
    pub author_time: i64,
    pub summary: String,
    pub uncommitted: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub author_time: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlameSet {
    pub lines: Vec<BlameLine>,
    pub commits: HashMap<String, BlameCommit>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    pub sha: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub author_time: i64,
    pub files: Vec<String>,
    /// `https://github.com/<owner>/<repo>/commit/<sha>` when origin is
    /// recognizably a github remote, else None. The frontend uses this
    /// to gate the "Open on GitHub" action.
    pub github_url: Option<String>,
}

#[derive(Default)]
pub struct BlameCache {
    inner: Mutex<HashMap<(PathBuf, u64), (Instant, BlameSet)>>,
}

impl BlameCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &(PathBuf, u64)) -> Option<BlameSet> {
        let mut inner = self.inner.lock().unwrap();
        if let Some((t, v)) = inner.get(key) {
            if t.elapsed() < CACHE_TTL {
                return Some(v.clone());
            }
        }
        inner.remove(key);
        None
    }

    fn put(&self, key: (PathBuf, u64), v: BlameSet) {
        let mut inner = self.inner.lock().unwrap();
        inner.insert(key, (Instant::now(), v));
    }
}

/// Commit metadata is immutable (assuming no force-pushed rebases),
/// so this cache keeps entries for the session without a TTL.
#[derive(Default)]
pub struct CommitMetaCache {
    inner: Mutex<HashMap<String, CommitMeta>>,
}

impl CommitMetaCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, sha: &str) -> Option<CommitMeta> {
        self.inner.lock().unwrap().get(sha).cloned()
    }

    fn put(&self, sha: String, meta: CommitMeta) {
        self.inner.lock().unwrap().insert(sha, meta);
    }
}

/// Full commit diff bodies are immutable too (same caveat as
/// `CommitMetaCache`), so we hold them for the session keyed by
/// `(repo_root, sha)`. The sha alone isn't enough — a single Tauri
/// process can be driving multiple windows pointed at different repos.
#[derive(Default)]
pub struct CommitDetailCache {
    inner: Mutex<HashMap<(PathBuf, String), CommitDetail>>,
}

impl CommitDetailCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &(PathBuf, String)) -> Option<CommitDetail> {
        self.inner.lock().unwrap().get(key).cloned()
    }

    fn put(&self, key: (PathBuf, String), v: CommitDetail) {
        self.inner.lock().unwrap().insert(key, v);
    }
}

/// Working-tree diff is volatile but stable across no-op refreshes
/// (e.g. window-focus or debounced plan-changed pulses where nothing
/// actually moved). Fingerprint = `(head_sha, index_mtime_secs)` —
/// when either changes we re-fetch. We hold one slot per repo_root
/// since only the latest fingerprint is interesting; older slots
/// would just bloat memory.
#[derive(Default)]
pub struct UnstagedDetailCache {
    inner: Mutex<HashMap<PathBuf, UnstagedDetailEntry>>,
}

impl UnstagedDetailCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, repo_root: &Path, fingerprint: &UnstagedFingerprint) -> Option<CommitDetail> {
        let inner = self.inner.lock().unwrap();
        let (fp, v) = inner.get(repo_root)?;
        if fp == fingerprint {
            Some(v.clone())
        } else {
            None
        }
    }

    fn put(&self, repo_root: PathBuf, fingerprint: (String, u64), v: CommitDetail) {
        self.inner
            .lock()
            .unwrap()
            .insert(repo_root, (fingerprint, v));
    }
}

/// Resolves `HEAD` to a full sha. Returns `None` when not in a repo or
/// pre-initial-commit (the caller treats `None` as "don't cache").
fn head_full_sha_for(target: &RepoTarget) -> Option<String> {
    let out = run_repo_read(target, &["rev-parse", "HEAD"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// `(head_sha, index_mtime_secs)` fingerprint for the unstaged cache.
/// Returns `None` when either piece is missing — the caller skips the
/// cache rather than serving stale results under a degenerate key.
fn unstaged_fingerprint(target: &RepoTarget) -> Option<(String, u64)> {
    let head = head_full_sha_for(target)?;
    let index_mtime = file_mtime_secs(&target.root.join(".git").join("index"));
    if index_mtime == 0 {
        return None;
    }
    Some((head, index_mtime))
}

#[tauri::command]
pub fn blame_plan(
    plan_rel: String,
    window: Window,
    windows: State<'_, WindowsState>,
    cache: State<'_, BlameCache>,
) -> Result<BlameSet, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(BlameSet::default()),
    };
    blame_plan_for_root(&plans_root, &plan_rel, &cache)
}

fn blame_plan_for_root(
    plans_root: &Path,
    plan_rel: &str,
    cache: &BlameCache,
) -> Result<BlameSet, String> {
    let abs = plans_root.join(plan_rel);
    if !abs.is_file() {
        return Ok(BlameSet::default());
    }
    let mtime = file_mtime_secs(&abs);
    let cache_key = (abs.clone(), mtime);
    if let Some(b) = cache.get(&cache_key) {
        return Ok(b);
    }
    let repo_root = match find_repo_root(&abs) {
        Some(r) => r,
        None => {
            let b = BlameSet::default();
            cache.put(cache_key, b.clone());
            return Ok(b);
        }
    };
    let rel_to_repo = match abs.strip_prefix(&repo_root) {
        Ok(p) => p.to_path_buf(),
        Err(_) => {
            let canon_abs = abs.canonicalize().unwrap_or_else(|_| abs.clone());
            let canon_repo = repo_root
                .canonicalize()
                .unwrap_or_else(|_| repo_root.clone());
            match canon_abs.strip_prefix(&canon_repo) {
                Ok(p) => p.to_path_buf(),
                Err(_) => {
                    let b = BlameSet::default();
                    cache.put(cache_key, b.clone());
                    return Ok(b);
                }
            }
        }
    };
    let output =
        git_runner::run_read_with_path(&repo_root, &["blame", "--porcelain", "--"], &rel_to_repo);
    let blame = match output {
        Ok(o) if o.status.success() => parse_blame(&String::from_utf8_lossy(&o.stdout)),
        Ok(o) => {
            eprintln!(
                "git blame failed for {}: {}",
                rel_to_repo.display(),
                String::from_utf8_lossy(&o.stderr).trim()
            );
            BlameSet::default()
        }
        Err(e) => {
            eprintln!("git blame spawn failed: {e}");
            BlameSet::default()
        }
    };
    cache.put(cache_key, blame.clone());
    Ok(blame)
}

#[tauri::command]
pub fn commit_meta(
    sha: String,
    window: Window,
    windows: State<'_, WindowsState>,
    cache: State<'_, CommitMetaCache>,
) -> Result<CommitMeta, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "plans root not configured".to_string())?;
    commit_meta_for_root(&plans_root, &sha, &cache)
}

fn commit_meta_for_root(
    plans_root: &Path,
    sha: &str,
    cache: &CommitMetaCache,
) -> Result<CommitMeta, String> {
    if let Some(meta) = cache.get(sha) {
        return Ok(meta);
    }
    let repo_root = find_repo_root(plans_root).ok_or_else(|| "not a git repo".to_string())?;

    // Use a delimiter unlikely to appear in commit messages.
    const SEP: &str = "<<<SR_SEP>>>";
    let format = format!("%H{SEP}%s{SEP}%b{SEP}%an{SEP}%at");

    validate_ref(sha).map_err(|e| format!("invalid sha: {e}"))?;
    let format_arg = format!("--format={format}");
    let output = git_runner::run_read(&repo_root, &["show", "--no-patch", &format_arg, sha])
        .map_err(|e| format!("git show: {e}"))?;
    if !output.status.success() {
        return Err("commit not found".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.splitn(5, SEP);
    let full_sha = parts.next().unwrap_or("").trim().to_string();
    let subject = parts.next().unwrap_or("").trim().to_string();
    let body = parts.next().unwrap_or("").trim().to_string();
    let author = parts.next().unwrap_or("").trim().to_string();
    let author_time: i64 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);

    // Files touched — separate call so format parsing stays simple.
    let files_out = git_runner::run_read(&repo_root, &["show", "--name-only", "--format=", sha]);
    let files: Vec<String> = match files_out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    };

    let github_url = github_commit_url(&repo_root, &full_sha);

    let meta = CommitMeta {
        sha: full_sha.chars().take(8).collect(),
        subject,
        body,
        author,
        author_time,
        files,
        github_url,
    };
    cache.put(sha.to_string(), meta.clone());
    Ok(meta)
}

/// Inspects `git config --get remote.origin.url` and, if it points at a
/// github repo, returns a permalink to the commit. None for non-github
/// remotes or when there's no origin configured.
fn github_commit_url(repo_root: &Path, full_sha: &str) -> Option<String> {
    if full_sha.is_empty() {
        return None;
    }
    let out = git_runner::run_read(repo_root, &["config", "--get", "remote.origin.url"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // `git@github.com:owner/repo.git` or `https://github.com/owner/repo[.git]`
    let owner_repo = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest.trim_end_matches(".git").to_string()
    } else if let Some(rest) = url.strip_prefix("https://github.com/") {
        rest.trim_end_matches(".git").to_string()
    } else if let Some(rest) = url.strip_prefix("ssh://git@github.com/") {
        rest.trim_end_matches(".git").to_string()
    } else {
        return None;
    };
    Some(format!("https://github.com/{owner_repo}/commit/{full_sha}"))
}

fn parse_blame(output: &str) -> BlameSet {
    let mut lines: Vec<BlameLine> = Vec::new();
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    // Tracks the metadata seen for each SHA so subsequent line entries
    // (which omit metadata) can fall back to it.
    let mut sha_meta: HashMap<String, (String, i64, String)> = HashMap::new();

    let mut iter = output.lines().peekable();

    while let Some(header) = iter.next() {
        let mut parts = header.split_whitespace();
        let sha = match parts.next() {
            Some(s) if s.len() == 40 => s.to_string(),
            _ => continue,
        };
        // skip orig-line
        let _ = parts.next();
        let final_line: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(n) => n,
            None => continue,
        };

        let mut author = String::new();
        let mut author_time: i64 = 0;
        let mut summary = String::new();

        // Read metadata key/value lines until we hit `\t<source>`.
        while let Some(&peek) = iter.peek() {
            if peek.starts_with('\t') {
                break;
            }
            let line = iter.next().unwrap();
            if let Some(rest) = line.strip_prefix("author ") {
                author = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("author-time ") {
                author_time = rest.parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("summary ") {
                summary = rest.to_string();
            }
            // ignore other keys (committer, previous, filename, …)
        }
        // Consume the source line.
        iter.next();

        // Repeat-occurrence lines have no metadata in this block; pull from cache.
        if let Some((cached_a, cached_t, cached_s)) = sha_meta.get(&sha) {
            if author.is_empty() {
                author = cached_a.clone();
            }
            if author_time == 0 {
                author_time = *cached_t;
            }
            if summary.is_empty() {
                summary = cached_s.clone();
            }
        } else {
            sha_meta.insert(sha.clone(), (author.clone(), author_time, summary.clone()));
        }

        let uncommitted = sha.chars().all(|c| c == '0');
        let short_sha = if uncommitted {
            String::new()
        } else {
            sha.chars().take(8).collect()
        };

        if !uncommitted {
            commits
                .entry(short_sha.clone())
                .or_insert_with(|| BlameCommit {
                    sha: short_sha.clone(),
                    subject: summary.clone(),
                    author: author.clone(),
                    author_time,
                });
        }

        lines.push(BlameLine {
            line: final_line,
            sha: short_sha,
            author,
            author_time,
            summary,
            uncommitted,
        });
    }

    BlameSet { lines, commits }
}

/// Cheap repo-dirtiness probe used by the diff explorer to decide
/// whether to surface the synthetic Unstaged row. Mirrors the scope
/// of `git_status_unstaged` (tracked changes relative to HEAD or the
/// empty tree, plus untracked files), so consumers can pre-flight
/// whether the heavier diff fetch would return anything. False on
/// missing plansRoot, no repo, or any git exec failure — degrades to
/// "tree is clean" so the caller can fall through cleanly.
#[tauri::command]
pub fn git_has_uncommitted(
    args: GitRepoArgs,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> bool {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return false,
    };
    let target = match resolve_repo_target(&plans_root, args.repo_handle.as_deref(), &config) {
        Ok(target) => target,
        Err(_) => return false,
    };
    git_has_uncommitted_for_target(&target)
}

#[cfg(test)]
fn git_has_uncommitted_for_root(plans_root: &Path) -> bool {
    let target = match resolve_workspace_repo(plans_root) {
        Ok(target) => target,
        Err(_) => return false,
    };
    git_has_uncommitted_for_target(&target)
}

fn git_has_uncommitted_for_target(target: &RepoTarget) -> bool {
    let base = head_full_sha_for(target).unwrap_or_else(|| EMPTY_TREE_SHA.to_string());

    // `git diff --quiet <base>` exits 0 when clean, 1 when dirty,
    // anything else on error. Pair it with `ls-files --others` so the
    // synthetic Unstaged row matches `git_status_unstaged`, which also
    // surfaces untracked files.
    let tracked_dirty = run_repo_read(target, &["diff", "--quiet", &base])
        .map(|o| o.status.code() == Some(1))
        .unwrap_or(false);
    if tracked_dirty {
        return true;
    }

    run_repo_read(target, &["ls-files", "--others", "--exclude-standard"])
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Resolves the current branch + short HEAD sha for the active
/// window's plansRoot. Returns `None` when the directory isn't inside
/// a Git work tree. Detached-HEAD state is reflected in
/// `detached: true` with `name = "HEAD"`; consumers can still render
/// the short sha. No caching — this is one fast `git` call and the
/// frontend already debounces refresh via the watcher.
#[tauri::command]
pub fn git_branch(window: Window, windows: State<'_, WindowsState>) -> Option<BranchInfo> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws.plans_root.lock().unwrap().clone()?;
    let repo_root = find_repo_root(&plans_root)?;

    // `git symbolic-ref --short HEAD` prints the branch on success
    // (exit 0) and exits non-zero when HEAD is detached. Use that as
    // the detection signal, then fall back to the short sha for the
    // detached case.
    let sym = git_runner::run_read(&repo_root, &["symbolic-ref", "--short", "HEAD"]).ok()?;

    let short_sha = git_runner::run_read(&repo_root, &["rev-parse", "--short", "HEAD"])
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

    if sym.status.success() {
        let name = String::from_utf8_lossy(&sym.stdout).trim().to_string();
        if !name.is_empty() {
            return Some(BranchInfo {
                name,
                detached: false,
                short_sha,
            });
        }
    }

    // Detached HEAD (or pre-initial-commit). Either way, we report
    // detached + sha (None pre-first-commit).
    Some(BranchInfo {
        name: "HEAD".to_string(),
        detached: true,
        short_sha,
    })
}

// ─── Full-repo commit graph + plan-relevance overlay ────────────────────
//
// Builds a `--all` commit graph plus a "plan-relevance" overlay
// computed from file touches, frontmatter branches, and explicit SHAs.
//
// The graph drives the rail's lane rendering; the overlay drives row
// highlighting.

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommitSource {
    FileTouch,
    Branch,
    Explicit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub sha: String,
    pub short_sha: String,
    /// Full SHAs of every parent commit. Empty for the initial commit.
    /// Drives the lane-assignment algorithm in `commitGraphLanes.ts`.
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Unix epoch seconds (author time, stable across rebases).
    pub time_secs: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRelevance {
    pub sha: String,
    pub source: CommitSource,
    /// When `source = "branch"`, names the branch this SHA was reached
    /// from in the frontmatter list. Used by the rail to render the
    /// branch label badge.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphResponse {
    pub commits: Vec<GraphCommit>,
    pub plan_relevance: Vec<PlanRelevance>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefEntry {
    /// Display name — `main`, `origin/feat/foo`, `v1.2.0`.
    pub name: String,
    pub kind: RefKind,
    /// Full SHA the ref currently points at.
    pub target_sha: String,
    pub is_head: bool,
    pub is_default_branch: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogGraphArgs {
    /// Plan-relative path (under plansRoot). Optional — when absent the
    /// `file-touch` relevance source is skipped.
    pub plan_rel: Option<String>,
    #[serde(default)]
    pub branches: Vec<String>,
    #[serde(default)]
    pub commit_shas: Vec<String>,
    pub repo_handle: Option<String>,
    pub review_branch: Option<String>,
    pub review_base: Option<String>,
    pub limit: Option<u32>,
    pub before_sha: Option<String>,
}

const DEFAULT_HISTORY_LIMIT: u32 = 1000;
/// Field separator used inside `--pretty=format:`. Unit Separator
/// (\x1f) is a non-printable ASCII code that won't collide with author
/// names or commit subjects.
const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FIELD_SEP: char = '\x1f';

fn detect_default_branch_for(target: &RepoTarget) -> String {
    // Prefer `origin/HEAD` if the remote-tracking head exists. Falls
    // through to the local conventions if not.
    if let Ok(o) = run_repo_read(
        target,
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
    for candidate in ["main", "master"] {
        let exists = run_repo_read(target, &["rev-parse", "--verify", "--quiet", candidate])
            .map(|o| o.status.success())
            .unwrap_or(false);
        if exists {
            return candidate.to_string();
        }
    }
    "main".to_string()
}

/// Parses one `--pretty=format:%H FS %h FS %an FS %ae FS %at FS %s FS %P`
/// line into a `GraphCommit`. Parents are space-separated full SHAs.
/// `%P` is the trailing field so any internal whitespace it contains
/// (multiple parents → spaces) doesn't confuse the field split.
fn parse_graph_line(line: &str) -> Option<GraphCommit> {
    let mut parts = line.splitn(7, FIELD_SEP);
    let sha = parts.next()?.to_string();
    let short_sha = parts.next()?.to_string();
    let author_name = parts.next()?.to_string();
    let author_email = parts.next()?.to_string();
    let time_secs: i64 = parts.next()?.parse().ok()?;
    let subject = parts.next()?.to_string();
    let parents_raw = parts.next().unwrap_or("");
    if sha.is_empty() {
        return None;
    }
    let parents: Vec<String> = parents_raw.split_whitespace().map(str::to_string).collect();
    Some(GraphCommit {
        sha,
        short_sha,
        parents,
        author_name,
        author_email,
        time_secs,
        subject,
    })
}

/// Cache for graph commits. Keyed by `(repo_root, head_sha,
/// refs_fingerprint, limit, before_sha)` — when any ref changes
/// (branch created/moved, HEAD advanced) the fingerprint flips and
/// the cache misses cleanly.
/// Plan-relevance is *not* cached here because it depends on
/// per-call args (plan_rel, frontmatter branches/commits).
#[derive(Default)]
pub struct CommitGraphCache {
    inner: Mutex<HashMap<CommitGraphCacheKey, Vec<GraphCommit>>>,
}

impl CommitGraphCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &CommitGraphCacheKey) -> Option<Vec<GraphCommit>> {
        self.inner.lock().unwrap().get(key).cloned()
    }

    fn put(&self, key: CommitGraphCacheKey, v: Vec<GraphCommit>) {
        // Hold one slot per (repo, head, refs) — when fingerprints
        // shift we don't bother retaining old graphs.
        let mut inner = self.inner.lock().unwrap();
        inner.retain(|k, _| k.0 != key.0);
        inner.insert(key, v);
    }
}

/// Hashes a sorted "refname<TAB>sha\n" snapshot into a u64 we can use
/// as a cache key without storing kilobytes per repo. Not cryptographic
/// — collisions only cost a stale cache hit which the next pulse will
/// fix anyway.
fn refs_fingerprint(refs: &[RefEntry]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut snapshot: Vec<(String, String)> = refs
        .iter()
        .map(|r| (r.name.clone(), r.target_sha.clone()))
        .collect();
    snapshot.sort();
    let mut h = DefaultHasher::new();
    snapshot.hash(&mut h);
    h.finish()
}

fn run_git_log_graph(
    target: &RepoTarget,
    limit: u32,
    before_sha: Option<&str>,
) -> Vec<GraphCommit> {
    // `--all` walks every local + remote ref; `--date-order` keeps the
    // output sorted by author time which matches the rail's "newest
    // first" presentation. `%P` is the parents list (space-separated
    // full SHAs) and lives at the end of the format so any embedded
    // whitespace stays collected by `splitn(7, …)`.
    let pretty = format!(
        "--pretty=format:%H{s}%h{s}%an{s}%ae{s}%at{s}%s{s}%P",
        s = FIELD_SEP
    );
    let max_count_arg = format!("--max-count={limit}");
    let mut args: Vec<&str> = vec!["log", "--all", "--no-color", "--date-order"];
    if before_sha.is_none() {
        args.push(&max_count_arg);
    }
    args.push(&pretty);
    let out = run_repo_read(target, &args);
    match out {
        Ok(o) if o.status.success() => {
            let mut found_cursor = before_sha.is_none();
            let mut commits = Vec::new();
            for c in String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(parse_graph_line)
            {
                if !found_cursor {
                    if before_sha == Some(c.sha.as_str()) {
                        found_cursor = true;
                    }
                    continue;
                }
                if before_sha == Some(c.sha.as_str()) {
                    continue;
                }
                commits.push(c);
                if commits.len() >= limit as usize {
                    break;
                }
            }
            commits
        }
        _ => Vec::new(),
    }
}

fn run_git_log_graph_for_review_branch(
    target: &RepoTarget,
    branch: &str,
    base: &str,
    limit: u32,
    before_sha: Option<&str>,
) -> Vec<GraphCommit> {
    if validate_ref(branch).is_err() || validate_ref(base).is_err() {
        return Vec::new();
    }
    let exists = run_repo_read(target, &["rev-parse", "--verify", "--quiet", branch])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !exists {
        return Vec::new();
    }
    let pretty = format!(
        "--pretty=format:%H{s}%h{s}%an{s}%ae{s}%at{s}%s{s}%P",
        s = FIELD_SEP
    );
    let max_count_arg = format!("--max-count={limit}");
    let exclude_base = format!("^{base}");
    let mut args: Vec<&str> = vec!["log", "--no-color", "--date-order"];
    if before_sha.is_none() {
        args.push(&max_count_arg);
    }
    args.push(&pretty);
    args.push(branch);
    if branch != base {
        args.push(&exclude_base);
    }
    match run_repo_read(target, &args) {
        Ok(o) if o.status.success() => {
            let mut found_cursor = before_sha.is_none();
            let mut commits = Vec::new();
            for c in String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(parse_graph_line)
            {
                if !found_cursor {
                    if before_sha == Some(c.sha.as_str()) {
                        found_cursor = true;
                    }
                    continue;
                }
                if before_sha == Some(c.sha.as_str()) {
                    continue;
                }
                commits.push(c);
                if commits.len() >= limit as usize {
                    break;
                }
            }
            commits
        }
        _ => Vec::new(),
    }
}

/// Returns the SHAs reached by `git log <revs> --pretty=format:%H`.
/// Used to expand a frontmatter branch into "commits unique to this
/// branch (vs default)". Refs are validated by [`validate_ref`] before
/// being passed to git, and `--` separates options from refs so a
/// pathological frontmatter value can't slip through as a flag.
fn run_git_log_shas(target: &RepoTarget, revs: &[String], limit: u32) -> Vec<String> {
    let max_count_arg = format!("--max-count={limit}");
    let mut args: Vec<&str> = vec!["log", "--no-color", &max_count_arg, "--pretty=format:%H"];
    // Track whether all refs validated; bail out without running git
    // if any failed since a partial revs list would change semantics.
    for r in revs {
        // `^foo` is a meaningful prefix in git rev-walk syntax (exclude
        // commits reachable from foo); accept it then validate the
        // bare ref.
        let bare = r.strip_prefix('^').unwrap_or(r);
        if validate_ref(bare).is_err() {
            return Vec::new();
        }
    }
    for r in revs {
        args.push(r.as_str());
    }
    match run_repo_read(target, &args) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// `git log --follow -- <plan>` reduced to full SHAs. Drives the
/// `file-touch` plan-relevance source.
fn run_git_log_file_shas(target: &RepoTarget, rel: &Path, limit: u32) -> Vec<String> {
    let max_count_arg = format!("--max-count={limit}");
    let out = run_repo_read_with_path(
        target,
        &[
            "log",
            "--follow",
            "--no-color",
            &max_count_arg,
            "--pretty=format:%H",
            "--",
        ],
        rel,
    );
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[tauri::command]
pub fn git_log_graph(
    args: GitLogGraphArgs,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
    cache: State<'_, CommitGraphCache>,
) -> Result<CommitGraphResponse, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => {
            return Ok(CommitGraphResponse {
                commits: Vec::new(),
                plan_relevance: Vec::new(),
            })
        }
    };
    let target = match resolve_repo_target(&plans_root, args.repo_handle.as_deref(), &config) {
        Ok(target) => target,
        Err(err) if args.repo_handle.is_none() => {
            eprintln!("git log graph repo resolve failed: {err}");
            return Ok(CommitGraphResponse {
                commits: Vec::new(),
                plan_relevance: Vec::new(),
            });
        }
        Err(err) => return Err(err),
    };
    git_log_graph_for_target(&plans_root, target, args, &cache)
}

#[cfg(test)]
fn git_log_graph_for_root(
    plans_root: &Path,
    args: GitLogGraphArgs,
    cache: &CommitGraphCache,
) -> Result<CommitGraphResponse, String> {
    let target = match resolve_workspace_repo(plans_root) {
        Ok(target) => target,
        Err(_) => {
            return Ok(CommitGraphResponse {
                commits: Vec::new(),
                plan_relevance: Vec::new(),
            })
        }
    };
    git_log_graph_for_target(plans_root, target, args, cache)
}

fn git_log_graph_for_target(
    plans_root: &Path,
    target: RepoTarget,
    args: GitLogGraphArgs,
    cache: &CommitGraphCache,
) -> Result<CommitGraphResponse, String> {
    let limit = args.limit.unwrap_or(DEFAULT_HISTORY_LIMIT);
    let review_branch = args.review_branch.as_deref().filter(|s| !s.is_empty());
    let review_base = args.review_base.as_deref().filter(|s| !s.is_empty());
    let graph_filter_key =
        review_branch.map(|branch| format!("{}..{}", review_base.unwrap_or("main"), branch));

    // Refs first — drives the cache fingerprint and is also handy for
    // resolving the default branch without re-shelling.
    let refs = collect_refs(&target);
    let head_sha = head_full_sha_for(&target).unwrap_or_else(|| String::from("none"));
    let fp = refs_fingerprint(&refs);

    let before_sha = args.before_sha.as_deref().filter(|s| !s.is_empty());
    let cache_key = (
        target.root.clone(),
        head_sha.clone(),
        fp,
        limit,
        graph_filter_key,
        before_sha.map(str::to_string),
    );
    let commits = if let Some(cached) = cache.get(&cache_key) {
        cached
    } else {
        let fresh = if let Some(branch) = review_branch {
            run_git_log_graph_for_review_branch(
                &target,
                branch,
                review_base.unwrap_or("main"),
                limit,
                before_sha,
            )
        } else {
            run_git_log_graph(&target, limit, before_sha)
        };
        cache.put(cache_key, fresh.clone());
        fresh
    };

    // Plan-relevance overlay — same union as the old `git_log_for_plan`
    // but applied as marks on the graph rather than as an inclusion
    // filter. Higher-priority sources clobber lower ones (explicit >
    // branch > file-touch).
    let mut relevance: HashMap<String, PlanRelevance> = HashMap::new();
    let visible: std::collections::HashSet<&str> = commits.iter().map(|c| c.sha.as_str()).collect();

    if let Some(branch) = review_branch {
        for c in &commits {
            relevance.insert(
                c.sha.clone(),
                PlanRelevance {
                    sha: c.sha.clone(),
                    source: CommitSource::Branch,
                    branch: Some(branch.to_string()),
                },
            );
        }
    } else {
        // 1. File-touching commits — needs an existing plan path.
        if let Some(plan_rel) = args.plan_rel.as_deref() {
            let abs = plans_root.join(plan_rel);
            let rel_to_repo = repo_root_relative(&abs, &target.root);
            if let Some(rel) = rel_to_repo {
                for sha in run_git_log_file_shas(&target, &rel, limit) {
                    if !visible.contains(sha.as_str()) {
                        continue;
                    }
                    relevance.entry(sha.clone()).or_insert(PlanRelevance {
                        sha,
                        source: CommitSource::FileTouch,
                        branch: None,
                    });
                }
            }
        }

        // 2. Frontmatter branches — `<branch> ^<default>` minus the
        //    common-ancestor noise. Skips deleted/missing branches.
        //    Rejects branch names that begin with `-` or contain
        //    whitespace/NUL — frontmatter is author-controlled, and a
        //    plan committed by an attacker could otherwise smuggle
        //    `--upload-pack=…` style flags in here.
        let default_branch = detect_default_branch_for(&target);
        for branch in &args.branches {
            if validate_ref(branch).is_err() {
                continue;
            }
            let exists = run_repo_read(&target, &["rev-parse", "--verify", "--quiet", branch])
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !exists {
                continue;
            }
            let revs: Vec<String> = if branch == &default_branch {
                vec![branch.clone()]
            } else {
                vec![branch.clone(), format!("^{default_branch}")]
            };
            for sha in run_git_log_shas(&target, &revs, limit) {
                if !visible.contains(sha.as_str()) {
                    continue;
                }
                // Branch beats file-touch.
                let entry = relevance.entry(sha.clone()).or_insert(PlanRelevance {
                    sha: sha.clone(),
                    source: CommitSource::Branch,
                    branch: Some(branch.clone()),
                });
                if matches!(entry.source, CommitSource::FileTouch) {
                    entry.source = CommitSource::Branch;
                    entry.branch = Some(branch.clone());
                }
            }
        }

        // 3. Explicit SHAs from frontmatter `commits:` — short or full.
        //    `git rev-parse <sha>^{commit}` resolves them to full SHAs and
        //    fails cleanly on orphans. Same validation rationale as the
        //    branch case: frontmatter is author-controlled.
        for sha_input in &args.commit_shas {
            if validate_ref(sha_input).is_err() {
                continue;
            }
            let revspec = format!("{sha_input}^{{commit}}");
            let resolved = run_repo_read(&target, &["rev-parse", &revspec]);
            let full = match resolved {
                Ok(o) if o.status.success() => {
                    String::from_utf8_lossy(&o.stdout).trim().to_string()
                }
                _ => continue,
            };
            if full.is_empty() || !visible.contains(full.as_str()) {
                continue;
            }
            // Explicit beats branch beats file-touch.
            let entry = relevance.entry(full.clone()).or_insert(PlanRelevance {
                sha: full.clone(),
                source: CommitSource::Explicit,
                branch: None,
            });
            entry.source = CommitSource::Explicit;
            entry.branch = None;
        }
    }

    let plan_relevance: Vec<PlanRelevance> = relevance.into_values().collect();
    Ok(CommitGraphResponse {
        commits,
        plan_relevance,
    })
}

/// Strip the repo-root prefix from an absolute path, falling back to
/// canonicalization for symlinked plansRoots.
fn repo_root_relative(abs: &Path, repo_root: &Path) -> Option<PathBuf> {
    if let Ok(p) = abs.strip_prefix(repo_root) {
        return Some(p.to_path_buf());
    }
    let canon_abs = abs.canonicalize().ok()?;
    let canon_repo = repo_root.canonicalize().ok()?;
    canon_abs
        .strip_prefix(&canon_repo)
        .ok()
        .map(|p| p.to_path_buf())
}

/// Walks `git for-each-ref` to gather every local branch, remote
/// branch, and tag. Pairs each with the current `HEAD` ref so the rail
/// can highlight it. `is_default_branch` is computed from
/// `detect_default_branch` (so we can stripe `main` distinctively even
/// when it's not the checked-out branch).
fn collect_refs(target: &RepoTarget) -> Vec<RefEntry> {
    let head_branch = run_repo_read(target, &["symbolic-ref", "--short", "HEAD"])
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
    let head_sha = head_full_sha_for(target);
    let default_branch = detect_default_branch_for(target);

    let out = run_repo_read(
        target,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    );
    let stdout = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };

    let mut entries = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(2, '\t');
        let refname = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");
        if refname.is_empty() || target.is_empty() {
            continue;
        }
        let (kind, name) = if let Some(rest) = refname.strip_prefix("refs/heads/") {
            (RefKind::Branch, rest.to_string())
        } else if let Some(rest) = refname.strip_prefix("refs/remotes/") {
            // Drop `origin/HEAD` symbolic — it dupes the underlying
            // branch and clutters the rail.
            if rest.ends_with("/HEAD") {
                continue;
            }
            (RefKind::Remote, rest.to_string())
        } else if let Some(rest) = refname.strip_prefix("refs/tags/") {
            (RefKind::Tag, rest.to_string())
        } else {
            continue;
        };
        let is_head = match kind {
            RefKind::Branch => head_branch.as_deref() == Some(name.as_str()),
            _ => false,
        };
        let is_default_branch = matches!(kind, RefKind::Branch) && name == default_branch;
        entries.push(RefEntry {
            name,
            kind,
            target_sha: target.to_string(),
            is_head,
            is_default_branch,
        });
    }

    // Detached HEAD — surface as a synthetic ref so the rail can show
    // a HEAD chip even when no branch is checked out.
    if head_branch.is_none() {
        if let Some(sha) = head_sha {
            entries.push(RefEntry {
                name: "HEAD".to_string(),
                kind: RefKind::Branch,
                target_sha: sha,
                is_head: true,
                is_default_branch: false,
            });
        }
    }

    entries
}

#[tauri::command]
pub fn git_refs(
    args: GitRepoArgs,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<Vec<RefEntry>, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = match ws.plans_root.lock().unwrap().clone() {
        Some(r) => r,
        None => return Ok(Vec::new()),
    };
    let target = match resolve_repo_target(&plans_root, args.repo_handle.as_deref(), &config) {
        Ok(target) => target,
        Err(err) if args.repo_handle.is_none() => {
            eprintln!("git refs repo resolve failed: {err}");
            return Ok(Vec::new());
        }
        Err(err) => return Err(err),
    };
    Ok(collect_refs(&target))
}

#[cfg(test)]
fn git_refs_for_root(plans_root: &Path) -> Result<Vec<RefEntry>, String> {
    let target = match resolve_workspace_repo(plans_root) {
        Ok(target) => target,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(collect_refs(&target))
}

// ─── Per-commit detail ──────────────────────────────────────────────────
//
// Parses `git show --pretty=format:... --no-color --unified=3 <sha>`
// into a structured CommitDetail with per-file hunks. Same shape gets
// returned by `git_status_unstaged` against working-tree-vs-HEAD so
// the frontend can render both with the same component.

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Optional function-context after the `@@ ... @@` markers
    /// (e.g. `fn main()`).
    pub header_text: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub status: FileStatus,
    pub path: String,
    pub old_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<DiffHunk>,
    /// True for `Binary files ... differ` blocks. UI shows a
    /// placeholder instead of attempting to render bytes.
    pub binary: bool,
    /// When set, the diff body was truncated and this many lines were
    /// dropped from the tail. UI surfaces a "Diff truncated — N lines
    /// hidden" footer so the user knows the file is bigger than what
    /// they see. None when the file fits under the hard cap.
    pub truncated_lines: Option<u32>,
    /// True when the file's total diff line count crosses the soft
    /// cap. UI default-collapses these like GitHub does for large
    /// diffs — clicking the header expands them on demand.
    pub large: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: String,
    pub time_secs: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<FileChange>,
    /// True when the parsed body crossed [`MAX_FILES_PER_DIFF`] and
    /// the tail entries were dropped. UI surfaces a banner so the
    /// user knows the file list is incomplete.
    #[serde(default)]
    pub truncated_files: bool,
}

/// Per-file diff caps — match GitHub's "Large diffs are not rendered
/// by default" behavior. Soft cap flips `large = true` so the UI
/// auto-collapses; hard cap actually truncates the parsed lines so
/// huge files (lockfiles, generated bundles) don't blow memory or
/// stall the renderer.
const SOFT_CAP_LINES: usize = 500;
const HARD_CAP_LINES: usize = 5000;
/// Hard ceiling on file count per commit / diff. A merge commit
/// touching 100k files at HARD_CAP_LINES each would otherwise allocate
/// gigabytes of `FileChange` structs before the UI gets a chance to
/// reject. Anything past this limit gets dropped and the response
/// surfaces `truncated_files: true` so the UI can render a banner.
pub const MAX_FILES_PER_DIFF: usize = 2000;

/// Apply soft + hard caps to a single FileChange after `parse_diff_body`
/// has populated its hunks. Mutates in place.
fn apply_diff_caps(file: &mut FileChange) {
    let total: usize = file.hunks.iter().map(|h| h.lines.len()).sum();
    if total > SOFT_CAP_LINES {
        file.large = true;
    }
    if total <= HARD_CAP_LINES {
        return;
    }
    // Walk hunks until we've kept HARD_CAP_LINES total lines, then drop
    // the rest. We keep at least one line in the last retained hunk
    // even if the cap lands mid-hunk so the user sees *something*.
    let mut kept = 0usize;
    let mut new_hunks: Vec<DiffHunk> = Vec::new();
    for hunk in file.hunks.drain(..) {
        if kept >= HARD_CAP_LINES {
            break;
        }
        let remaining = HARD_CAP_LINES - kept;
        if hunk.lines.len() <= remaining {
            kept += hunk.lines.len();
            new_hunks.push(hunk);
        } else {
            let mut truncated = hunk.clone();
            truncated.lines.truncate(remaining);
            kept += remaining;
            new_hunks.push(truncated);
            break;
        }
    }
    file.hunks = new_hunks;
    file.truncated_lines = Some((total - kept) as u32);
}

/// Strip the `a/` or `b/` git prefix that `git diff` adds. Returns
/// the input unchanged if no recognizable prefix.
fn strip_diff_prefix(s: &str) -> String {
    if let Some(stripped) = s.strip_prefix("a/").or_else(|| s.strip_prefix("b/")) {
        stripped.to_string()
    } else {
        s.to_string()
    }
}

fn parse_unified_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, String)> {
    // Format: `@@ -OLD_START[,OLD_LINES] +NEW_START[,NEW_LINES] @@ optional`
    let rest = line.strip_prefix("@@ ")?;
    let close = rest.find(" @@")?;
    let nums = &rest[..close];
    let header_text = rest[close + 3..].trim_start().to_string();
    let mut parts = nums.split_whitespace();
    let old_part = parts.next()?.strip_prefix('-')?;
    let new_part = parts.next()?.strip_prefix('+')?;
    let parse_pair = |s: &str| -> Option<(u32, u32)> {
        if let Some((a, b)) = s.split_once(',') {
            Some((a.parse().ok()?, b.parse().ok()?))
        } else {
            Some((s.parse().ok()?, 1))
        }
    };
    let (old_start, old_lines) = parse_pair(old_part)?;
    let (new_start, new_lines) = parse_pair(new_part)?;
    Some((old_start, old_lines, new_start, new_lines, header_text))
}

/// Parse the body of a `git show` / `git diff` output (everything
/// after the optional `--pretty` metadata block) into per-file
/// FileChanges. Tolerant of missing extended headers. Returns a
/// `truncated_files` flag set when the commit touched more than
/// [`MAX_FILES_PER_DIFF`] files and the tail entries were dropped
/// without further parsing.
fn parse_diff_body(body: &str) -> (Vec<FileChange>, bool) {
    let mut files: Vec<FileChange> = Vec::new();
    let mut current: Option<FileChange> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_cursor: u32 = 0;
    let mut new_cursor: u32 = 0;
    let mut truncated_files = false;

    let push_hunk = |file: &mut FileChange, hunk: &mut Option<DiffHunk>| {
        if let Some(h) = hunk.take() {
            file.hunks.push(h);
        }
    };

    for raw in body.lines() {
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            // Flush the previous file before starting a new one.
            if let Some(mut f) = current.take() {
                push_hunk(&mut f, &mut current_hunk);
                files.push(f);
            }
            // Refuse to parse past the cap: drop the in-progress file,
            // mark truncation, and skip the rest of the body. Subsequent
            // `diff --git` headers won't open a new FileChange because
            // `current` stays None.
            if files.len() >= MAX_FILES_PER_DIFF {
                truncated_files = true;
                current = None;
                current_hunk = None;
                continue;
            }
            // `a/PATH b/PATH` — extract both. Paths may contain
            // spaces if quoted by git, but for v1 we split on the
            // first ` b/` boundary which handles the unquoted majority.
            let (a, b) = match rest.find(" b/") {
                Some(idx) => (&rest[..idx], &rest[idx + 1..]),
                None => (rest, rest),
            };
            let path_a = strip_diff_prefix(a);
            let path_b = strip_diff_prefix(b);
            current = Some(FileChange {
                status: FileStatus::Modified,
                path: path_b,
                old_path: if path_a == strip_diff_prefix(b) {
                    None
                } else {
                    Some(path_a)
                },
                additions: 0,
                deletions: 0,
                hunks: Vec::new(),
                binary: false,
                truncated_lines: None,
                large: false,
            });
            continue;
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        if raw.starts_with("new file mode") {
            file.status = FileStatus::Added;
        } else if raw.starts_with("deleted file mode") {
            file.status = FileStatus::Deleted;
        } else if let Some(rest) = raw.strip_prefix("rename from ") {
            file.status = FileStatus::Renamed;
            file.old_path = Some(rest.to_string());
        } else if let Some(rest) = raw.strip_prefix("rename to ") {
            file.status = FileStatus::Renamed;
            file.path = rest.to_string();
        } else if let Some(rest) = raw.strip_prefix("copy from ") {
            file.status = FileStatus::Copied;
            file.old_path = Some(rest.to_string());
        } else if let Some(rest) = raw.strip_prefix("copy to ") {
            file.status = FileStatus::Copied;
            file.path = rest.to_string();
        } else if raw.starts_with("Binary files ") {
            file.binary = true;
        } else if let Some(rest) = raw.strip_prefix("--- ") {
            // Capture the source-side path. `/dev/null` indicates an
            // added file.
            if rest != "/dev/null" {
                let path = strip_diff_prefix(rest);
                if file.old_path.is_none() && path != file.path {
                    file.old_path = Some(path);
                }
            }
        } else if let Some(rest) = raw.strip_prefix("+++ ") {
            if rest != "/dev/null" {
                let path = strip_diff_prefix(rest);
                if !path.is_empty() {
                    file.path = path;
                }
            }
        } else if raw.starts_with("@@ ") {
            push_hunk(file, &mut current_hunk);
            if let Some((os, ol, ns, nl, header_text)) = parse_unified_hunk_header(raw) {
                old_cursor = os;
                new_cursor = ns;
                current_hunk = Some(DiffHunk {
                    old_start: os,
                    old_lines: ol,
                    new_start: ns,
                    new_lines: nl,
                    header_text,
                    lines: Vec::new(),
                });
            }
        } else if let Some(hunk) = current_hunk.as_mut() {
            // Inside a hunk — context / addition / deletion.
            if let Some(text) = raw.strip_prefix('+') {
                if !raw.starts_with("+++") {
                    hunk.lines.push(DiffLine {
                        kind: DiffLineKind::Addition,
                        old_line: None,
                        new_line: Some(new_cursor),
                        text: text.to_string(),
                    });
                    file.additions += 1;
                    new_cursor += 1;
                }
            } else if let Some(text) = raw.strip_prefix('-') {
                if !raw.starts_with("---") {
                    hunk.lines.push(DiffLine {
                        kind: DiffLineKind::Deletion,
                        old_line: Some(old_cursor),
                        new_line: None,
                        text: text.to_string(),
                    });
                    file.deletions += 1;
                    old_cursor += 1;
                }
            } else if let Some(text) = raw.strip_prefix(' ') {
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Context,
                    old_line: Some(old_cursor),
                    new_line: Some(new_cursor),
                    text: text.to_string(),
                });
                old_cursor += 1;
                new_cursor += 1;
            } else if raw == "\\ No newline at end of file" {
                // Skip — trailing-newline marker.
            }
        }
    }

    if let Some(mut f) = current.take() {
        push_hunk(&mut f, &mut current_hunk);
        files.push(f);
    }
    for f in files.iter_mut() {
        apply_diff_caps(f);
    }
    (files, truncated_files)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowCommitArgs {
    pub sha: String,
    pub repo_handle: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowCommitFileArgs {
    pub sha: String,
    pub path: String,
    pub old_path: Option<String>,
    pub repo_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeHeader {
    pub status: FileStatus,
    pub path: String,
    pub old_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub truncated_lines: Option<u32>,
    pub large: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileHeadersResponse {
    pub sha: String,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: String,
    pub time_secs: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<FileChangeHeader>,
    /// True when the commit touched more than `MAX_FILES_PER_DIFF`
    /// files and the tail was dropped before parsing.
    pub truncated_files: bool,
}

struct CommitMetaParts {
    sha: String,
    short_sha: String,
    author_name: String,
    author_email: String,
    time_secs: i64,
    subject: String,
    body: String,
}

fn read_commit_meta(target: &RepoTarget, sha: &str) -> Result<CommitMetaParts, String> {
    validate_ref(sha).map_err(|e| format!("invalid sha: {e}"))?;
    let pretty = format!("format:%H{s}%h{s}%an{s}%ae{s}%at{s}%s{s}%b", s = FIELD_SEP);
    let pretty_arg = format!("--pretty={pretty}");
    let output = run_repo_read(target, &["show", "-s", &pretty_arg, sha])
        .map_err(|e| format!("git show metadata failed: {e}"))?;
    if !output.status.success() {
        let err = git_runner::redact_credentials(&String::from_utf8_lossy(&output.stderr));
        return Err(format!("git show metadata {}: {}", sha, err.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.splitn(7, FIELD_SEP);
    Ok(CommitMetaParts {
        sha: parts.next().unwrap_or("").to_string(),
        short_sha: parts.next().unwrap_or("").to_string(),
        author_name: parts.next().unwrap_or("").to_string(),
        author_email: parts.next().unwrap_or("").to_string(),
        time_secs: parts.next().and_then(|s| s.parse().ok()).unwrap_or(0),
        subject: parts.next().unwrap_or("").to_string(),
        body: parts.next().unwrap_or("").trim_end().to_string(),
    })
}

fn file_status_from_name_status(code: &str) -> FileStatus {
    match code.chars().next().unwrap_or('M') {
        'A' => FileStatus::Added,
        'D' => FileStatus::Deleted,
        'R' => FileStatus::Renamed,
        'C' => FileStatus::Copied,
        _ => FileStatus::Modified,
    }
}

fn numstat_target_path(raw: &str) -> String {
    if let Some((_, right)) = raw.rsplit_once(" => ") {
        return right.trim_end_matches('}').to_string();
    }
    raw.to_string()
}

fn read_commit_file_headers(
    target: &RepoTarget,
    sha: &str,
) -> Result<(Vec<FileChangeHeader>, bool), String> {
    validate_ref(sha).map_err(|e| format!("invalid sha: {e}"))?;
    let name_status = run_repo_read(
        target,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "-M",
            "-C",
            "--root",
            sha,
        ],
    )
    .map_err(|e| format!("git diff-tree name-status failed: {e}"))?;
    if !name_status.status.success() {
        let err = git_runner::redact_credentials(&String::from_utf8_lossy(&name_status.stderr));
        return Err(format!("git diff-tree name-status {}: {}", sha, err.trim()));
    }

    let numstat = run_repo_read(
        target,
        &[
            "diff-tree",
            "--no-commit-id",
            "--numstat",
            "-r",
            "-M",
            "-C",
            "--root",
            sha,
        ],
    )
    .map_err(|e| format!("git diff-tree numstat failed: {e}"))?;
    if !numstat.status.success() {
        let err = git_runner::redact_credentials(&String::from_utf8_lossy(&numstat.stderr));
        return Err(format!("git diff-tree numstat {}: {}", sha, err.trim()));
    }

    let mut counts: HashMap<String, (u32, u32, bool)> = HashMap::new();
    for line in String::from_utf8_lossy(&numstat.stdout).lines() {
        let mut parts = line.splitn(3, '\t');
        let additions_raw = parts.next().unwrap_or("");
        let deletions_raw = parts.next().unwrap_or("");
        let path_raw = parts.next().unwrap_or("");
        if path_raw.is_empty() {
            continue;
        }
        let binary = additions_raw == "-" || deletions_raw == "-";
        let additions = additions_raw.parse().unwrap_or(0);
        let deletions = deletions_raw.parse().unwrap_or(0);
        counts.insert(
            numstat_target_path(path_raw),
            (additions, deletions, binary),
        );
    }

    let mut headers = Vec::new();
    let mut truncated_files = false;
    for line in String::from_utf8_lossy(&name_status.stdout).lines() {
        let mut parts = line.split('\t');
        let code = parts.next().unwrap_or("");
        if code.is_empty() {
            continue;
        }
        let status = file_status_from_name_status(code);
        let (old_path, path) = if matches!(status, FileStatus::Renamed | FileStatus::Copied) {
            let old = parts.next().unwrap_or("").to_string();
            let new = parts.next().unwrap_or("").to_string();
            (Some(old), new)
        } else {
            (None, parts.next().unwrap_or("").to_string())
        };
        if path.is_empty() {
            continue;
        }
        if headers.len() >= MAX_FILES_PER_DIFF {
            truncated_files = true;
            break;
        }
        let (additions, deletions, binary) = counts.get(&path).copied().unwrap_or((0, 0, false));
        headers.push(FileChangeHeader {
            status,
            path,
            old_path,
            additions,
            deletions,
            binary,
            truncated_lines: None,
            large: (additions + deletions) as usize > SOFT_CAP_LINES,
        });
    }
    Ok((headers, truncated_files))
}

#[tauri::command]
pub fn git_show_commit_files(
    args: GitShowCommitArgs,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<CommitFileHeadersResponse, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no plansRoot configured".to_string())?;
    let target = resolve_repo_target(&plans_root, args.repo_handle.as_deref(), &config)?;
    git_show_commit_files_for_target(&target, &args.sha)
}

#[cfg(test)]
fn git_show_commit_files_for_root(
    plans_root: &Path,
    sha: &str,
) -> Result<CommitFileHeadersResponse, String> {
    let target = resolve_workspace_repo(plans_root)?;
    git_show_commit_files_for_target(&target, sha)
}

fn git_show_commit_files_for_target(
    target: &RepoTarget,
    sha: &str,
) -> Result<CommitFileHeadersResponse, String> {
    let meta = read_commit_meta(target, sha)?;
    let (files, truncated_files) = read_commit_file_headers(target, sha)?;
    Ok(CommitFileHeadersResponse {
        sha: meta.sha,
        short_sha: meta.short_sha,
        author_name: meta.author_name,
        author_email: meta.author_email,
        time_secs: meta.time_secs,
        subject: meta.subject,
        body: meta.body,
        files,
        truncated_files,
    })
}

#[tauri::command]
pub fn git_show_commit_file(
    args: GitShowCommitFileArgs,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
) -> Result<FileChange, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no plansRoot configured".to_string())?;
    let target = resolve_repo_target(&plans_root, args.repo_handle.as_deref(), &config)?;
    git_show_commit_file_for_target(&target, &args)
}

#[cfg(test)]
fn git_show_commit_file_for_root(
    plans_root: &Path,
    args: &GitShowCommitFileArgs,
) -> Result<FileChange, String> {
    let target = resolve_workspace_repo(plans_root)?;
    git_show_commit_file_for_target(&target, args)
}

fn git_show_commit_file_for_target(
    target: &RepoTarget,
    args: &GitShowCommitFileArgs,
) -> Result<FileChange, String> {
    validate_ref(&args.sha).map_err(|e| format!("invalid sha: {e}"))?;
    git_runner::validate_path_arg(&args.path).map_err(|e| format!("invalid path: {e}"))?;
    if let Some(old) = args.old_path.as_deref() {
        git_runner::validate_path_arg(old).map_err(|e| format!("invalid old path: {e}"))?;
    }
    let mut cmd_args: Vec<&str> = vec![
        "show",
        "--no-color",
        "--unified=3",
        "--format=",
        "-M",
        "-C",
        &args.sha,
        "--",
    ];
    if let Some(old_path) = args.old_path.as_deref() {
        if old_path != args.path {
            cmd_args.push(old_path);
        }
    }
    cmd_args.push(args.path.as_str());
    let output =
        run_repo_read(target, &cmd_args).map_err(|e| format!("git show file failed: {e}"))?;
    if !output.status.success() {
        let err = git_runner::redact_credentials(&String::from_utf8_lossy(&output.stderr));
        return Err(format!(
            "git show {} -- {}: {}",
            args.sha,
            args.path,
            err.trim()
        ));
    }
    let body = String::from_utf8_lossy(&output.stdout);
    let (files, _truncated) = parse_diff_body(body.trim_start());
    let wanted_old_path = args.old_path.as_deref();
    files
        .iter()
        .find(|f| {
            f.path == args.path
                && (wanted_old_path.is_none()
                    || f.old_path.as_deref() == wanted_old_path
                    || f.old_path.is_none())
        })
        .or_else(|| files.iter().find(|f| f.path == args.path))
        .cloned()
        .ok_or_else(|| format!("no diff body found for {}", args.path))
}

#[tauri::command]
pub fn git_show_commit(
    args: GitShowCommitArgs,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
    cache: State<'_, CommitDetailCache>,
) -> Result<CommitDetail, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no plansRoot configured".to_string())?;
    let target = resolve_repo_target(&plans_root, args.repo_handle.as_deref(), &config)?;
    git_show_commit_for_target(&target, &args.sha, &cache)
}

#[cfg(test)]
fn git_show_commit_for_root(
    plans_root: &Path,
    sha: &str,
    cache: &CommitDetailCache,
) -> Result<CommitDetail, String> {
    let target = resolve_workspace_repo(plans_root)?;
    git_show_commit_for_target(&target, sha, cache)
}

fn git_show_commit_for_target(
    target: &RepoTarget,
    sha: &str,
    cache: &CommitDetailCache,
) -> Result<CommitDetail, String> {
    let cache_key = (target.root.clone(), sha.to_string());
    if let Some(cached) = cache.get(&cache_key) {
        return Ok(cached);
    }

    validate_ref(sha).map_err(|e| format!("invalid sha: {e}"))?;
    let metadata_sep = "\x1eEND_META\x1e";
    let pretty = format!(
        "format:%H{s}%h{s}%an{s}%ae{s}%at{s}%s{s}%b{sep}",
        s = FIELD_SEP,
        sep = metadata_sep,
    );
    let pretty_arg = format!("--pretty={pretty}");
    let output = run_repo_read(
        target,
        &["show", "--no-color", "--unified=3", &pretty_arg, sha],
    )
    .map_err(|e| format!("git show failed: {e}"))?;
    if !output.status.success() {
        let err = git_runner::redact_credentials(&String::from_utf8_lossy(&output.stderr));
        return Err(format!("git show {}: {}", sha, err.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let (meta_text, body) = stdout
        .split_once(metadata_sep)
        .ok_or_else(|| "unexpected git show output".to_string())?;

    let mut parts = meta_text.splitn(7, FIELD_SEP);
    let sha = parts.next().unwrap_or("").to_string();
    let short_sha = parts.next().unwrap_or("").to_string();
    let author_name = parts.next().unwrap_or("").to_string();
    let author_email = parts.next().unwrap_or("").to_string();
    let time_secs: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let subject = parts.next().unwrap_or("").to_string();
    let body_msg = parts.next().unwrap_or("").trim_end().to_string();

    let (files, truncated_files) = parse_diff_body(body.trim_start());

    let detail = CommitDetail {
        sha,
        short_sha,
        author_name,
        author_email,
        time_secs,
        subject,
        body: body_msg,
        files,
        truncated_files,
    };
    cache.put(cache_key, detail.clone());
    Ok(detail)
}

#[tauri::command]
pub fn git_status_unstaged(
    args: GitRepoArgs,
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
    cache: State<'_, UnstagedDetailCache>,
) -> Result<CommitDetail, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no plansRoot configured".to_string())?;
    let target = resolve_repo_target(&plans_root, args.repo_handle.as_deref(), &config)?;
    git_status_unstaged_for_target(&target, &cache)
}

#[cfg(test)]
fn git_status_unstaged_for_root(
    plans_root: &Path,
    cache: &UnstagedDetailCache,
) -> Result<CommitDetail, String> {
    let target = resolve_workspace_repo(plans_root)?;
    git_status_unstaged_for_target(&target, cache)
}

fn git_status_unstaged_for_target(
    target: &RepoTarget,
    cache: &UnstagedDetailCache,
) -> Result<CommitDetail, String> {
    let fingerprint = unstaged_fingerprint(target);
    if let Some(cached) = fingerprint
        .as_ref()
        .and_then(|fp| cache.get(&target.root, fp))
    {
        return Ok(cached);
    }

    // Working tree vs HEAD — covers both staged + unstaged together.
    // In a freshly initialized repo there is no HEAD yet, so diff
    // against Git's empty tree instead of surfacing "unknown revision".
    // v1 collapses everything into one Unstaged row; v1.1 may split it.
    let base = head_full_sha_for(target).unwrap_or_else(|| EMPTY_TREE_SHA.to_string());
    let output = run_repo_read(target, &["diff", &base, "--no-color", "--unified=3"])
        .map_err(|e| format!("git diff failed: {e}"))?;
    if !output.status.success() {
        let err = git_runner::redact_credentials(&String::from_utf8_lossy(&output.stderr));
        return Err(format!("git diff {base}: {}", err.trim()));
    }
    let body = String::from_utf8_lossy(&output.stdout).to_string();
    let (mut files, mut truncated_files) = parse_diff_body(&body);

    // Include untracked files as synthetic "added" entries so the
    // commit panel can stage them. `git diff HEAD` doesn't surface
    // untracked paths; we ask `ls-files` separately, then run
    // `git diff --no-index /dev/null <path>` for each so the body
    // shows the real file contents instead of "No textual changes".
    let untracked = run_repo_read(target, &["ls-files", "--others", "--exclude-standard"]);
    if let Ok(o) = untracked {
        if o.status.success() {
            let stdout = String::from_utf8_lossy(&o.stdout);
            for line in stdout.lines() {
                let path = line.trim();
                if path.is_empty() {
                    continue;
                }
                if files.iter().any(|f| f.path == path) {
                    continue;
                }
                let untracked_diff = run_repo_read(
                    target,
                    &[
                        "diff",
                        "--no-index",
                        "--no-color",
                        "--unified=3",
                        "/dev/null",
                        path,
                    ],
                );
                // `git diff --no-index` returns exit 1 when files
                // differ — that's the expected case. Treat both 0
                // and 1 as "diff produced", anything else as failure.
                let body = match untracked_diff {
                    Ok(out) if out.status.code() == Some(0) || out.status.code() == Some(1) => {
                        String::from_utf8_lossy(&out.stdout).to_string()
                    }
                    _ => String::new(),
                };
                if files.len() >= MAX_FILES_PER_DIFF {
                    truncated_files = true;
                    break;
                }
                let (parsed, parsed_truncated) = parse_diff_body(&body);
                truncated_files = truncated_files || parsed_truncated;
                if let Some(mut fc) = parsed.into_iter().next() {
                    // `--no-index` paths are absolute-ish; force the
                    // repo-relative path we already know.
                    fc.path = path.to_string();
                    fc.old_path = None;
                    fc.status = FileStatus::Added;
                    files.push(fc);
                } else {
                    // Empty file or unreadable — still surface the row
                    // so the user can stage / commit it.
                    files.push(FileChange {
                        status: FileStatus::Added,
                        path: path.to_string(),
                        old_path: None,
                        additions: 0,
                        deletions: 0,
                        hunks: Vec::new(),
                        binary: false,
                        truncated_lines: None,
                        large: false,
                    });
                }
            }
        }
    }

    let detail = CommitDetail {
        sha: "unstaged".to_string(),
        short_sha: "wip".to_string(),
        author_name: String::new(),
        author_email: String::new(),
        time_secs: 0,
        subject: "Uncommitted changes".to_string(),
        body: String::new(),
        files,
        truncated_files,
    };
    if let Some(fp) = fingerprint {
        cache.put(target.root.clone(), fp, detail.clone());
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
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
    fn diff_plan_and_list_changed_plans_report_modified_markdown() {
        let repo = init_repo();
        let plans = repo.path().join("plans");
        commit_file(repo.path(), "plans/alpha.md", "# Alpha\nold\n", "initial");
        fs::write(plans.join("alpha.md"), "# Alpha\nnew\nadded\n").unwrap();

        let changes = diff_plan_for_root(&plans, "alpha.md", &DiffCache::new()).unwrap();
        assert!(!changes.hunks.is_empty());
        assert!(
            !changes.added.is_empty()
                || !changes.modified.is_empty()
                || !changes.deleted_after.is_empty()
        );

        let changed = list_changed_plans_for_root(&plans).unwrap();
        let alpha = changed.iter().find(|p| p.rel == "alpha.md").unwrap();
        assert_eq!(alpha.added_count, 2);
        assert_eq!(alpha.removed_count, 1);
    }

    #[test]
    fn blame_plan_and_commit_meta_use_real_repo() {
        let repo = init_repo();
        let plans = repo.path().join("plans");
        let sha = commit_file(
            repo.path(),
            "plans/alpha.md",
            "# Alpha\nline two\n",
            "initial alpha",
        );
        run(
            repo.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/spec-rider/plans.git",
            ],
        );

        let blame = blame_plan_for_root(&plans, "alpha.md", &BlameCache::new()).unwrap();
        assert_eq!(blame.lines.len(), 2);
        assert_eq!(blame.commits.len(), 1);
        assert!(blame.commits.contains_key(&sha[..8]));

        let meta = commit_meta_for_root(&plans, &sha, &CommitMetaCache::new()).unwrap();
        assert_eq!(meta.sha, sha[..8]);
        assert_eq!(meta.subject, "initial alpha");
        assert_eq!(meta.author, "Spec Rider");
        assert!(meta.files.iter().any(|path| path == "plans/alpha.md"));
        assert_eq!(
            meta.github_url,
            Some(format!("https://github.com/spec-rider/plans/commit/{sha}"))
        );
    }

    #[test]
    fn graph_refs_and_explicit_relevance_cover_plan_history() {
        let repo = init_repo();
        let plans = repo.path().join("plans");
        commit_file(repo.path(), "plans/alpha.md", "# Alpha\nbase\n", "initial");
        run(repo.path(), &["checkout", "-b", "feature/spec"]);
        let feature_sha = commit_file(
            repo.path(),
            "plans/alpha.md",
            "# Alpha\nfeature\n",
            "feature alpha",
        );
        run(repo.path(), &["checkout", "main"]);

        let refs = git_refs_for_root(&plans).unwrap();
        assert!(refs
            .iter()
            .any(|r| r.name == "main" && r.is_head && matches!(r.kind, RefKind::Branch)));
        assert!(refs
            .iter()
            .any(|r| r.name == "feature/spec" && matches!(r.kind, RefKind::Branch)));

        let graph = git_log_graph_for_root(
            &plans,
            GitLogGraphArgs {
                plan_rel: Some("alpha.md".to_string()),
                branches: vec!["feature/spec".to_string()],
                commit_shas: vec![feature_sha[..8].to_string()],
                repo_handle: None,
                review_branch: None,
                review_base: None,
                limit: Some(20),
                before_sha: None,
            },
            &CommitGraphCache::new(),
        )
        .unwrap();

        assert!(graph.commits.iter().any(|c| c.sha == feature_sha));
        let relevance = graph
            .plan_relevance
            .iter()
            .find(|r| r.sha == feature_sha)
            .unwrap();
        assert!(matches!(relevance.source, CommitSource::Explicit));
        assert_eq!(relevance.branch, None);
    }

    #[test]
    fn commit_headers_lazy_file_body_and_unstaged_detail_use_real_git() {
        let repo = init_repo();
        let plans = repo.path().join("plans");
        commit_file(repo.path(), "plans/alpha.md", "# Alpha\nold\n", "initial");
        let sha = commit_file(
            repo.path(),
            "plans/alpha.md",
            "# Alpha\nnew\nextra\n",
            "update alpha",
        );

        let headers = git_show_commit_files_for_root(&plans, &sha).unwrap();
        assert_eq!(headers.sha, sha);
        assert_eq!(headers.subject, "update alpha");
        assert!(headers
            .files
            .iter()
            .any(|f| f.path == "plans/alpha.md" && matches!(f.status, FileStatus::Modified)));

        let file = git_show_commit_file_for_root(
            &plans,
            &GitShowCommitFileArgs {
                sha: sha.clone(),
                path: "plans/alpha.md".to_string(),
                old_path: None,
                repo_handle: None,
            },
        )
        .unwrap();
        assert_eq!(file.path, "plans/alpha.md");
        assert!(!file.hunks.is_empty());

        let detail = git_show_commit_for_root(&plans, &sha, &CommitDetailCache::new()).unwrap();
        assert_eq!(detail.sha, sha);
        assert!(detail.files.iter().any(|f| f.path == "plans/alpha.md"));

        fs::write(plans.join("alpha.md"), "# Alpha\nworking tree\n").unwrap();
        fs::write(plans.join("new.md"), "# New\n").unwrap();
        let unstaged = git_status_unstaged_for_root(&plans, &UnstagedDetailCache::new()).unwrap();
        assert!(unstaged
            .files
            .iter()
            .any(|f| f.path == "plans/alpha.md" && matches!(f.status, FileStatus::Modified)));
        assert!(unstaged
            .files
            .iter()
            .any(|f| f.path == "plans/new.md" && matches!(f.status, FileStatus::Added)));
    }

    #[test]
    fn unstaged_detail_handles_initialized_repo_without_initial_commit() {
        let repo = init_repo();
        let plans = repo.path().join("plans");
        fs::write(plans.join("first.md"), "# First\n").unwrap();

        assert!(git_has_uncommitted_for_root(&plans));
        let unstaged = git_status_unstaged_for_root(&plans, &UnstagedDetailCache::new()).unwrap();

        assert_eq!(unstaged.sha, "unstaged");
        assert!(unstaged
            .files
            .iter()
            .any(|f| f.path == "plans/first.md" && matches!(f.status, FileStatus::Added)));
    }

    #[test]
    fn parses_pure_addition() {
        let diff =
            "diff --git a/x b/x\nindex 0..1\n--- a/x\n+++ b/x\n@@ -5,0 +6,3 @@\n+a\n+b\n+c\n";
        let cs = build_changeset(parse_hunks(diff));
        assert_eq!(cs.added, vec![6, 7, 8]);
        assert!(cs.modified.is_empty());
        assert!(cs.deleted_after.is_empty());
    }

    #[test]
    fn parses_pure_deletion() {
        let diff = "@@ -5,3 +4,0 @@\n-a\n-b\n-c\n";
        let cs = build_changeset(parse_hunks(diff));
        assert!(cs.added.is_empty());
        assert!(cs.modified.is_empty());
        assert_eq!(cs.deleted_after, vec![4]);
    }

    #[test]
    fn parses_modification() {
        let diff = "@@ -5,2 +5,3 @@\n-old1\n-old2\n+new1\n+new2\n+new3\n";
        let cs = build_changeset(parse_hunks(diff));
        assert!(cs.added.is_empty());
        assert_eq!(cs.modified, vec![5, 6, 7]);
    }

    #[test]
    fn parses_blame_porcelain() {
        // First line: a committed line with full metadata.
        // Second line: another line from the same commit (no metadata
        // repeated; should pick up from the cache).
        // Third line: working-tree (uncommitted), all-zero SHA.
        let blame = "abcdef1234567890abcdef1234567890abcdef12 1 1 2\n\
author Jane Doe\n\
author-time 1700000000\n\
summary Add hello\n\
filename foo.md\n\
\thello\n\
abcdef1234567890abcdef1234567890abcdef12 2 2\n\
\tworld\n\
0000000000000000000000000000000000000000 3 3 1\n\
author Not Committed Yet\n\
author-time 1710000000\n\
summary Version of foo.md from foo.md\n\
filename foo.md\n\
\twip\n";
        let bs = parse_blame(blame);
        assert_eq!(bs.lines.len(), 3);
        assert_eq!(bs.lines[0].sha, "abcdef12");
        assert_eq!(bs.lines[0].author, "Jane Doe");
        assert_eq!(bs.lines[0].summary, "Add hello");
        assert!(!bs.lines[0].uncommitted);
        // Second line shares the commit; metadata is picked up from cache.
        assert_eq!(bs.lines[1].sha, "abcdef12");
        assert_eq!(bs.lines[1].author, "Jane Doe");
        // Third line is uncommitted.
        assert!(bs.lines[2].uncommitted);
        assert_eq!(bs.lines[2].sha, "");
        // commits map has one entry (the committed one).
        assert_eq!(bs.commits.len(), 1);
        assert!(bs.commits.contains_key("abcdef12"));
    }

    #[test]
    fn run_git_log_shas_rejects_flaglike_revs() {
        // No git repo set up — the function should bail out before
        // ever shelling out because the ref validator catches the
        // `--upload-pack=…` first. Returns an empty list, NOT an
        // error message we'd surface to the user (mirrors the way
        // "branch doesn't exist" is handled today).
        let tmp = tempfile::TempDir::new().unwrap();
        let revs = vec!["--upload-pack=evil".to_string()];
        let target = RepoTarget {
            root: tmp.path().to_path_buf(),
            access: GitReadAccess::Workspace,
        };
        let out = run_git_log_shas(&target, &revs, 10);
        assert!(out.is_empty());
    }

    #[test]
    fn run_git_log_shas_accepts_caret_prefixed_refs() {
        // `^main` is a meaningful rev-walk prefix (exclude commits
        // reachable from main); validate_ref should still allow it
        // when stripped. We don't actually reach git here so just
        // confirm the validator doesn't reject the input.
        use crate::git_runner::validate_ref;
        assert!(validate_ref("main").is_ok());
        // Strip-and-validate path: caller does the strip, validator
        // checks the bare ref. The function itself returns empty
        // outside a real repo so this test only proves the validator
        // accepts the bare form.
        assert!(validate_ref("^main".strip_prefix('^').unwrap()).is_ok());
    }

    #[test]
    fn parse_diff_body_caps_files_at_max() {
        let mut body = String::new();
        for i in 0..(MAX_FILES_PER_DIFF + 5) {
            body.push_str(&format!(
                "diff --git a/f{i}.md b/f{i}.md\nindex 0..1\n--- a/f{i}.md\n+++ b/f{i}.md\n@@ -1 +1 @@\n-old\n+new\n",
            ));
        }
        let (files, truncated) = parse_diff_body(&body);
        assert!(truncated, "should flag truncation past the cap");
        assert_eq!(files.len(), MAX_FILES_PER_DIFF);
    }
}
