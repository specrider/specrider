// PTY process layer for the embedded agent terminal.
//
// Each `Session` owns one PTY pair, the spawned shell/agent child, a
// background reader thread that base64-encodes PTY chunks and emits
// `terminal-output` to the owning webview window, and a 256 KB ring
// buffer that backs the reattach replay path. `TerminalManager` is
// what gets registered in Tauri state.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Runtime, State, Window};

use crate::collab::workspace_config::linked_repos_from_root;
use crate::config::ConfigState;
use crate::state::WindowsState;
use crate::workspace_trust::{trust_for, TrustDecision};

const DEFAULT_RING_BYTES: usize = 256 * 1024;
const READ_CHUNK: usize = 16 * 1024;
/// Hard cap on a single `terminal_write` payload, applied to the
/// *base64* string length before decode. 1 MiB decoded is plenty for
/// even very large pastes; we check pre-decode to refuse multi-GB
/// payloads without ever allocating the decoded buffer.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_WRITE_BYTES_B64: usize = MAX_WRITE_BYTES * 4 / 3 + 4;
const _: () = {
    assert!(MAX_WRITE_BYTES_B64 > MAX_WRITE_BYTES);
    assert!(MAX_WRITE_BYTES_B64 >= MAX_WRITE_BYTES * 4 / 3);
};
/// How long [`TerminalManager::kill`] will block waiting for the
/// reader thread to drain after sending SIGTERM. On timeout we drop
/// the join and let the thread eventually reap when the master PTY
/// closes.
const KILL_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Pattern for env vars an opt-in scrubber drops before spawning a
/// PTY. Plain string matching (case-insensitive substring) instead of
/// a regex to avoid pulling in a regex dep — the false-positive rate
/// is acceptable since this is an *opt-in* defense.
const SCRUB_KEY_FRAGMENTS: &[&str] = &["api_key", "apikey", "token", "secret", "password"];

fn env_key_should_scrub(key: &std::ffi::OsStr) -> bool {
    let lower = key.to_string_lossy().to_lowercase();
    SCRUB_KEY_FRAGMENTS.iter().any(|frag| lower.contains(frag))
}

#[cfg(windows)]
fn pick_windows_shell() -> String {
    // Prefer modern PowerShell 7+ (`pwsh`), fall back to Windows
    // PowerShell 5.1 (`powershell`, ships with every Windows install),
    // then `cmd.exe` as a final guarantee. We resolve to an absolute
    // path so the spawn is pinned to the binary we just verified.
    for name in ["pwsh.exe", "powershell.exe"] {
        if let Some(path) = which_on_path(name) {
            return path;
        }
    }
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[cfg(windows)]
fn which_on_path(name: &str) -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    Shell,
}

pub type SessionId = String;

#[derive(Clone, Debug, Serialize)]
pub struct SessionMeta {
    pub id: SessionId,
    pub window_label: String,
    pub cwd: PathBuf,
    pub agent_kind: AgentKind,
    pub cols: u16,
    pub rows: u16,
    pub plan_path: Option<PathBuf>,
    pub task_id: Option<String>,
    pub worktree: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
struct TerminalOutputEvent {
    session_id: SessionId,
    chunk_b64: String,
}

#[derive(Clone, Debug, Serialize)]
struct TerminalExitedEvent {
    session_id: SessionId,
    exit_code: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
struct TerminalErrorEvent {
    session_id: SessionId,
    message: String,
}

trait TerminalEmitter: Clone + Send + 'static {
    fn emit_started(&self, window_label: &str, meta: &SessionMeta);
    fn emit_output(&self, window_label: &str, payload: &TerminalOutputEvent);
    fn emit_exited(&self, window_label: &str, payload: &TerminalExitedEvent);
    fn emit_error(&self, window_label: &str, payload: &TerminalErrorEvent);
    fn emit_sessions_changed(&self);
}

impl<R: Runtime> TerminalEmitter for AppHandle<R> {
    fn emit_started(&self, window_label: &str, meta: &SessionMeta) {
        let _ = self.emit_to(
            EventTarget::webview_window(window_label),
            "terminal-started",
            meta,
        );
    }

