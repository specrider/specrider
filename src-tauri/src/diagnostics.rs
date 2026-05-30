//! Diagnostic snapshot for bug reports.
//!
//! `Help → Copy diagnostics` (and the equivalent Settings → System & Updates button)
//! invokes `diagnostics_snapshot`, which gathers the small set of facts
//! we ask for in every issue (app + Tauri version, OS, arch, webview,
//! locale, trust state, settings shape, runtime feature flags) and
//! returns both a structured payload and a pre-rendered fenced-markdown
//! block ready to paste into a GitHub issue.
//!
//! Privacy posture:
//!   - No telemetry: the snapshot never leaves the user's clipboard
//!     unless the user pastes it.
//!   - The plans-root **path** is intentionally NOT included. Earlier
//!     iterations shipped a redacted "…/last-two-segments" form, but
//!     even the slug can carry a client/project codename. We surface
//!     only whether a root is bound + the trust state, which is what
//!     bug triage actually needs.
use serde::Serialize;
use tauri::{State, Window};

use crate::config::{AppSettings, ConfigState};
use crate::state::WindowsState;
use crate::workspace_trust::{trust_for, TrustDecision};

/// Compile-time cargo target triple, forwarded by `build.rs` from the
/// `TARGET` env var cargo sets for build scripts. Falls back to
/// `"unknown"` if the build script did not provide it.
const TARGET_TRIPLE: &str = match option_env!("SPECRIDER_TARGET_TRIPLE") {
    Some(t) => t,
    None => "unknown",
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub app_version: String,
    pub tauri_version: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub target_triple: String,
    pub webview: String,
    pub locale: String,
    /// `true` when the calling window has a plans root bound. The path
    /// itself is deliberately omitted — folder names can be sensitive
    /// (client codenames, internal project labels) and the boolean is
    /// what triage actually needs.
    pub plans_root_bound: bool,
    /// One of `"trusted"`, `"untrusted"`, `"not-set"`, `"no-root"`.
    pub workspace_trust: String,
    /// Number of project (non-Settings) webview windows currently open.
    /// Useful for multi-window race reports.
    pub windows_open: u32,
    /// Full `AppSettings` shape, minus null/unset fields and with
    /// `defaultPlansRoot` reduced to a `defaultPlansRootSet: bool` so
    /// we don't leak the user's chosen folder path. Keys mirror the
    /// camelCase form used everywhere else in IPC.
    pub settings: serde_json::Map<String, serde_json::Value>,
    pub feature_flags: Vec<String>,
    /// Fenced markdown block ready to paste into a GitHub issue.
    pub markdown: String,
}

#[tauri::command]
pub fn diagnostics_snapshot(
    window: Window,
    windows: State<'_, WindowsState>,
    state: State<'_, ConfigState>,
    app: tauri::AppHandle,
) -> DiagnosticsSnapshot {
    let ws = windows.get_or_create(window.label());
    let plans_root = ws.plans_root.lock().unwrap().clone();
    let (trust, settings) = {
        let cfg = state.0.lock().unwrap();
        let trust = plans_root
            .as_ref()
            .and_then(|root| trust_for(&cfg.workspace_trust_per_root, root));
        (trust, cfg.settings.clone())
    };
    let windows_open = count_project_windows(&app);
    gather(
        plans_root.is_some(),
        trust,
        windows_open,
        &settings,
        webview_version_or_unknown(),
    )
}

fn count_project_windows(app: &tauri::AppHandle) -> u32 {
    use tauri::Manager;
    app.webview_windows()
        .keys()
        .filter(|label| label.as_str() != "settings")
        .count() as u32
}

