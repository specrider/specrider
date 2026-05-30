// Centralized `git` shellout helpers.
//
// Every git invocation in the app should go through this module so the
// hardening invariants are enforced in one place rather than per call:
//
//   - `safe.directory` pinned to the canonical repo root, paired with
//     an upfront `.git/` ownership check that refuses to operate on a
//     repo owned by a different UID (CVE-2022-24765 family).
//   - `core.hooksPath=/dev/null` for read-only commands; write-side
//     commands (commit / checkout / pull / push / merge / fetch) gate
//     hook execution behind a per-root toggle that defaults off.
//   - Interactive credential prompts disabled (GIT_TERMINAL_PROMPT=0,
//     GIT_ASKPASS=/usr/bin/true, ssh BatchMode).
//   - Stderr passed through a credential redactor before surfacing.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Output};

/// Refusal returned by [`check_ownership`] when `.git/` is owned by a
/// different UID than the running process. Callers map this to
/// `GitOpError { code: "untrusted-repo", … }`.
#[derive(Debug, Clone)]
pub struct UntrustedRepo {
    pub message: String,
}

impl UntrustedRepo {
    pub fn into_message(self) -> String {
        self.message
    }
}

/// Reject ref/branch/SHA strings that would be parsed as flags by git
/// or that contain whitespace / NUL / characters disallowed in refs.
/// Mirrors `git check-ref-format` minus the parts only relevant to
/// remote-side parsing.
pub fn validate_ref(s: &str) -> Result<(), &'static str> {
    if s.is_empty() {
        return Err("empty ref");
    }
    if s.starts_with('-') {
        return Err("ref begins with '-'");
    }
    if s.contains('\0') {
        return Err("ref contains NUL");
    }
    for c in s.chars() {
        if c.is_whitespace() {
            return Err("ref contains whitespace");
        }
        if matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return Err("ref contains forbidden character");
        }
    }
    if s.contains("..") || s.ends_with('.') || s.ends_with('/') {
        return Err("malformed ref");
    }
    Ok(())
}

/// Validate that a path argument can be safely passed positionally to
/// git. Disallows leading `-` (which git would parse as a flag even
/// after `--` for some sub-commands' path-list options) and NUL.
/// Whitespace is allowed — paths legitimately contain spaces.
pub fn validate_path_arg(s: &str) -> Result<(), &'static str> {
    if s.is_empty() {
        return Err("empty path");
    }
    if s.starts_with('-') {
        return Err("path begins with '-'");
    }
    if s.contains('\0') {
        return Err("path contains NUL");
    }
    Ok(())
}

/// Strip embedded URL credentials from text destined for the UI. Git
/// already redacts passwords on most paths but not all (notably some
/// `fatal: unable to access` traces from libcurl). This is a defense
/// in depth pass that catches `https://user:token@host/...` and the
/// shorter `git://user@host/...`/`ssh://user@host/...` forms.
pub fn redact_credentials(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Look for "://" anchored to a scheme prefix we care about.
        if let Some(rel) = bytes[i..]
            .windows(3)
            .position(|w| w == b"://")
            .filter(|p| starts_with_recognized_scheme(&bytes[..i + *p]))
        {
            let scheme_end = i + rel + 3;
            // Find the next `@` before any `/`, `?`, `#`, whitespace.
            let mut j = scheme_end;
            let mut at_idx: Option<usize> = None;
            while j < bytes.len() {
                let c = bytes[j];
                if c == b'@' {
                    at_idx = Some(j);
                    break;
                }
                if matches!(c, b'/' | b'?' | b'#' | b' ' | b'\t' | b'\n' | b'\r') {
                    break;
                }
                j += 1;
            }
            let copy_end = at_idx.map_or(scheme_end, |k| k + 1);
            // Emit up through the scheme separator.
            out.push_str(std::str::from_utf8(&bytes[i..scheme_end]).unwrap_or(""));
            if at_idx.is_some() {
                out.push_str("[redacted]@");
                i = copy_end;
            } else {
                i = scheme_end;
            }
            continue;
        }
        // Copy a single character (handle multi-byte by char boundary).
        let next = std::str::from_utf8(&bytes[i..])
            .ok()
            .and_then(|s| s.chars().next())
            .map(|c| c.len_utf8())
            .unwrap_or(1);
        out.push_str(std::str::from_utf8(&bytes[i..i + next]).unwrap_or(""));
        i += next;
    }
    out
}

fn starts_with_recognized_scheme(prefix: &[u8]) -> bool {
    let slice = std::str::from_utf8(prefix).unwrap_or("");
    let trimmed = slice
        .rsplit(|c: char| c.is_whitespace() || c == '\'' || c == '"' || c == '(' || c == '<')
        .next()
        .unwrap_or("");
    matches!(trimmed, "http" | "https" | "git" | "ssh")
}