    fn emit_output(&self, window_label: &str, payload: &TerminalOutputEvent) {
        let _ = self.emit_to(
            EventTarget::webview_window(window_label),
            "terminal-output",
            payload,
        );
    }

    fn emit_exited(&self, window_label: &str, payload: &TerminalExitedEvent) {
        let _ = self.emit_to(
            EventTarget::webview_window(window_label),
            "terminal-exited",
            payload,
        );
    }

    fn emit_error(&self, window_label: &str, payload: &TerminalErrorEvent) {
        let _ = self.emit_to(
            EventTarget::webview_window(window_label),
            "terminal-error",
            payload,
        );
    }

    fn emit_sessions_changed(&self) {
        let _ = self.emit_to(EventTarget::any(), "terminal-sessions-changed", ());
    }
}

/// Append-only buffer that drops bytes from the front once it goes
/// over `cap`. Snapshots the current contents for `terminal_replay`.
struct RingBuffer {
    data: Vec<u8>,
    cap: usize,
}

impl RingBuffer {
    fn new(cap: usize) -> Self {
        Self {
            data: Vec::with_capacity(cap.min(64 * 1024)),
            cap,
        }
    }
    fn push(&mut self, bytes: &[u8]) {
        self.data.extend_from_slice(bytes);
        if self.data.len() > self.cap {
            let drop = self.data.len() - self.cap;
            self.data.drain(..drop);
        }
    }
    fn snapshot(&self) -> Vec<u8> {
        self.data.clone()
    }
}

struct Session {
    meta: SessionMeta,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Wrapped in a Mutex so we can `wait()` from the reader thread
    /// without blocking other access. Currently we don't poll the
    /// child from anywhere else; reserved for future health checks.
    _child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    ring: Arc<Mutex<RingBuffer>>,
    reader_thread: Option<JoinHandle<()>>,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<SessionId, Session>>,
    next_id: AtomicU64,
}

struct TerminalStartRequest {
    window_label: String,
    cwd: PathBuf,
    agent_kind: AgentKind,
    cols: u16,
    rows: u16,
    scrub_secrets: bool,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Spawn a new PTY-backed session. The executable is resolved
    /// inside Rust against a hardcoded basename allowlist driven by
    /// `agent_kind` — the frontend never gets to name the binary
    /// directly. `cwd` must already have been validated to live
    /// inside the calling window's plans root.
    fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: TerminalStartRequest,
    ) -> Result<SessionMeta, String> {
        self.start_with_emitter(app.clone(), request)
    }