/// Pure-function core, exposed so tests can call it without spinning up
/// a Tauri runtime.
pub(crate) fn gather(
    plans_root_bound: bool,
    trust: Option<TrustDecision>,
    windows_open: u32,
    settings: &AppSettings,
    webview_version: Option<String>,
) -> DiagnosticsSnapshot {
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let tauri_version = tauri::VERSION.to_string();

    let info = os_info::get();
    let os = std::env::consts::OS.to_string();
    let os_version = info.version().to_string();
    let arch = std::env::consts::ARCH.to_string();
    let target_triple = TARGET_TRIPLE.to_string();
    let webview = describe_webview(webview_version);
    let locale = sys_locale::get_locale().unwrap_or_else(|| "unknown".to_string());

    let workspace_trust = match (plans_root_bound, trust) {
        (false, _) => "no-root".to_string(),
        (true, None) => "not-set".to_string(),
        (true, Some(TrustDecision::Trusted)) => "trusted".to_string(),
        (true, Some(TrustDecision::Untrusted)) => "untrusted".to_string(),
    };
    let feature_flags = feature_flags();
    let settings_dump = dump_settings(settings);

    let markdown = render_markdown(
        &app_version,
        &tauri_version,
        &os,
        &os_version,
        &arch,
        &target_triple,
        &webview,
        &locale,
        plans_root_bound,
        &workspace_trust,
        windows_open,
        &settings_dump,
        &feature_flags,
    );

    DiagnosticsSnapshot {
        app_version,
        tauri_version,
        os,
        os_version,
        arch,
        target_triple,
        webview,
        locale,
        plans_root_bound,
        workspace_trust,
        windows_open,
        settings: settings_dump,
        feature_flags,
        markdown,
    }
}

/// Serialize the full settings object, but:
///   1. Drop `defaultPlansRoot` (a full filesystem path) — replace with
///      a `defaultPlansRootSet` boolean so triagers still know whether
///      the user has configured a default folder.
///   2. Skip null / unset fields. The snapshot then reflects only the
///      user's actual overrides; the absence of a key means "still on
///      the hardcoded default" — knowable by anyone reading the issue.
///
/// Anything else in `AppSettings` rides along automatically — no
/// hand-curated allowlist to keep in sync as we add settings.
pub(crate) fn dump_settings(s: &AppSettings) -> serde_json::Map<String, serde_json::Value> {
    let mut map = match serde_json::to_value(s) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let path_set = map
        .remove("defaultPlansRoot")
        .map(|v| !v.is_null())
        .unwrap_or(false);
    map.retain(|_, v| !v.is_null());
    map.insert(
        "defaultPlansRootSet".to_string(),
        serde_json::Value::Bool(path_set),
    );
    map
}

fn webview_version_or_unknown() -> Option<String> {
    // Wry's webview_version() probes the platform runtime (WKWebView /
    // WebView2 / WebKitGTK). On Linux it can fail on minimal systems
    // missing webkit2gtk; the snapshot stays useful even when this is
    // empty — we render "WKWebView", "WebView2", or "WebKitGTK" alone.
    tauri::webview_version().ok().filter(|s| !s.is_empty())
}

fn describe_webview(version: Option<String>) -> String {
    let kind = if cfg!(target_os = "macos") {
        "WKWebView"
    } else if cfg!(target_os = "windows") {
        "WebView2"
    } else if cfg!(target_os = "linux") {
        "WebKitGTK"
    } else {
        "unknown"
    };
    match version {
        Some(v) => format!("{kind} {v}"),
        None => kind.to_string(),
    }
}

fn feature_flags() -> Vec<String> {
    // Keep the list short: callers want to know which subsystems are
    // active at runtime, not a wall of cfg toggles.
    let mut flags = Vec::new();
    flags.push(if cfg!(debug_assertions) {
        "build:debug".to_string()
    } else {
        "build:release".to_string()
    });
    flags.push(format!(
        "updater:{}",
        crate::commands::updater_install_kind()
    ));
    flags
}