/// Best-effort ownership check on `.git`. Returns `Ok` on platforms
/// without UID semantics (Windows). On Unix, refuses when the metadata
/// owner doesn't match the running process's effective UID.
pub fn check_ownership(repo_root: &Path) -> Result<(), UntrustedRepo> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let dot_git = repo_root.join(".git");
        // `.git` may be a file (worktree) — follow_links=true (default) so
        // we land on the real directory for the ownership read.
        let meta = match std::fs::metadata(&dot_git) {
            Ok(m) => m,
            Err(_) => return Ok(()),
        };
        // SAFETY: `geteuid` is a no-arg syscall returning the effective
        // UID; always sound to call.
        let euid = unsafe { libc::geteuid() };
        let owner = meta.uid();
        if owner != euid && euid != 0 {
            return Err(UntrustedRepo {
                message: format!(
                    "Refusing to operate on a Git repository owned by a different user (uid {owner} vs. current uid {euid}). Re-clone or `chown` the repo and try again."
                ),
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = repo_root;
    }
    Ok(())
}

/// Canonicalize the repo root for the `safe.directory` argument. We
/// canonicalize to defang `..` games and to give git a stable absolute
/// path it can match against.
fn safe_directory_value(repo_root: &Path) -> OsString {
    let canon = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    canon.into_os_string()
}

fn apply_common_env(cmd: &mut Command, with_ssh_agent: bool) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // GIT_ASKPASS must point at an existing executable; the literal
    // string "true" worked on macOS by accident (PATH resolution to
    // /usr/bin/true) but failed silently on minimal Linux containers.
    cmd.env("GIT_ASKPASS", "/usr/bin/true");
    cmd.env("SSH_ASKPASS_REQUIRE", "never");
    if with_ssh_agent {
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
    } else {
        // Detach from any SSH agent — notably gnome-keyring-daemon on
        // Linux, which prompts the user to "Unlock private key
        // storage" the first time anything probes its socket. Used by
        // background fetches where we'd rather fail silently than pop
        // a system dialog. SSH-keyed remotes won't auto-fetch under
        // this branch, but they couldn't have completed anyway given
        // the BatchMode flag below.
        cmd.env_remove("SSH_AUTH_SOCK");
        cmd.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o IdentityAgent=none",
        );
    }
}

fn build_command(repo_root: &Path, hooks_off: bool, with_ssh_agent: bool) -> Command {
    let mut cmd = Command::new("git");
    let mut sd = OsString::from("safe.directory=");
    sd.push(safe_directory_value(repo_root));
    cmd.arg("-c").arg(sd);
    if hooks_off {
        cmd.arg("-c").arg("core.hooksPath=/dev/null");
    }
    cmd.arg("-C").arg(repo_root);
    apply_common_env(&mut cmd, with_ssh_agent);
    cmd
}

/// Run a read-only git command. Always disables `core.hooksPath`. The
/// caller is responsible for the [`check_ownership`] precondition for
/// freshly opened roots; we don't repeat it on every read to avoid the
/// stat overhead in inner loops.
pub fn run_read(repo_root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = build_command(repo_root, true, true);
    for a in args {
        cmd.arg(a);
    }
    cmd.output().map_err(|e| {
        format!(
            "git {}: {}",
            args.join(" "),
            redact_credentials(&e.to_string())
        )
    })
}

/// Run a write-side git command. `allow_hooks` is the per-root toggle.
/// When `false` (default), `core.hooksPath=/dev/null` is set so any
/// `pre-commit` / `post-checkout` etc. in the repo can't execute.
pub fn run_write(repo_root: &Path, args: &[&str], allow_hooks: bool) -> Result<Output, String> {
    let mut cmd = build_command(repo_root, !allow_hooks, true);
    for a in args {
        cmd.arg(a);
    }
    cmd.output().map_err(|e| {
        format!(
            "git {}: {}",
            args.join(" "),
            redact_credentials(&e.to_string())
        )
    })
}

/// Variant of [`run_write`] that detaches from the SSH agent — see the
/// `with_ssh_agent = false` branch in `apply_common_env` for the why.
/// Used by background fetch so gnome-keyring-daemon doesn't ask the
/// user to unlock the keyring on every visibility-change tick.
pub fn run_write_no_ssh_agent(
    repo_root: &Path,
    args: &[&str],
    allow_hooks: bool,
) -> Result<Output, String> {
    let mut cmd = build_command(repo_root, !allow_hooks, false);
    for a in args {
        cmd.arg(a);
    }
    cmd.output().map_err(|e| {
        format!(
            "git {}: {}",
            args.join(" "),
            redact_credentials(&e.to_string())
        )
    })
}