    fn start_with_emitter<E: TerminalEmitter>(
        &self,
        emitter: E,
        request: TerminalStartRequest,
    ) -> Result<SessionMeta, String> {
        let TerminalStartRequest {
            window_label,
            cwd,
            agent_kind,
            cols,
            rows,
            scrub_secrets,
        } = request;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        // Closed allowlist: agent_kind names the *only* binaries the
        // frontend can ask us to spawn. Each one is a bare basename
        // (no path) so `$PATH` resolution honors the user's environment
        // (`pnpm`-installed Claude in `~/.local/bin`, etc.).
        let mut cmd = match agent_kind {
            AgentKind::Claude => CommandBuilder::new("claude"),
            AgentKind::Codex => CommandBuilder::new("codex"),
            AgentKind::Shell => {
                #[cfg(windows)]
                let shell = pick_windows_shell();
                #[cfg(not(windows))]
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
                // Refuse anything that isn't a plain absolute path or
                // a bare basename. Defends against `SHELL=/path with;
                // injection` exotica that some shells expand.
                if shell.contains(['\0', '\n', ';', '|', '&', '`', '$']) {
                    return Err("refusing to launch unsafe shell".into());
                }
                let mut builder = CommandBuilder::new(shell);
                // Spawn as a login shell so the user's profile
                // (.zprofile / .bash_profile, etc.) runs. When SpecRider
                // is launched from Finder/launchd rather than a terminal
                // it inherits the bare launchd PATH; login-shell startup
                // is what restores the PATH the user expects (Homebrew,
                // pyenv, asdf, …). PowerShell loads its own profile, so
                // this is POSIX-only.
                #[cfg(not(windows))]
                builder.arg("-l");
                builder
            }
        };
        cmd.cwd(&cwd);
        // Pass through the parent environment so $PATH / login shells
        // find `claude`, `codex`, etc. as the user expects. When the
        // opt-in `scrub_secrets` flag is on, drop env vars whose key
        // matches a credential heuristic so the agent terminal can be
        // demoed / shared without leaking the user's keys.
        for (k, v) in std::env::vars_os() {
            if scrub_secrets && env_key_should_scrub(&k) {
                continue;
            }
            cmd.env(k, v);
        }
        // Finder/launchd can start the app with LANG/LC_* unset or set
        // to empty strings. In that environment shells and line editors
        // can fall back to the C locale and miscompute cursor columns for
        // multibyte prompt glyphs. Only fill this in when the user has no
        // usable locale at all, and let explicit LC_ALL/LC_CTYPE/LANG win.
        let missing_locale = ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .all(|key| std::env::var_os(key).map_or(true, |value| value.is_empty()));
        if missing_locale {
            #[cfg(target_os = "macos")]
            cmd.env("LC_CTYPE", "UTF-8");
            #[cfg(all(unix, not(target_os = "macos")))]
            cmd.env("LANG", "C.UTF-8");
        }
        // The embedded terminal is xterm.js, which is xterm-256color
        // compatible, so advertise that to the shell. We set it
        // unconditionally: a Finder/launchd launch inherits no TERM at all
        // (with TERM unset zsh has no terminfo — it emits a stray `?`
        // before multibyte prompt glyphs and miscomputes cursor columns,
        // garbling the line editor), and a launch that inherits TERM from
        // some other terminal (e.g. `xterm-ghostty`) would describe the
        // wrong terminal. portable_pty does not set this for us.
        cmd.env("TERM", "xterm-256color");

        let child: Box<dyn Child + Send + Sync> = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn_command failed: {e}"))?;
        // After spawning, drop the slave handle so the master sees EOF
        // when the child exits.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("try_clone_reader failed: {e}"))?;
        let killer = child.clone_killer();

        let id: SessionId = format!("term-{:04}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let meta = SessionMeta {
            id: id.clone(),
            window_label: window_label.clone(),
            cwd: cwd.clone(),
            agent_kind,
            cols,
            rows,
            plan_path: None,
            task_id: None,
            worktree: None,
        };

        let ring = Arc::new(Mutex::new(RingBuffer::new(DEFAULT_RING_BYTES)));
        let child_arc: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));

        let emitter_for_reader = emitter.clone();
        let id_for_reader = id.clone();
        let window_for_reader = window_label.clone();
        let ring_for_reader = ring.clone();
        let child_for_reader = child_arc.clone();

        let reader_thread = std::thread::Builder::new()
            .name(format!("term-reader-{id}"))
            .spawn(move || {
                run_reader_loop(
                    reader,
                    emitter_for_reader,
                    window_for_reader,
                    id_for_reader,
                    ring_for_reader,
                    child_for_reader,
                );
            })
            .map_err(|e| format!("spawn reader thread: {e}"))?;

        let session = Session {
            meta: meta.clone(),
            master: pair.master,
            writer,
            killer,
            _child: child_arc,
            ring,
            reader_thread: Some(reader_thread),
        };

        self.sessions.lock().unwrap().insert(id.clone(), session);

        emitter.emit_started(&window_label, &meta);
        emitter.emit_sessions_changed();

        Ok(meta)
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(format!("write payload exceeds {MAX_WRITE_BYTES}-byte cap"));
        }
        let mut map = self.sessions.lock().unwrap();
        let session = map
            .get_mut(id)
            .ok_or_else(|| format!("session {id} not found"))?;
        session
            .writer
            .write_all(bytes)
            .map_err(|e| format!("pty write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("pty flush failed: {e}"))?;
        Ok(())
    }

    pub fn set_cwd(&self, id: &str, cwd: PathBuf) -> Result<(), String> {
        let command = shell_cd_command(&cwd);
        if command.len() > MAX_WRITE_BYTES {
            return Err(format!("write payload exceeds {MAX_WRITE_BYTES}-byte cap"));
        }
        let mut map = self.sessions.lock().unwrap();
        let session = map
            .get_mut(id)
            .ok_or_else(|| format!("session {id} not found"))?;
        session
            .writer
            .write_all(&command)
            .map_err(|e| format!("pty write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("pty flush failed: {e}"))?;
        session.meta.cwd = cwd;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let session = map
            .get_mut(id)
            .ok_or_else(|| format!("session {id} not found"))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize failed: {e}"))?;
        session.meta.cols = cols;
        session.meta.rows = rows;
        Ok(())
    }

    /// Kill the child and join the reader thread. Idempotent.
    /// Bounds the join at [`KILL_JOIN_TIMEOUT`] — a wedged child
    /// shouldn't block the UI thread; on timeout we drop the join and
    /// leave the OS to reap when the master PTY closes.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut session = match self.sessions.lock().unwrap().remove(id) {
            Some(s) => s,
            None => return Ok(()),
        };
        let _ = session.killer.kill();
        if let Some(handle) = session.reader_thread.take() {
            let (done_tx, done_rx) = mpsc::channel::<()>();
            std::thread::Builder::new()
                .name(format!("term-killer-{id}", id = id))
                .spawn(move || {
                    let _ = handle.join();
                    let _ = done_tx.send(());
                })
                .ok();
            if done_rx.recv_timeout(KILL_JOIN_TIMEOUT).is_err() {
                eprintln!(
                    "terminal session {id} reader-thread join timed out after {:?}; abandoning",
                    KILL_JOIN_TIMEOUT
                );
            }
        }
        // Dropping `session` releases master, writer, child here.
        Ok(())
    }

    pub fn replay(&self, id: &str) -> Result<Vec<u8>, String> {
        let ring = {
            let map = self.sessions.lock().unwrap();
            let session = map
                .get(id)
                .ok_or_else(|| format!("session {id} not found"))?;
            session.ring.clone()
        };
        let snapshot = ring.lock().unwrap().snapshot();
        Ok(snapshot)
    }

    pub fn list_for_window(&self, window_label: &str) -> Vec<SessionMeta> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.meta.window_label == window_label)
            .map(|s| s.meta.clone())
            .collect()
    }

    /// Kill every session bound to a window. Called from the
    /// `WindowEvent::Destroyed` hook in `lib.rs` so closing a SpecRider
    /// window leaves no orphaned PTYs.
    pub fn close_window(&self, window_label: &str) {
        let ids: Vec<SessionId> = {
            let map = self.sessions.lock().unwrap();
            map.values()
                .filter(|s| s.meta.window_label == window_label)
                .map(|s| s.meta.id.clone())
                .collect()
        };
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

fn run_reader_loop<E: TerminalEmitter>(
    mut reader: Box<dyn Read + Send>,
    emitter: E,
    window_label: String,
    id: SessionId,
    ring: Arc<Mutex<RingBuffer>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                ring.lock().unwrap().push(chunk);
                let payload = TerminalOutputEvent {
                    session_id: id.clone(),
                    chunk_b64: B64.encode(chunk),
                };
                emitter.emit_output(&window_label, &payload);
            }
            Err(e) => {
                emitter.emit_error(
                    &window_label,
                    &TerminalErrorEvent {
                        session_id: id.clone(),
                        message: format!("pty read error: {e}"),
                    },
                );
                break;
            }
        }
    }

    let exit_code = child
        .lock()
        .unwrap()
        .wait()
        .ok()
        .map(|s| s.exit_code() as i32);
    emitter.emit_exited(
        &window_label,
        &TerminalExitedEvent {
            session_id: id,
            exit_code,
        },
    );
    emitter.emit_sessions_changed();
}