#[allow(clippy::too_many_arguments)]
fn render_markdown(
    app_version: &str,
    tauri_version: &str,
    os: &str,
    os_version: &str,
    arch: &str,
    target_triple: &str,
    webview: &str,
    locale: &str,
    plans_root_bound: bool,
    workspace_trust: &str,
    windows_open: u32,
    settings: &serde_json::Map<String, serde_json::Value>,
    feature_flags: &[String],
) -> String {
    let mut out = String::new();
    out.push_str("```text\n");
    out.push_str(&format!(
        "app: SpecRider {app_version} (Tauri {tauri_version})\n"
    ));
    out.push_str(&format!("os: {os} {os_version} ({target_triple})\n"));
    out.push_str(&format!("arch: {arch}\n"));
    out.push_str(&format!("webview: {webview}\n"));
    out.push_str(&format!("locale: {locale}\n"));
    out.push_str(&format!(
        "plans_root_bound: {}\n",
        if plans_root_bound { "yes" } else { "no" }
    ));
    out.push_str(&format!("workspace_trust: {workspace_trust}\n"));
    out.push_str(&format!("windows_open: {windows_open}\n"));
    out.push_str(&format!("features: {}\n", feature_flags.join(", ")));
    if settings.is_empty() {
        out.push_str("settings: (all defaults)\n");
    } else {
        out.push_str("settings:\n");
        // Stable key order so issue-to-issue diffs are easy to read.
        let mut keys: Vec<&String> = settings.keys().collect();
        keys.sort();
        for k in keys {
            let v = &settings[k];
            out.push_str(&format!("  {k}: {}\n", format_setting_value(v)));
        }
    }
    out.push_str("```\n");
    out
}