/// Read-side variant that takes an `OsString` argument list — useful
/// for paths that may not be valid UTF-8.
pub fn run_read_os(repo_root: &Path, args: &[OsString]) -> Result<Output, String> {
    let mut cmd = build_command(repo_root, true, true);
    for a in args {
        cmd.arg(a);
    }
    cmd.output().map_err(|e| {
        format!(
            "git {}: {}",
            args.iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" "),
            redact_credentials(&e.to_string())
        )
    })
}

/// Convenience wrapper: read-side with a single trailing path argument.
pub fn run_read_with_path(repo_root: &Path, args: &[&str], path: &Path) -> Result<Output, String> {
    let mut owned: Vec<OsString> = args.iter().map(OsString::from).collect();
    owned.push(path.as_os_str().to_owned());
    run_read_os(repo_root, &owned)
}

/// Validate a linked-repo read invocation before it reaches `git`.
/// Linked repos are review targets only; every future linked-repo
/// caller must enter through this boundary so mutation subcommands are
/// rejected in one place instead of hidden/disabled only in the UI.
pub fn validate_linked_repo_read_args(args: &[&str]) -> Result<(), String> {
    let Some(command) = args.first().copied() else {
        return Err("linked repo git command cannot be empty".to_string());
    };
    let allowed = matches!(
        command,
        "cat-file"
            | "diff"
            | "diff-tree"
            | "for-each-ref"
            | "log"
            | "ls-files"
            | "ls-tree"
            | "merge-base"
            | "rev-list"
            | "rev-parse"
            | "show"
            | "symbolic-ref"
    );
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "git {command} is not allowed for linked repositories; linked repositories are read-only"
        ))
    }
}

#[allow(dead_code)]
pub fn run_linked_repo_read(repo_root: &Path, args: &[&str]) -> Result<Output, String> {
    validate_linked_repo_read_args(args)?;
    run_read(repo_root, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_validator_rejects_dash_prefix() {
        assert!(validate_ref("--upload-pack=evil").is_err());
        assert!(validate_ref("-q").is_err());
    }

    #[test]
    fn ref_validator_rejects_whitespace_and_nul() {
        assert!(validate_ref("foo bar").is_err());
        assert!(validate_ref("foo\0bar").is_err());
        assert!(validate_ref("").is_err());
    }

    #[test]
    fn ref_validator_accepts_normal_refs() {
        assert!(validate_ref("main").is_ok());
        assert!(validate_ref("origin/feature").is_ok());
        assert!(validate_ref("v1.2.3").is_ok());
        assert!(validate_ref("a1b2c3d4e5f6").is_ok());
    }

    #[test]
    fn path_validator_rejects_dash_prefix() {
        assert!(validate_path_arg("--interactive").is_err());
        assert!(validate_path_arg("-p").is_err());
        assert!(validate_path_arg("docs/plans/foo.md").is_ok());
        assert!(validate_path_arg("path with spaces.md").is_ok());
    }

    #[test]
    fn redactor_strips_https_creds() {
        let input = "fatal: unable to access 'https://user:token@github.com/foo/bar.git/': boom";
        let out = redact_credentials(input);
        assert!(!out.contains("token"));
        assert!(!out.contains("user:token"));
        assert!(out.contains("[redacted]@github.com"));
    }

    #[test]
    fn redactor_strips_ssh_creds() {
        let input = "ssh://deploy@host:22/foo.git failed";
        let out = redact_credentials(input);
        assert!(out.contains("[redacted]@host"));
    }

    #[test]
    fn redactor_leaves_clean_urls_alone() {
        let input = "https://github.com/foo/bar.git is fine";
        assert_eq!(redact_credentials(input), input);
    }

    #[test]
    fn linked_repo_read_boundary_allows_read_commands() {
        for args in [
            &["diff", "main..feature"][..],
            &["diff-tree", "--name-status", "HEAD"][..],
            &["log", "--oneline"][..],
            &["show", "HEAD"][..],
            &["rev-parse", "HEAD"][..],
            &["for-each-ref", "refs/heads"][..],
        ] {
            assert!(validate_linked_repo_read_args(args).is_ok());
        }
    }

    #[test]
    fn linked_repo_read_boundary_rejects_mutations() {
        for args in [
            &["commit", "-m", "x"][..],
            &["checkout", "feature"][..],
            &["push"][..],
            &["fetch"][..],
            &["pull"][..],
            &["reset", "--hard"][..],
            &["branch", "-D", "feature"][..],
        ] {
            assert!(validate_linked_repo_read_args(args).is_err());
        }
    }
}