// ---------------------------------------------------------------------------
// Tauri command wrappers the frontend invokes through
// @tauri-apps/api/core. Each one thinly delegates to TerminalManager
// and serializes inputs/outputs.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TerminalStartArgs {
    pub cwd: String,
    pub agent_kind: AgentKind,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
pub struct TerminalResolveCwdArgs {
    pub plans_root: Option<String>,
    pub repo_handle: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCwdPayload {
    pub cwd: String,
}

/// Verify that a frontend-supplied `cwd` resolves to a directory at
/// or under the calling window's plans root or a trusted linked repo.
/// Canonicalizes before comparing so symlink games and `..` don't slip
/// past. Linked roots come from workspace config and the read-trust map.
fn validate_terminal_cwd(
    plans_root: &Path,
    cwd: &Path,
    config: &State<'_, ConfigState>,
) -> Result<PathBuf, String> {
    validate_terminal_cwd_with_linked_root_loader(plans_root, cwd, || {
        trusted_linked_terminal_roots(plans_root, config)
    })
}

fn validate_terminal_cwd_with_linked_root_loader(
    plans_root: &Path,
    cwd: &Path,
    load_trusted_linked_roots: impl FnOnce() -> Result<Vec<PathBuf>, String>,
) -> Result<PathBuf, String> {
    let (canon_cwd, canon_root) = canonicalize_terminal_cwd(plans_root, cwd)?;
    if canon_cwd.starts_with(&canon_root) {
        return Ok(canon_cwd);
    }
    let trusted_roots = load_trusted_linked_roots()?;
    validate_terminal_cwd_against_linked_roots(&canon_cwd, &trusted_roots)
}

#[cfg(test)]
fn validate_terminal_cwd_with_roots(
    plans_root: &Path,
    trusted_linked_roots: &[PathBuf],
    cwd: &Path,
) -> Result<PathBuf, String> {
    let (canon_cwd, canon_root) = canonicalize_terminal_cwd(plans_root, cwd)?;
    if canon_cwd.starts_with(&canon_root) {
        return Ok(canon_cwd);
    }
    validate_terminal_cwd_against_linked_roots(&canon_cwd, trusted_linked_roots)
}

fn canonicalize_terminal_cwd(plans_root: &Path, cwd: &Path) -> Result<(PathBuf, PathBuf), String> {
    if !cwd.is_dir() {
        return Err(format!("cwd is not a directory: {}", cwd.display()));
    }
    let canon_cwd = cwd
        .canonicalize()
        .map_err(|e| format!("cwd canonicalize failed: {e}"))?;
    let canon_root = plans_root
        .canonicalize()
        .map_err(|e| format!("plans root canonicalize failed: {e}"))?;
    Ok((canon_cwd, canon_root))
}

fn validate_terminal_cwd_against_linked_roots(
    canon_cwd: &Path,
    trusted_linked_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    for root in trusted_linked_roots {
        let canon_linked = root
            .canonicalize()
            .map_err(|e| format!("linked repo canonicalize failed: {e}"))?;
        if canon_cwd.starts_with(canon_linked) {
            return Ok(canon_cwd.to_path_buf());
        }
    }
    Err(format!(
        "cwd {} is not inside the active plans root or a trusted linked repo",
        canon_cwd.display()
    ))
}

fn terminal_plans_root(
    plans_root: Option<String>,
    window: &Window,
    windows: &State<'_, WindowsState>,
) -> Result<PathBuf, String> {
    plans_root
        .filter(|root| !root.trim().is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            windows
                .get_or_create(window.label())
                .plans_root
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "no plans root configured for this window".to_string())
        })
}