/// Render a single setting value compactly. Strings unquoted, scalars
/// as-is, arrays/objects fall back to JSON. Keeps the snapshot
/// human-readable for the 95% case where every value is a primitive.
fn format_setting_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => "null".to_string(),
        _ => v.to_string(),
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use crate::config::DefaultTrustPolicy;
    use std::path::PathBuf;

    fn settings() -> AppSettings {
        AppSettings::default()
    }

    fn baseline() -> DiagnosticsSnapshot {
        // Pin a webview version string so the markdown output is
        // deterministic for the format-stability assertions below.
        gather(
            true,
            Some(TrustDecision::Trusted),
            2,
            &settings(),
            Some("Test/1.2.3".to_string()),
        )
    }

    #[test]
    fn snapshot_serializes_to_camelcase_json() {
        let snap = baseline();
        let json = serde_json::to_value(&snap).expect("serialize");
        for key in [
            "appVersion",
            "tauriVersion",
            "targetTriple",
            "plansRootBound",
            "workspaceTrust",
            "windowsOpen",
            "settings",
            "featureFlags",
        ] {
            assert!(json.get(key).is_some(), "missing key `{key}`");
        }
        // Settings is an object.
        assert!(
            json["settings"].is_object(),
            "expected settings to be an object: {}",
            json["settings"]
        );
    }

    #[test]
    fn markdown_block_is_fenced_and_contains_keys() {
        let snap = baseline();
        let md = &snap.markdown;
        assert!(md.starts_with("```text\n"), "expected fenced block: {md}");
        assert!(
            md.trim_end().ends_with("```"),
            "expected closing fence: {md}"
        );
        for key in [
            "app:",
            "os:",
            "arch:",
            "webview:",
            "locale:",
            "plans_root_bound:",
            "workspace_trust:",
            "windows_open:",
            "settings:",
            "features:",
        ] {
            assert!(md.contains(key), "missing key `{key}` in:\n{md}");
        }
    }

    #[test]
    fn markdown_never_contains_path_segments() {
        // Privacy invariant: the snapshot must not leak any folder name
        // — neither the workspace plans-root nor the default-folder
        // setting. Exercise with a fully-populated AppSettings so we'd
        // catch a regression that started dumping `defaultPlansRoot`.
        let s = AppSettings {
            default_plans_root: Some(PathBuf::from("/Users/alice/secret-client/plans")),
            ..AppSettings::default()
        };
        let snap = gather(true, Some(TrustDecision::Trusted), 1, &s, None);
        let md = &snap.markdown;
        assert!(!md.contains("…/"), "ellipsis path leaked:\n{md}");
        for needle in ["/Users/", "/home/", "C:\\\\", "\\Users\\", "secret-client"] {
            assert!(!md.contains(needle), "path leaked ({needle}):\n{md}");
        }
        // The bool replacement, on the other hand, MUST be present so a
        // triager can tell whether the user has a default folder set.
        assert!(
            md.contains("defaultPlansRootSet: true"),
            "expected defaultPlansRootSet bool in:\n{md}"
        );
    }

    #[test]
    fn no_plans_root_renders_as_no_root() {
        let snap = gather(false, None, 1, &settings(), Some("Test/1.2.3".to_string()));
        assert!(!snap.plans_root_bound);
        assert!(snap.markdown.contains("plans_root_bound: no"));
        assert_eq!(snap.workspace_trust, "no-root");
    }

    #[test]
    fn trust_states_round_trip_to_strings() {
        let trusted = gather(true, Some(TrustDecision::Trusted), 1, &settings(), None);
        assert_eq!(trusted.workspace_trust, "trusted");

        let untrusted = gather(true, Some(TrustDecision::Untrusted), 1, &settings(), None);
        assert_eq!(untrusted.workspace_trust, "untrusted");

        let undecided = gather(true, None, 1, &settings(), None);
        assert_eq!(undecided.workspace_trust, "not-set");
    }

    #[test]
    fn webview_string_includes_version_when_known() {
        let with = gather(false, None, 0, &settings(), Some("Test/1.2.3".to_string()));
        assert!(with.webview.contains("Test/1.2.3"), "got: {}", with.webview);

        let without = gather(false, None, 0, &settings(), None);
        assert!(
            !without.webview.contains(' ')
                || matches!(
                    without.webview.as_str(),
                    "WKWebView" | "WebView2" | "WebKitGTK"
                ),
            "unexpected webview string without version: {}",
            without.webview
        );
    }

    #[test]
    fn feature_flags_always_include_build_kind() {
        let snap = baseline();
        let has_build = snap.feature_flags.iter().any(|f| f.starts_with("build:"));
        assert!(
            has_build,
            "expected a build:* flag in {:?}",
            snap.feature_flags
        );
    }

    #[test]
    fn settings_dump_omits_unset_fields() {
        // Default AppSettings has every field as None — the dump should
        // be empty save for the `defaultPlansRootSet: false` marker.
        let snap = baseline();
        assert_eq!(snap.settings.len(), 1, "got: {:?}", snap.settings);
        assert_eq!(
            snap.settings.get("defaultPlansRootSet"),
            Some(&serde_json::Value::Bool(false))
        );
        assert!(snap.markdown.contains("defaultPlansRootSet: false"));
    }

    #[test]
    fn settings_dump_includes_user_overrides() {
        let s = AppSettings {
            theme: Some("midnight".to_string()),
            default_reader_mode: Some("split".to_string()),
            ui_size: Some(15),
            show_line_blame: Some(true),
            default_trust_policy: Some(DefaultTrustPolicy::Untrust),
            ..AppSettings::default()
        };

        let snap = gather(true, Some(TrustDecision::Trusted), 1, &s, None);
        let settings = &snap.settings;
        assert_eq!(settings["theme"], "midnight");
        assert_eq!(settings["defaultReaderMode"], "split");
        assert_eq!(settings["uiSize"], 15);
        assert_eq!(settings["showLineBlame"], true);
        assert_eq!(settings["defaultTrustPolicy"], "alwaysUntrust");
        // Unset fields stay out of the dump.
        assert!(!settings.contains_key("bodySize"));
        assert!(!settings.contains_key("density"));

        let md = &snap.markdown;
        assert!(md.contains("theme: midnight"));
        assert!(md.contains("defaultReaderMode: split"));
        assert!(md.contains("uiSize: 15"));
        assert!(md.contains("defaultTrustPolicy: alwaysUntrust"));
    }

    #[test]
    fn settings_dump_replaces_default_plans_root_with_bool() {
        let set = AppSettings {
            default_plans_root: Some(PathBuf::from("/Users/alice/Documents/Projects")),
            ..AppSettings::default()
        };
        let snap = gather(true, Some(TrustDecision::Trusted), 1, &set, None);
        assert!(!snap.settings.contains_key("defaultPlansRoot"));
        assert_eq!(snap.settings["defaultPlansRootSet"], true);

        let unset = AppSettings::default();
        let snap2 = gather(true, Some(TrustDecision::Trusted), 1, &unset, None);
        assert_eq!(snap2.settings["defaultPlansRootSet"], false);
    }

    #[test]
    fn windows_open_count_is_reflected() {
        let snap = gather(true, Some(TrustDecision::Trusted), 3, &settings(), None);
        assert_eq!(snap.windows_open, 3);
        assert!(snap.markdown.contains("windows_open: 3"));
    }
}