fn trusted_linked_terminal_roots(
    plans_root: &Path,
    config: &State<'_, ConfigState>,
) -> Result<Vec<PathBuf>, String> {
    let repos = linked_repos_from_root(plans_root).map_err(|err| err.to_string())?;
    let cfg = config.0.lock().unwrap();
    Ok(repos
        .into_iter()
        .filter(|repo| {
            trust_for(&cfg.linked_repo_read_trust, &repo.path) == Some(TrustDecision::Trusted)
        })
        .map(|repo| repo.path)
        .collect())
}

fn resolve_terminal_cwd(
    plans_root: &Path,
    repo_handle: Option<&str>,
    config: &State<'_, ConfigState>,
) -> Result<PathBuf, String> {
    let Some(handle) = repo_handle.filter(|handle| !handle.is_empty()) else {
        return plans_root
            .canonicalize()
            .map_err(|e| format!("plans root canonicalize failed: {e}"));
    };
    if handle == "self" {
        return plans_root
            .canonicalize()
            .map_err(|e| format!("plans root canonicalize failed: {e}"));
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
                "linked repo `{handle}` is not trusted for terminal cwd"
            ))
        }
        None => {
            return Err(format!(
                "linked repo `{handle}` has not been trusted for terminal cwd"
            ))
        }
    }
    drop(cfg);

    if !repo.path.is_dir() {
        return Err(format!(
            "linked repo `{handle}` cwd is not a directory: {}",
            repo.path.display()
        ));
    }
    repo.path
        .canonicalize()
        .map_err(|e| format!("linked repo canonicalize failed: {e}"))
}

#[cfg(not(windows))]
fn quote_shell_path(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

#[cfg(windows)]
fn quote_shell_path(path: &str) -> String {
    format!("'{}'", path.replace('\'', "''"))
}

fn shell_cd_command(cwd: &Path) -> Vec<u8> {
    let path = cwd.to_string_lossy();
    #[cfg(windows)]
    let command = format!("Set-Location -LiteralPath {}\r", quote_shell_path(&path));
    #[cfg(not(windows))]
    let command = format!("cd -- {}\r", quote_shell_path(&path));
    command.into_bytes()
}

#[tauri::command]
pub fn terminal_start<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: State<'_, TerminalManager>,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
    args: TerminalStartArgs,
) -> Result<SessionMeta, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws
        .plans_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no plans root configured for this window".to_string())?;
    let raw_cwd = PathBuf::from(args.cwd);
    let cwd = validate_terminal_cwd(&plans_root, &raw_cwd, &config)?;
    let scrub_secrets = config
        .0
        .lock()
        .unwrap()
        .settings
        .terminal_scrub_secrets
        .unwrap_or(false);
    state.start(
        &app,
        TerminalStartRequest {
            window_label: window.label().to_string(),
            cwd,
            agent_kind: args.agent_kind,
            cols: args.cols.max(1),
            rows: args.rows.max(1),
            scrub_secrets,
        },
    )
}

#[tauri::command]
pub fn terminal_resolve_cwd(
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
    args: TerminalResolveCwdArgs,
) -> Result<TerminalCwdPayload, String> {
    let plans_root = terminal_plans_root(args.plans_root, &window, &windows)?;
    let cwd = resolve_terminal_cwd(&plans_root, args.repo_handle.as_deref(), &config)?;
    Ok(TerminalCwdPayload {
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

#[derive(Debug, Deserialize)]
pub struct TerminalWriteArgs {
    pub session_id: SessionId,
    /// Base64-encoded bytes — keystrokes or paste payloads. We decode
    /// in Rust so the JS side never has to assemble a JSON byte array.
    pub bytes_b64: String,
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalManager>,
    args: TerminalWriteArgs,
) -> Result<(), String> {
    // Reject oversized payloads *before* allocating the decoded
    // buffer. Multi-GB pastes from a misbehaving / hostile renderer
    // would otherwise OOM the host before this command returned.
    if args.bytes_b64.len() > MAX_WRITE_BYTES_B64 {
        return Err(format!("write payload exceeds {MAX_WRITE_BYTES}-byte cap"));
    }
    let bytes = B64
        .decode(args.bytes_b64.as_bytes())
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    state.write(&args.session_id, &bytes)
}

#[derive(Debug, Deserialize)]
pub struct TerminalSetCwdArgs {
    pub session_id: SessionId,
    pub cwd: String,
}

#[tauri::command]
pub fn terminal_set_cwd(
    window: Window,
    windows: State<'_, WindowsState>,
    config: State<'_, ConfigState>,
    state: State<'_, TerminalManager>,
    args: TerminalSetCwdArgs,
) -> Result<(), String> {
    let plans_root = terminal_plans_root(None, &window, &windows)?;
    let cwd = validate_terminal_cwd(&plans_root, &PathBuf::from(args.cwd), &config)?;
    state.set_cwd(&args.session_id, cwd)
}

#[derive(Debug, Deserialize)]
pub struct TerminalResizeArgs {
    pub session_id: SessionId,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalManager>,
    args: TerminalResizeArgs,
) -> Result<(), String> {
    state.resize(&args.session_id, args.cols.max(1), args.rows.max(1))
}

#[derive(Debug, Deserialize)]
pub struct TerminalKillArgs {
    pub session_id: SessionId,
}

#[tauri::command]
pub fn terminal_kill(
    state: State<'_, TerminalManager>,
    args: TerminalKillArgs,
) -> Result<(), String> {
    state.kill(&args.session_id)
}

#[derive(Debug, Deserialize)]
pub struct TerminalReplayArgs {
    pub session_id: SessionId,
}

#[derive(Debug, Serialize)]
pub struct TerminalReplayPayload {
    pub bytes_b64: String,
}

#[tauri::command]
pub fn terminal_replay(
    state: State<'_, TerminalManager>,
    args: TerminalReplayArgs,
) -> Result<TerminalReplayPayload, String> {
    let bytes = state.replay(&args.session_id)?;
    Ok(TerminalReplayPayload {
        bytes_b64: B64.encode(&bytes),
    })
}

#[tauri::command]
pub fn list_terminal_sessions<R: Runtime>(
    window: Window<R>,
    state: State<'_, TerminalManager>,
) -> Vec<SessionMeta> {
    state.list_for_window(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    #[derive(Clone, Default)]
    struct TestEmitter {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl TerminalEmitter for TestEmitter {
        fn emit_started(&self, _window_label: &str, _meta: &SessionMeta) {
            self.events.lock().unwrap().push("started");
        }

        fn emit_output(&self, _window_label: &str, _payload: &TerminalOutputEvent) {
            self.events.lock().unwrap().push("output");
        }

        fn emit_exited(&self, _window_label: &str, _payload: &TerminalExitedEvent) {
            self.events.lock().unwrap().push("exited");
        }

        fn emit_error(&self, _window_label: &str, _payload: &TerminalErrorEvent) {
            self.events.lock().unwrap().push("error");
        }

        fn emit_sessions_changed(&self) {
            self.events.lock().unwrap().push("sessions-changed");
        }
    }

    #[test]
    fn validate_terminal_cwd_accepts_root_and_subdir() {
        let root = TempDir::new().unwrap();
        let sub = root.path().join("nested");
        std::fs::create_dir_all(&sub).unwrap();

        assert!(validate_terminal_cwd_with_roots(root.path(), &[], root.path()).is_ok());
        assert!(validate_terminal_cwd_with_roots(root.path(), &[], &sub).is_ok());
    }

    #[test]
    fn validate_terminal_cwd_inside_root_ignores_invalid_workspace_config() {
        let root = TempDir::new().unwrap();
        let config_dir = root.path().join(".specrider");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("workspace.json"), "{}\n").unwrap();

        let cwd = validate_terminal_cwd_with_linked_root_loader(root.path(), root.path(), || {
            linked_repos_from_root(root.path())
                .map(|repos| repos.into_iter().map(|repo| repo.path).collect())
                .map_err(|err| err.to_string())
        })
        .unwrap();

        assert_eq!(cwd, root.path().canonicalize().unwrap());
    }

    #[test]
    fn validate_terminal_cwd_accepts_trusted_linked_root_and_subdir() {
        let root = TempDir::new().unwrap();
        let linked = TempDir::new().unwrap();
        let sub = linked.path().join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let trusted = vec![linked.path().to_path_buf()];

        assert!(validate_terminal_cwd_with_roots(root.path(), &trusted, linked.path()).is_ok());
        assert!(validate_terminal_cwd_with_roots(root.path(), &trusted, &sub).is_ok());
    }

    #[test]
    fn validate_terminal_cwd_rejects_outside() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let err = validate_terminal_cwd_with_roots(root.path(), &[], outside.path()).unwrap_err();
        assert!(err.contains("not inside the active plans root or a trusted linked repo"));
    }

    #[test]
    fn validate_terminal_cwd_rejects_nondirectory() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("not-a-dir");
        let err = validate_terminal_cwd_with_roots(root.path(), &[], &path).unwrap_err();
        assert!(err.contains("not a directory"));
    }

    #[test]
    fn validate_terminal_cwd_rejects_root_when_cwd_resolves_to_parent() {
        let root = TempDir::new().unwrap();
        let parent = root.path().parent().unwrap().to_path_buf();
        let err = validate_terminal_cwd_with_roots(root.path(), &[], &parent).unwrap_err();
        assert!(err.contains("not inside the active plans root or a trusted linked repo"));
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_cd_command_quotes_posix_paths() {
        let cmd = String::from_utf8(shell_cd_command(Path::new("/tmp/has space/it'do"))).unwrap();
        assert_eq!(cmd, "cd -- '/tmp/has space/it'\\''do'\r");
    }

    #[test]
    fn env_scrub_targets_credential_fragments() {
        assert!(env_key_should_scrub(&OsString::from("ANTHROPIC_API_KEY")));
        assert!(env_key_should_scrub(&OsString::from("OPENAI_API_KEY")));
        assert!(env_key_should_scrub(&OsString::from("GITHUB_TOKEN")));
        assert!(env_key_should_scrub(&OsString::from(
            "aws_secret_access_key"
        )));
        assert!(env_key_should_scrub(&OsString::from("DB_PASSWORD")));
        assert!(!env_key_should_scrub(&OsString::from("PATH")));
        assert!(!env_key_should_scrub(&OsString::from("HOME")));
        assert!(!env_key_should_scrub(&OsString::from("SHELL")));
    }

    #[test]
    fn write_payload_cap_constants_match() {
        // 1 MiB raw → ~1.33 MiB base64 (rounded up). The b64 cap should
        // be a touch larger to allow valid encodings of 1 MiB to pass
        // and then get rejected at the post-decode check.
        let max_write_bytes = MAX_WRITE_BYTES;
        let max_write_bytes_b64 = MAX_WRITE_BYTES_B64;
        assert_eq!(max_write_bytes, 1024 * 1024);
        assert!(max_write_bytes_b64 > max_write_bytes);
        // ~33% expansion plus the safety pad we added:
        assert!(max_write_bytes_b64 >= max_write_bytes * 4 / 3);
    }

    #[test]
    fn ring_buffer_replay_keeps_newest_bytes() {
        let mut ring = RingBuffer::new(5);
        ring.push(b"hello");
        assert_eq!(ring.snapshot(), b"hello");

        ring.push(b" world");
        assert_eq!(ring.snapshot(), b"world");
    }

    #[test]
    fn terminal_manager_missing_session_lifecycle_is_predictable() {
        let manager = TerminalManager::new();

        let write_err = manager.write("missing", b"x").unwrap_err();
        assert!(write_err.contains("session missing not found"));

        let resize_err = manager.resize("missing", 80, 24).unwrap_err();
        assert!(resize_err.contains("session missing not found"));

        let replay_err = manager.replay("missing").unwrap_err();
        assert!(replay_err.contains("session missing not found"));

        assert!(manager.kill("missing").is_ok());
        assert!(manager.list_for_window("main").is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn terminal_manager_shell_lifecycle_start_write_resize_replay_kill() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new();
        let emitter = TestEmitter::default();

        let meta = manager
            .start_with_emitter(
                emitter.clone(),
                TerminalStartRequest {
                    window_label: "main".to_string(),
                    cwd: root.path().to_path_buf(),
                    agent_kind: AgentKind::Shell,
                    cols: 40,
                    rows: 10,
                    scrub_secrets: true,
                },
            )
            .unwrap();

        assert_eq!(meta.id, "term-0001");
        assert_eq!(meta.window_label, "main");
        manager.resize(&meta.id, 100, 30).unwrap();
        let listed = manager.list_for_window("main");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].cols, 100);
        assert_eq!(listed[0].rows, 30);

        manager.write(&meta.id, b"printf 'sr-ready\\n'\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut replay = Vec::new();
        let mut saw_ready = false;
        while Instant::now() < deadline {
            replay = manager.replay(&meta.id).unwrap();
            if String::from_utf8_lossy(&replay).contains("sr-ready") {
                saw_ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(manager.kill(&meta.id).is_ok());
        assert!(
            saw_ready,
            "terminal replay never contained sentinel; replay was: {}",
            String::from_utf8_lossy(&replay)
        );
        assert!(manager.list_for_window("main").is_empty());

        let events = emitter.events.lock().unwrap().clone();
        assert!(events.contains(&"started"));
        assert!(events.contains(&"output"));
        assert!(events.contains(&"sessions-changed"));
    }
}
