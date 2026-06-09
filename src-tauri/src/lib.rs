mod app_icon;
mod collab;
mod commands;
mod config;
mod diagnostics;
mod doc_ops;
mod fonts;
mod git_actions;
mod git_diff;
mod git_runner;
mod gtk_menu_theme;
mod images;
mod pins;
mod search;
mod state;
mod terminal;
mod watcher;
mod win_dark_mode;
mod workspace_trust;

use std::path::PathBuf;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::image::Image;
use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::path::BaseDirectory;
use tauri::{
    Emitter, LogicalPosition, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Wrapper that keeps the themes-folder filesystem watcher alive for
/// the duration of the app. The watcher emits `themes-changed`
/// (app-wide) whenever a `.json` file in `<app_config_dir>/themes/`
/// is created, modified, or removed.
struct ThemesWatcher {
    _watcher: RecommendedWatcher,
}

const OPEN_RECENT_PROJECT_PREFIX: &str = "open_recent_project_";
const APP_MENU_ACTION_PREFIX: &str = "app:";
const INSTALL_TERMINAL_COMMAND_ID: &str = "install_terminal_command";
const TERMINAL_COMMAND_NAME: &str = "specrider";
const TERMINAL_COMMAND_MARKER: &str = "# Installed by SpecRider.";
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 16.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_Y: f64 = 22.0;

use commands::AnalyzeCache;
use config::{AppConfig, ConfigState};
use state::{SettingsContext, WindowsState};
use terminal::TerminalManager;

fn env_var_missing_or_empty(key: &str) -> bool {
    std::env::var_os(key).is_none_or(|value| value.is_empty())
}

fn ensure_utf8_character_locale() {
    if ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .all(|key| env_var_missing_or_empty(key))
    {
        #[cfg(target_os = "macos")]
        std::env::set_var("LC_CTYPE", "UTF-8");
        #[cfg(all(unix, not(target_os = "macos")))]
        std::env::set_var("LANG", "C.UTF-8");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_utf8_character_locale();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Native clipboard. Used by `Help → Copy Diagnostics` because the
        // web Clipboard API requires a direct webview gesture that the
        // menu-action IPC path doesn't preserve on WKWebView.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Auto-update over GitHub Releases. Endpoint + pubkey live in
        // `tauri.conf.json`'s `plugins.updater` block — the Builder
        // doesn't expose endpoint overrides at startup, so the smoke
        // script reaches into `pnpm tauri dev --config '{...}'` instead
        // (see `scripts/updater-smoke.sh`).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            // Exclude VISIBLE from the restored state flags. The plugin
            // would otherwise force-show the window during restore on
            // launch, instantly overriding the `visible: false` in
            // tauri.conf.json that our hide-until-painted dance depends
            // on. Position/size/maximized/decorations/fullscreen still
            // get restored, except decorations because macOS traffic-light
            // positioning requires decorated windows. Visibility is left for our
            // `show_window` command to control.
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        // Custom protocol that serves cached woff2 files from
        // `<app_config>/fonts/<slug>/<file>`. Used by the offline font
        // cache so the user's picked Google Fonts work without network.
        .register_uri_scheme_protocol("specrider-font", |ctx, request| {
            let app = ctx.app_handle();
            let uri = request.uri().to_string();
            // Tauri 2 normalizes custom protocols to include `localhost`
            // on macOS / Linux: `specrider-font://localhost/<slug>/<file>`.
            // Strip both forms defensively.
            let path = uri
                .strip_prefix("specrider-font://localhost/")
                .or_else(|| uri.strip_prefix("specrider-font://"))
                .unwrap_or("");
            let mut parts = path.splitn(2, '/');
            let slug = parts.next().unwrap_or("");
            let file = parts.next().unwrap_or("");
            if slug.is_empty() || file.is_empty() {
                return tauri::http::Response::builder()
                    .status(400)
                    .body(Vec::new())
                    .unwrap();
            }
            match fonts::read_font_asset(app, slug, file) {
                Some(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "font/woff2")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        // Plans-root-scoped image protocol. Authors reference
        // `![](./img/foo.png)` and the renderer turns it into
        // `specrider-img://localhost/<percent-encoded-path>`. We
        // resolve against the requesting webview's plans root and
        // refuse anything that escapes via `..` or symlink traversal.
        .register_uri_scheme_protocol("specrider-img", |ctx, request| {
            let app = ctx.app_handle();
            let webview = ctx.webview_label();
            let uri = request.uri().to_string();
            let raw = uri
                .strip_prefix("specrider-img://localhost/")
                .or_else(|| uri.strip_prefix("specrider-img://"))
                .unwrap_or("");
            // The webview encodes the resolved plans-root-relative
            // path with `encodeURIComponent`; decode before resolving.
            let decoded = match urlencoding::decode(raw) {
                Ok(s) => s.into_owned(),
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(400)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            if decoded.is_empty() {
                return tauri::http::Response::builder()
                    .status(400)
                    .body(Vec::new())
                    .unwrap();
            }
            match images::read_image_for_webview(app, webview, &decoded) {
                Some((bytes, mime)) => tauri::http::Response::builder()
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_plans_root,
            commands::set_plans_root,
            commands::get_settings_workspace_root,
            commands::set_window_title,
            commands::open_single_file,
            commands::export_with_dialog,
            commands::list_recent_projects,
            commands::list_plans,
            commands::analyze_plans,
            commands::read_plan,
            commands::write_plan,
            commands::get_settings,
            commands::set_setting,
            commands::set_app_icon,
            commands::reset_settings,
            commands::show_window,
            commands::updater_install_kind,
            commands::relaunch_app,
            commands::list_custom_themes,
            commands::set_menu_theme,
            commands::set_window_dark_mode,
            collab::workspace_config::get_workspace_config,
            collab::workspace_config::read_workspace_config_source,
            collab::workspace_config::write_workspace_config,
            collab::workspace_config::write_workspace_config_source,
            fonts::cache_font,
            fonts::read_cached_font,
            search::search_plans,
            git_diff::diff_plan,
            git_diff::list_changed_plans,
            git_diff::blame_plan,
            git_diff::commit_meta,
            git_diff::git_branch,
            git_diff::git_has_uncommitted,
            git_diff::git_log_graph,
            git_diff::git_refs,
            git_diff::git_show_commit_file,
            git_diff::git_show_commit_files,
            git_diff::git_show_commit,
            git_diff::git_status_unstaged,
            git_actions::git_status,
            git_actions::git_init,
            git_actions::git_branches,
            git_actions::git_checkout,
            git_actions::git_create_branch,
            git_actions::git_commit,
            git_actions::git_discard_file,
            git_actions::git_pull,
            git_actions::git_push,
            git_actions::git_abort_merge,
            git_actions::git_fetch,
            git_actions::git_get_per_root_settings,
            git_actions::git_set_per_root_settings,
            workspace_trust::get_workspace_trust,
            workspace_trust::set_workspace_trust,
            doc_ops::move_plan,
            doc_ops::rename_plan,
            doc_ops::delete_plan,
            doc_ops::duplicate_plan,
            doc_ops::create_plan,
            doc_ops::reveal_plan,
            doc_ops::open_plan_in_new_window,
            doc_ops::get_initial_state,
            doc_ops::create_folder,
            doc_ops::move_folder,
            doc_ops::rename_folder,
            doc_ops::delete_folder,
            terminal::terminal_start,
            terminal::terminal_resolve_cwd,
            terminal::terminal_write,
            terminal::terminal_set_cwd,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_replay,
            terminal::list_terminal_sessions,
            pins::get_pins,
            pins::toggle_plan_pin,
            pins::toggle_section_pin,
            diagnostics::diagnostics_snapshot,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            let mut cfg = AppConfig::load(&app_handle);

            // Re-apply the persisted icon variant. An app update that
            // replaces the bundle (DMG drag, Sparkle) wipes the
            // NSWorkspace custom-icon override, so we re-run it on
            // every launch when the user has chosen a non-default
            // variant.
            if let Some(variant) = cfg.settings.app_icon.as_deref() {
                app_icon::apply_async(&app_handle, variant);
            }

            // Override hierarchy for the *main* window only (additional
            // windows are user-driven via File → New Window):
            //   1. SPECRIDER_PLANS_ROOT env var
            //   2. argv positional that resolves to a directory
            //   3. saved per-window config
            //   4. <cwd>/docs/plans on first run, if it exists (dogfood)
            let override_path = override_from_env_or_argv();
            let main_root_missing = cfg
                .for_window("main")
                .is_none_or(|w| w.plans_root.is_none());
            if let Some(p) = override_path {
                cfg.set_root_for("main", Some(p));
                let _ = cfg.save(&app_handle);
            } else if main_root_missing {
                if let Ok(cwd) = std::env::current_dir() {
                    let candidate = cwd.join("docs").join("plans");
                    if candidate.is_dir() {
                        cfg.set_root_for("main", Some(candidate));
                        let _ = cfg.save(&app_handle);
                    }
                }
            }

            if cfg.recent_project_roots.is_empty() {
                let mut saved_roots: Vec<(String, PathBuf)> = cfg
                    .windows
                    .iter()
                    .filter_map(|(label, window_cfg)| {
                        window_cfg
                            .plans_root
                            .as_ref()
                            .filter(|root| root.is_dir())
                            .map(|root| (label.clone(), root.clone()))
                    })
                    .collect();
                saved_roots.sort_by(|a, b| a.0.cmp(&b.0));
                let mut changed = false;
                for (_, root) in saved_roots.into_iter().rev() {
                    changed |= cfg.remember_recent_project_root(root);
                }
                if changed {
                    let _ = cfg.save(&app_handle);
                }
            }

            let windows_state = WindowsState::new();

            // Bootstrap saved per-window state in-memory (plans root +
            // watcher) for *all* labels — including ones whose webview
            // window doesn't yet exist (we'll spawn those just below).
            let saved_windows: Vec<(String, Option<PathBuf>)> = cfg
                .windows
                .iter()
                .map(|(l, c)| (l.clone(), c.plans_root.clone()))
                .collect();

            for (label, root) in &saved_windows {
                let ws = windows_state.get_or_create(label);
                if let Some(root) = root.clone() {
                    *ws.plans_root.lock().unwrap() = Some(root.clone());
                    if let Err(e) = ws.watcher.watch_for(&app_handle, label.clone(), root) {
                        eprintln!("watcher init failed for {label}: {e}");
                    }
                }
            }

            app.manage(ConfigState(Mutex::new(cfg)));
            app.manage(windows_state);
            app.manage(SettingsContext::new());
            app.manage(AnalyzeCache::new());
            app.manage(git_diff::DiffCache::new());
            app.manage(git_diff::BlameCache::new());
            app.manage(git_diff::CommitMetaCache::new());
            app.manage(git_diff::CommitDetailCache::new());
            app.manage(git_diff::UnstagedDetailCache::new());
            app.manage(git_diff::CommitGraphCache::new());
            app.manage(TerminalManager::new());

            // Themes live in <app_config_dir>/themes/ so they survive
            // plansRoot changes and aren't tied to a project. Spin up a
            // watcher so picker UIs pick up edits within a second.
            if let Ok(config_dir) = app_handle.path().app_config_dir() {
                let themes_dir = config_dir.join("themes");
                let _ = std::fs::create_dir_all(&themes_dir);
                let app_for_themes = app_handle.clone();
                if let Ok(mut watcher) =
                    notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                        if let Ok(event) = res {
                            for path in &event.paths {
                                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                                    let _ = app_for_themes.emit("themes-changed", ());
                                    return;
                                }
                            }
                        }
                    })
                {
                    if watcher
                        .watch(&themes_dir, RecursiveMode::NonRecursive)
                        .is_ok()
                    {
                        app.manage(ThemesWatcher { _watcher: watcher });
                    }
                }
            }

            install_menu(app)?;

            // Auto-restore: re-spawn every saved window whose webview
            // doesn't already exist (Tauri creates the "main" one for
            // us; everything else is on us). tauri-plugin-window-state
            // restores each one's position and size automatically.
            let existing = app.webview_windows();
            for (label, _) in &saved_windows {
                if existing.contains_key(label) {
                    continue;
                }
                if let Err(e) = spawn_window(&app_handle, label, None, None) {
                    eprintln!("auto-restore window {label} failed: {e}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            let app = window.app_handle();
            let closing_label = window.label();

            // Tear down any PTY-backed terminal sessions bound to the
            // closing window so we don't leak shells / agent processes.
            let term_state: tauri::State<'_, TerminalManager> = app.state();
            term_state.close_window(closing_label);

            // Refresh the Window submenu so the closing window drops out
            // of the dynamic switcher list.
            rebuild_menu(app);

            // If Settings was bound to the closing workspace window, drop
            // the binding so it falls back to the empty state instead of
            // editing config for a window that no longer exists.
            let ctx: tauri::State<'_, SettingsContext> = app.state();
            let was_bound = {
                let mut source = ctx.source_label.lock().unwrap();
                if source.as_deref() == Some(closing_label) {
                    *source = None;
                    true
                } else {
                    false
                }
            };
            if was_bound {
                if let Some(settings_win) = app.get_webview_window("settings") {
                    let _ = settings_win.emit("settings-workspace-changed", None::<String>);
                }
            }

            // Drop the closed window from the persisted config so it
            // doesn't get auto-restored on next launch. Only windows
            // still open at quit time should reappear.
            let cfg_state: tauri::State<'_, config::ConfigState> = app.state();
            let keep = {
                let mut cfg = cfg_state.0.lock().unwrap();
                if cfg.windows.remove(closing_label).is_some() {
                    let _ = cfg.save(app);
                }
                cfg.settings.keep_app_alive.unwrap_or(true)
            };

            // Honor the user's `keepAppAlive` setting on macOS, where the
            // OS default is to keep the process running even when every
            // window has closed. When the setting is false, exit the app
            // as soon as the last window goes away. (Linux/Windows
            // already exit on last close by default.)
            if keep {
                return;
            }
            // Count windows still alive — exclude the one that just got destroyed.
            let remaining = app
                .webview_windows()
                .keys()
                .filter(|l| l.as_str() != closing_label)
                .count();
            if remaining == 0 {
                app.exit(0);
            }
        })
        .on_menu_event(|app, event| {
            let label = event.id().0.as_str().to_string();
            match label.as_str() {
                "open_plans_folder" => open_plans_folder(app.clone()),
                "open_file" => open_markdown_file(app.clone()),
                "reveal_plans_folder" => reveal_plans_folder(app.clone()),
                "new_window" => {
                    // If the user has a default plans root configured in
                    // Settings, the new window opens there. Otherwise it
                    // lands on the Choose-folder empty state.
                    let default_root = {
                        let cfg_state: tauri::State<'_, ConfigState> = app.state();
                        let cfg = cfg_state.0.lock().unwrap();
                        cfg.settings.default_plans_root.clone()
                    };
                    let initial = default_root.filter(|p| p.is_dir());
                    if let Err(e) = spawn_new_window(app.clone(), initial, None) {
                        eprintln!("spawn_new_window failed: {e}");
                    }
                }
                "open_in_new_window" => open_in_new_window(app.clone()),
                "clear_recent_projects" => clear_recent_projects(app.clone()),
                "open_settings" => open_settings_window(app.clone()),
                INSTALL_TERMINAL_COMMAND_ID => install_terminal_command(app.clone()),
                s if s.starts_with(OPEN_RECENT_PROJECT_PREFIX) => {
                    let index = s[OPEN_RECENT_PROJECT_PREFIX.len()..].parse::<usize>().ok();
                    if let Some(index) = index {
                        open_recent_project(app.clone(), index);
                    }
                }
                s if s.starts_with("select_window_") => {
                    let target = &s["select_window_".len()..];
                    if let Some(win) = app.get_webview_window(target) {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                s if s.starts_with(APP_MENU_ACTION_PREFIX) => {
                    let action = &s[APP_MENU_ACTION_PREFIX.len()..];
                    emit_menu_action(app, action);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Picks up `SPECRIDER_PLANS_ROOT`, then the first non-flag argv entry
/// that resolves to a directory. Returns `None` if nothing usable found.
fn override_from_env_or_argv() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("SPECRIDER_PLANS_ROOT") {
        let p = PathBuf::from(v);
        if p.is_dir() {
            return Some(p);
        }
    }
    let args: Vec<String> = std::env::args().collect();
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let p = PathBuf::from(arg);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let (menu, help_menu) = build_menu(&app.handle().clone())?;
    app.set_menu(menu)?;
    mark_help_menu(&help_menu);
    Ok(())
}

/// Rebuilds the menu — used after a window is created or destroyed so
/// the Window submenu reflects the live set.
pub(crate) fn rebuild_menu(app: &tauri::AppHandle) {
    match build_menu(app) {
        Ok((menu, help_menu)) => {
            if let Err(e) = app.set_menu(menu) {
                eprintln!("set_menu failed: {e}");
                return;
            }
            mark_help_menu(&help_menu);
        }
        Err(e) => eprintln!("build_menu failed: {e}"),
    }
}

/// macOS draws a search field at the top of whichever submenu is
/// registered as the help menu. The registration is per-NSMenu, so it
/// has to be re-applied every time the menu bar is rebuilt. On other
/// platforms there's no system equivalent — we ship our own palette
/// instead and this is a no-op.
fn mark_help_menu(_help_menu: &tauri::menu::Submenu<tauri::Wry>) {
    #[cfg(target_os = "macos")]
    if let Err(e) = _help_menu.set_as_help_menu_for_nsapp() {
        eprintln!("set_as_help_menu_for_nsapp failed: {e}");
    }
}

fn build_menu(
    app: &tauri::AppHandle,
) -> tauri::Result<(
    tauri::menu::Menu<tauri::Wry>,
    tauri::menu::Submenu<tauri::Wry>,
)> {
    // The About panel needs a full-resolution icon — Tauri's
    // default_window_icon resolves to the 32×32 entry in the icon
    // array, which the panel scales up and renders pixelated. Load
    // the active variant's bundled 1024×1024 PNG instead.
    let about_metadata = AboutMetadataBuilder::new()
        .icon(load_about_icon(app))
        .build();
    let about = PredefinedMenuItem::about(app, Some("About SpecRider"), Some(about_metadata))?;
    // Standard macOS app-menu convention is About → (separator) →
    // Check for Updates… → Settings → (separator) → Services → ….
    // We follow the same order on Linux/Windows; on platforms that
    // don't support auto-updates the action emits an "informational"
    // event that surfaces the static "manual download" link instead
    // of running a real check.
    let check_for_updates = app_action_item(app, "Check for Updates…", "check-for-updates", None)?;
    let settings = MenuItemBuilder::new("Settings…")
        .id("open_settings")
        .accelerator("CmdOrCtrl+Comma")
        .build(app)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let separator = || PredefinedMenuItem::separator(app);

    let app_menu = SubmenuBuilder::new(app, "SpecRider")
        .item(&about)
        .item(&check_for_updates)
        .item(&separator()?)
        .item(&settings)
        .item(&separator()?)
        .item(&services)
        .item(&separator()?)
        .item(&hide)
        .item(&hide_others)
        .item(&show_all)
        .item(&separator()?)
        .item(&quit)
        .build()?;

    let new_window = MenuItemBuilder::new("New Window")
        .id("new_window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let open_plans = MenuItemBuilder::new("Open Folder…")
        .id("open_plans_folder")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_file = MenuItemBuilder::new("Open File…")
        .id("open_file")
        .accelerator("CmdOrCtrl+Alt+O")
        .build(app)?;
    let open_in_new = MenuItemBuilder::new("Open Folder in New Window…")
        .id("open_in_new_window")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let open_recent = build_open_recent_menu(app)?;
    let reveal_plans = MenuItemBuilder::new("Reveal Plans Folder in Finder")
        .id("reveal_plans_folder")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(app)?;
    let close_window = PredefinedMenuItem::close_window(app, None)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .item(&separator()?)
        .item(&open_file)
        .item(&open_plans)
        .item(&open_in_new)
        .item(&open_recent)
        .item(&separator()?)
        .item(&reveal_plans)
        .item(&separator()?)
        .item(&close_window)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = build_view_menu(app)?;
    let go_menu = build_go_menu(app)?;

    let window_menu = build_window_menu(app)?;
    let help_menu = build_help_menu(app)?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&go_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    Ok((menu, help_menu))
}

fn build_help_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    // macOS injects its own search field at the top of the help menu
    // (see `mark_help_menu`); other platforms get just the link.
    let help_link = app_action_item(app, "SpecRider Help", "open-help", None)?;
    let copy_diagnostics = app_action_item(app, "Copy Diagnostics", "copy-diagnostics", None)?;
    let separator = || PredefinedMenuItem::separator(app);

    let mut builder = SubmenuBuilder::new(app, "Help")
        .item(&help_link)
        .item(&separator()?);

    #[cfg(unix)]
    {
        let install_terminal_command = MenuItemBuilder::new("Install Terminal Command...")
            .id(INSTALL_TERMINAL_COMMAND_ID)
            .build(app)?;
        builder = builder.item(&install_terminal_command).item(&separator()?);
    }

    builder.item(&copy_diagnostics).build()
}

/// Build a menu item bound to an app-side action. The `action` becomes
/// the suffix of an `app:` menu id; clicking it (or hitting the
/// optional accelerator) emits a `menu-action` event with the action
/// name to the focused webview, where the React handler routes it.
fn app_action_item(
    app: &tauri::AppHandle,
    label: &str,
    action: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    let mut builder = MenuItemBuilder::new(label).id(format!("{APP_MENU_ACTION_PREFIX}{action}"));
    if let Some(accel) = accelerator {
        builder = builder.accelerator(accel);
    }
    builder.build(app)
}

fn build_view_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let cycle_mode = app_action_item(app, "Cycle Reader Mode", "cycle-mode", Some("CmdOrCtrl+E"))?;
    let mode_read = app_action_item(app, "Read Mode", "mode-read", None)?;
    let mode_edit = app_action_item(app, "Edit Mode", "mode-edit", None)?;
    let mode_split = app_action_item(app, "Split Mode", "mode-split", None)?;
    let toggle_terminal = app_action_item(
        app,
        "Toggle Terminal Pane",
        "toggle-terminal",
        Some("Ctrl+`"),
    )?;
    let toggle_diff =
        app_action_item(app, "Toggle Diff Pane", "toggle-diff", Some("Ctrl+Shift+`"))?;
    let toggle_popover = app_action_item(
        app,
        "Toggle Inline Diff",
        "toggle-popover",
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let toggle_blame = app_action_item(
        app,
        "Toggle Line Blame",
        "toggle-blame",
        Some("CmdOrCtrl+Shift+B"),
    )?;
    let fold_toggle = app_action_item(
        app,
        "Fold/Unfold All Sections",
        "fold-toggle",
        Some("CmdOrCtrl+Alt+."),
    )?;
    let zoom_in = app_action_item(app, "Zoom In", "zoom-in", Some("CmdOrCtrl+="))?;
    let zoom_out = app_action_item(app, "Zoom Out", "zoom-out", Some("CmdOrCtrl+-"))?;
    let zoom_reset = app_action_item(app, "Reset Zoom", "zoom-reset", Some("CmdOrCtrl+0"))?;
    let separator = || PredefinedMenuItem::separator(app);

    SubmenuBuilder::new(app, "View")
        .item(&cycle_mode)
        .item(&mode_read)
        .item(&mode_edit)
        .item(&mode_split)
        .item(&separator()?)
        .item(&toggle_terminal)
        .item(&toggle_diff)
        .item(&toggle_popover)
        .item(&toggle_blame)
        .item(&separator()?)
        .item(&fold_toggle)
        .item(&separator()?)
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .fullscreen()
        .build()
}

fn build_go_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let back = app_action_item(app, "Back", "back", Some("CmdOrCtrl+["))?;
    let forward = app_action_item(app, "Forward", "forward", Some("CmdOrCtrl+]"))?;
    let next_change = app_action_item(app, "Next Change", "next-hunk", Some("CmdOrCtrl+Shift+J"))?;
    let prev_change = app_action_item(
        app,
        "Previous Change",
        "prev-hunk",
        Some("CmdOrCtrl+Shift+K"),
    )?;
    // No accelerators on these two — they're context-sensitive in the
    // webview (CodeMirror owns ⌘F when focused; ⌘T must defer inside
    // form fields). The in-app keydown handler still routes them; the
    // menu item is here for discoverability and click-to-activate.
    let quick_switch = app_action_item(app, "Quick Switch…", "quick-switch", None)?;
    let find_in_doc = app_action_item(app, "Find in Document…", "find-in-doc", None)?;
    let find_in_project = app_action_item(
        app,
        "Find in Project…",
        "find-in-project",
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let uncommitted = app_action_item(
        app,
        "Open Uncommitted Changes",
        "uncommitted",
        Some("CmdOrCtrl+Shift+G"),
    )?;
    let separator = || PredefinedMenuItem::separator(app);

    SubmenuBuilder::new(app, "Go")
        .item(&back)
        .item(&forward)
        .item(&separator()?)
        .item(&next_change)
        .item(&prev_change)
        .item(&separator()?)
        .item(&quick_switch)
        .item(&find_in_doc)
        .item(&find_in_project)
        .item(&separator()?)
        .item(&uncommitted)
        .build()
}

fn build_open_recent_menu(
    app: &tauri::AppHandle,
) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let recent_roots = {
        let cfg_state: tauri::State<'_, ConfigState> = app.state();
        let cfg = cfg_state.0.lock().unwrap();
        cfg.recent_project_roots.clone()
    };

    let mut builder = SubmenuBuilder::new(app, "Open Recent");
    if recent_roots.is_empty() {
        let empty = MenuItemBuilder::new("No Recent Folders")
            .enabled(false)
            .build(app)?;
        return builder.item(&empty).build();
    }

    let mut items = Vec::with_capacity(recent_roots.len());
    for (index, root) in recent_roots.iter().enumerate() {
        let title = escape_menu_text(&recent_project_title(root));
        let item = MenuItemBuilder::new(title)
            .id(format!("{OPEN_RECENT_PROJECT_PREFIX}{index}"))
            .build(app)?;
        items.push(item);
    }
    for item in &items {
        builder = builder.item(item);
    }

    let separator = PredefinedMenuItem::separator(app)?;
    let clear = MenuItemBuilder::new("Clear Menu")
        .id("clear_recent_projects")
        .build(app)?;
    builder.item(&separator).item(&clear).build()
}

fn recent_project_title(root: &std::path::Path) -> String {
    let project = project_name_from_path(root).unwrap_or_else(|| {
        root.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Project")
            .to_string()
    });
    format!("{project} ({})", display_path(root))
}

pub(crate) fn display_path(path: &std::path::Path) -> String {
    if let Some(home) = home_dir() {
        if let Ok(stripped) = path.strip_prefix(&home) {
            if stripped.as_os_str().is_empty() {
                return "~".to_string();
            }
            return format!("~/{}", stripped.to_string_lossy());
        }
    }
    path.to_string_lossy().into_owned()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn escape_menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

/// Derive the project dir name from a plans-root path — mirrors
/// `projectNameFromPath` in `src/App.tsx`. Walks up past wrapper
/// segments like `plans` / `docs` / `doc` so the menu shows the
/// actual project (e.g. `specrider`) rather than the wrapper.
pub(crate) fn project_name_from_path(root: &std::path::Path) -> Option<String> {
    let segments: Vec<&str> = root
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        return None;
    }
    let wrappers = ["plans", "docs", "doc"];
    let mut i = segments.len() - 1;
    while i > 0 && wrappers.contains(&segments[i]) {
        i -= 1;
    }
    Some(segments[i].to_string())
}

/// Window submenu — Minimize / Zoom on top, then a dynamic list of
/// every open window labeled by the project dir name (derived from
/// each window's plans_root, matching the OS title bar).
fn build_window_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let mut builder = SubmenuBuilder::new(app, "Window").minimize().maximize();

    let windows_state = app.state::<WindowsState>();

    let mut entries: Vec<(String, String)> = app
        .webview_windows()
        .into_keys()
        .map(|label| {
            let display = if label == "settings" {
                "Settings".to_string()
            } else {
                let ws = windows_state.get_or_create(&label);
                let root = ws.plans_root.lock().unwrap().clone();
                root.as_deref()
                    .and_then(project_name_from_path)
                    .unwrap_or_else(|| label.clone())
            };
            (label, display)
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    if !entries.is_empty() {
        let sep = PredefinedMenuItem::separator(app)?;
        builder = builder.item(&sep);
        // Build items into a vec first so each one's lifetime extends
        // through the .item(&item) calls below.
        let mut items = Vec::with_capacity(entries.len());
        for (label, display) in &entries {
            let item = MenuItemBuilder::new(display)
                .id(format!("select_window_{label}"))
                .build(app)?;
            items.push(item);
        }
        for item in &items {
            builder = builder.item(item);
        }
        builder.build()
    } else {
        builder.build()
    }
}

/// Load the bundled high-resolution icon for the currently-selected
/// variant. Falls back to "default" when no variant is configured,
/// and returns None when the file can't be read so the About panel
/// degrades to macOS's NSApp.applicationIconImage instead of the
/// pixelated default-window-icon.
fn load_about_icon(app: &tauri::AppHandle) -> Option<Image<'static>> {
    let variant = {
        let cfg_state: tauri::State<'_, ConfigState> = app.state();
        let cfg = cfg_state.0.lock().unwrap();
        cfg.settings
            .app_icon
            .clone()
            .unwrap_or_else(|| "default".to_string())
    };
    let path = app
        .path()
        .resolve(
            format!("icons/variants/{variant}.png"),
            BaseDirectory::Resource,
        )
        .ok()?;
    Image::from_path(path).ok()
}

/// Forward a menu-driven action to the focused webview as a
/// `menu-action` event. Settings windows ignore document actions —
/// only the main / project windows route them. The React listener
/// switches on the payload and runs the equivalent in-app callback.
///
/// One exception: `check-for-updates` routes to `main` regardless of
/// the focused window. The updater capability is only granted to
/// `main` (see `capabilities/updater.json`), so a check kicked off
/// from the Settings window or a project sub-window has nowhere else
/// to land. This matches the macOS-app convention where Check for
/// Updates… is always responsive no matter which window has focus.
fn emit_menu_action(app: &tauri::AppHandle, action: &str) {
    if action == "check-for-updates" {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("menu-action", action.to_string());
        }
        return;
    }
    let label = focused_window_label(app);
    if label == "settings" {
        return;
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.emit("menu-action", action.to_string());
    }
}

fn focused_window_label(app: &tauri::AppHandle) -> String {
    for (label, win) in app.webview_windows() {
        if win.is_focused().unwrap_or(false) {
            return label;
        }
    }
    "main".to_string()
}

fn open_plans_folder(app: tauri::AppHandle) {
    let label = focused_window_label(&app);
    if label == "settings" {
        return; // Settings window has no plans context
    }
    let app_for_callback = app.clone();
    app.dialog().file().pick_folder(move |chosen| {
        let Some(file_path) = chosen else { return };
        let Ok(path) = file_path.into_path() else {
            return;
        };
        if let Err(e) = commands::apply_plans_root(&app_for_callback, &label, path) {
            eprintln!("apply_plans_root failed: {e}");
        }
    });
}

/// Pick a single Markdown file, set the plans-root to its parent dir,
/// and seed `pending_initial_plan` with the filename so the file is
/// auto-selected on the next refresh. The parent dir as workspace lets
/// the existing browser / outline / save logic work unchanged.
fn open_markdown_file(app: tauri::AppHandle) {
    let label = focused_window_label(&app);
    if label == "settings" {
        return;
    }
    let app_for_callback = app.clone();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .pick_file(move |chosen| {
            let Some(file_path) = chosen else { return };
            let Ok(path) = file_path.into_path() else {
                return;
            };
            let Some(parent) = path.parent().map(std::path::Path::to_path_buf) else {
                eprintln!("open_markdown_file: file has no parent: {}", path.display());
                return;
            };
            let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
                eprintln!("open_markdown_file: invalid file name: {}", path.display());
                return;
            };
            if let Err(e) = commands::apply_plans_root_with_initial_plan(
                &app_for_callback,
                &label,
                parent,
                filename.to_string(),
            ) {
                eprintln!("apply_plans_root_with_initial_plan failed: {e}");
            }
        });
}

fn reveal_plans_folder(app: tauri::AppHandle) {
    let label = focused_window_label(&app);
    if label == "settings" {
        return;
    }
    let windows_state: tauri::State<'_, WindowsState> = app.state();
    let ws = windows_state.get_or_create(&label);
    let path = match ws.plans_root.lock().unwrap().clone() {
        Some(p) => p,
        None => return,
    };
    if let Err(e) = app.opener().open_path(path.to_string_lossy(), None::<&str>) {
        eprintln!("reveal failed: {e}");
    }
}

/// Open (or focus) the Settings window. Settings windows aren't tracked
/// in `AppConfig.windows` — they're transient utility windows.
///
/// The window is bound to the workspace window that was focused when the
/// menu action fired: its label is recorded in `SettingsContext` so the
/// Workspace section shows that window's config. Reopening Settings from
/// a different workspace window re-binds and notifies the live window;
/// invoking it while Settings itself has focus keeps the current binding.
fn open_settings_window(app: tauri::AppHandle) {
    let source = focused_window_label(&app);
    if source != "settings" {
        let ctx: tauri::State<'_, SettingsContext> = app.state();
        *ctx.source_label.lock().unwrap() = Some(source);
    }
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.emit(
            "settings-workspace-changed",
            commands::settings_workspace_root(&app),
        );
        let _ = existing.show();
        let _ = existing.set_focus();
        let _ = existing.unminimize();
        return;
    }
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder =
        WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html".into()))
            .title("SpecRider — Settings")
            .inner_size(720.0, 560.0)
            .min_inner_size(560.0, 420.0)
            // Anti-flash: hide until React has applied the theme + the
            // browser has committed a paint, then `show_window` reveals.
            // On macOS we additionally pair `.transparent(true)` with
            // `macOSPrivateApi` to kill WKWebView's opaque-white pre-paint
            // so imperfect timing doesn't show a white flash; on Linux
            // GTK that same flag bleeds through the GtkMenuBar, so we
            // skip it.
            .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .transparent(true)
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y));
    }

    if let Err(e) = builder.build() {
        eprintln!("settings window build failed: {e}");
        return;
    }
    rebuild_menu(&app);
}

/// Pick a folder, then spawn a brand-new window pre-configured to that root.
fn open_in_new_window(app: tauri::AppHandle) {
    let app_for_callback = app.clone();
    app.dialog().file().pick_folder(move |chosen| {
        let Some(file_path) = chosen else { return };
        let Ok(path) = file_path.into_path() else {
            return;
        };
        if let Err(e) = spawn_new_window(app_for_callback.clone(), Some(path), None) {
            eprintln!("spawn_new_window failed: {e}");
        }
    });
}

fn open_recent_project(app: tauri::AppHandle, index: usize) {
    let path = {
        let cfg_state: tauri::State<'_, ConfigState> = app.state();
        let cfg = cfg_state.0.lock().unwrap();
        cfg.recent_project_roots.get(index).cloned()
    };
    let Some(path) = path else { return };

    if !path.is_dir() {
        eprintln!("recent project folder no longer exists: {}", path.display());
        forget_recent_project(&app, &path);
        return;
    }

    let label = focused_window_label(&app);
    if label != "settings" && app.get_webview_window(&label).is_some() {
        if let Err(e) = commands::apply_plans_root(&app, &label, path) {
            eprintln!("apply recent project failed: {e}");
        }
        return;
    }

    if let Err(e) = spawn_new_window(app.clone(), Some(path), None) {
        eprintln!("spawn recent project failed: {e}");
    }
}

fn clear_recent_projects(app: tauri::AppHandle) {
    let result = {
        let cfg_state: tauri::State<'_, ConfigState> = app.state();
        let mut cfg = cfg_state.0.lock().unwrap();
        if cfg.clear_recent_project_roots() {
            cfg.save(&app)
        } else {
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("clear recent projects failed: {e}");
    }
    rebuild_menu(&app);
}

fn install_terminal_command(app: tauri::AppHandle) {
    let (message, kind) = match install_specrider_terminal_command() {
        Ok(path) => (
            format!(
                "Installed `{TERMINAL_COMMAND_NAME}` at:\n{}\n\nTry it from a new terminal with:\n{TERMINAL_COMMAND_NAME} .",
                path.display()
            ),
            tauri_plugin_dialog::MessageDialogKind::Info,
        ),
        Err(e) => (
            format!("Could not install `{TERMINAL_COMMAND_NAME}`:\n{e}"),
            tauri_plugin_dialog::MessageDialogKind::Error,
        ),
    };

    app.dialog()
        .message(message)
        .title("SpecRider")
        .kind(kind)
        .show(|_| {});
}

#[cfg(unix)]
fn install_specrider_terminal_command() -> Result<PathBuf, String> {
    let script = terminal_command_script()?;
    let dirs = terminal_command_install_dirs();
    if dirs.is_empty() {
        return Err("no suitable install directory found".into());
    }

    let mut errors = Vec::new();
    for dir in dirs {
        match install_terminal_command_at(&dir, &script) {
            Ok(path) => return Ok(path),
            Err(e) if e.contains("already exists") => return Err(e),
            Err(e) => errors.push(e),
        }
    }

    Err(format!(
        "no writable install directory found. Tried:\n{}",
        errors.join("\n")
    ))
}

#[cfg(not(unix))]
fn install_specrider_terminal_command() -> Result<PathBuf, String> {
    Err("terminal command installation is currently supported on macOS and Linux".into())
}

#[cfg(unix)]
fn terminal_command_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    {
        push_unique_path(&mut dirs, PathBuf::from("/usr/local/bin"));
        push_unique_path(&mut dirs, PathBuf::from("/opt/homebrew/bin"));
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(home) = home_dir() {
            push_unique_path(&mut dirs, home.join(".local").join("bin"));
        }
        push_unique_path(&mut dirs, PathBuf::from("/usr/local/bin"));
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.is_absolute() {
                push_unique_path(&mut dirs, dir);
            }
        }
    }

    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

#[cfg(unix)]
fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|p| p == &path) {
        paths.push(path);
    }
}

#[cfg(unix)]
fn install_terminal_command_at(dir: &std::path::Path, script: &str) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let path = dir.join(TERMINAL_COMMAND_NAME);
    if std::fs::symlink_metadata(&path).is_ok() {
        let existing = std::fs::read_to_string(&path).map_err(|_| {
            format!(
                "{} already exists and was not created by SpecRider",
                path.display()
            )
        })?;
        if !existing.contains(TERMINAL_COMMAND_MARKER) {
            return Err(format!(
                "{} already exists and was not created by SpecRider",
                path.display()
            ));
        }
    }

    let tmp = dir.join(format!(
        ".{TERMINAL_COMMAND_NAME}-{}.tmp",
        std::process::id()
    ));
    std::fs::write(&tmp, script).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    let mut perms = std::fs::metadata(&tmp)
        .map_err(|e| format!("metadata {}: {e}", tmp.display()))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&tmp, perms).map_err(|e| format!("chmod {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("install {}: {e}", path.display())
    })?;

    Ok(path)
}

#[cfg(unix)]
fn terminal_command_script() -> Result<String, String> {
    let target_resolution = r#"target="${1:-.}"
if [ ! -d "$target" ]; then
  printf '%s\n' "specrider: not a directory: $target" >&2
  exit 1
fi
target="$(cd "$target" && pwd -P)"
"#;

    #[cfg(target_os = "macos")]
    {
        let bundled_app = current_app_bundle_path()
            .map(|p| shell_quote(&p.to_string_lossy()))
            .unwrap_or_else(|| shell_quote("/Applications/SpecRider.app"));
        Ok(format!(
            "#!/bin/sh\n{TERMINAL_COMMAND_MARKER}\nset -eu\n\n{target_resolution}\napp_path={bundled_app}\nif [ -d \"$app_path\" ]; then\n  open -n \"$app_path\" --args \"$target\"\nelse\n  open -na 'SpecRider' --args \"$target\"\nfi\n"
        ))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let exe =
            std::env::current_exe().map_err(|e| format!("resolve current executable: {e}"))?;
        let exe = shell_quote(&exe.to_string_lossy());
        Ok(format!(
            "#!/bin/sh\n{TERMINAL_COMMAND_MARKER}\nset -eu\n\n{target_resolution}\nexe={exe}\nif [ ! -x \"$exe\" ]; then\n  printf '%s\n' \"specrider: app executable not found: $exe\" >&2\n  exit 1\nfi\nexec \"$exe\" \"$target\"\n"
        ))
    }
}

#[cfg(all(unix, target_os = "macos"))]
fn current_app_bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors() {
        if ancestor.extension().is_some_and(|ext| ext == "app") {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn forget_recent_project(app: &tauri::AppHandle, path: &std::path::Path) {
    let result = {
        let cfg_state: tauri::State<'_, ConfigState> = app.state();
        let mut cfg = cfg_state.0.lock().unwrap();
        if cfg.forget_recent_project_root(path) {
            cfg.save(app)
        } else {
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("forget recent project failed: {e}");
    }
    rebuild_menu(app);
}

/// Spawn a fresh webview window with a brand-new label. If
/// `initial_root` is provided, the window boots up pointed at that
/// directory; otherwise it lands on the empty-state Choose-folder CTA.
pub(crate) fn spawn_new_window(
    app: tauri::AppHandle,
    initial_root: Option<PathBuf>,
    initial_active_plan: Option<String>,
) -> Result<(), String> {
    let label = next_window_label(&app);
    if initial_root.is_none() {
        clear_window_root(&app, &label)?;
    }
    spawn_window(&app, &label, initial_root, initial_active_plan)
}

/// Convenience wrapper invoked by the `open_plan_in_new_window` Tauri
/// command — keeps `doc_ops.rs` from having to know about labels.
pub(crate) fn spawn_new_window_for_plan(
    app: tauri::AppHandle,
    initial_root: Option<PathBuf>,
    initial_active_plan: Option<String>,
) -> Result<(), String> {
    spawn_new_window(app, initial_root, initial_active_plan)
}

/// Underlying spawn that takes an explicit label. Used by:
///   - `spawn_new_window` (next-available label, fresh state)
///   - `open_in_new_window` (next-available label, pre-set root)
///   - `open_plan_in_new_window` (same root + a one-shot active plan)
///   - auto-restore on launch (each saved label, no override)
fn spawn_window(
    app: &tauri::AppHandle,
    label: &str,
    initial_root: Option<PathBuf>,
    initial_active_plan: Option<String>,
) -> Result<(), String> {
    // If an initial root was provided, persist it and prime the
    // watcher *before* the webview boots so the window opens pointed
    // at it instead of going through the empty-state flicker.
    if let Some(root) = initial_root.as_ref() {
        {
            let cfg_state: tauri::State<'_, ConfigState> = app.state();
            let mut cfg = cfg_state.0.lock().unwrap();
            cfg.set_root_for(label, Some(root.clone()));
            cfg.remember_recent_project_root(root.clone());
            cfg.save(app)?;
        }
        let windows_state: tauri::State<'_, WindowsState> = app.state();
        let ws = windows_state.get_or_create(label);
        *ws.plans_root.lock().unwrap() = Some(root.clone());
        ws.watcher
            .watch_for(app, label.to_string(), root.clone())
            .map_err(|e| format!("watch failed: {e}"))?;
    }
    // Deliver the one-shot active plan before React mounts; keep
    // `pending_initial_plan` as the IPC fallback.
    let init_script = match initial_active_plan.as_deref() {
        Some(plan) if !plan.is_empty() => Some(format!(
            "window.__SR_INITIAL_PLAN__ = {};",
            serde_json::to_string(plan).unwrap_or_else(|_| "null".to_string()),
        )),
        _ => None,
    };
    if let Some(plan) = initial_active_plan {
        let windows_state: tauri::State<'_, WindowsState> = app.state();
        let ws = windows_state.get_or_create(label);
        *ws.pending_initial_plan.lock().unwrap() = Some(plan);
    }
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("SpecRider")
        .inner_size(1200.0, 800.0)
        .visible(false)
        // Tauri's default native drag-drop handler swallows HTML5 drag
        // events before they reach JS, breaking in-app drag-and-drop in
        // the Documents browser. Disable it so React's onDragStart /
        // onDrop fire as expected.
        .disable_drag_drop_handler();
    if let Some(script) = init_script {
        builder = builder.initialization_script(&script);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .transparent(true)
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = TitleBarStyle::Overlay;
        let _ = LogicalPosition::new(0.0, 0.0);
    }

    builder.build().map_err(|e| format!("build window: {e}"))?;
    // Refresh the Window submenu so the new window appears in the
    // switcher list right away.
    rebuild_menu(app);
    Ok(())
}

fn clear_window_root(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    {
        let cfg_state: tauri::State<'_, ConfigState> = app.state();
        let mut cfg = cfg_state.0.lock().unwrap();
        cfg.set_root_for(label, None);
        cfg.save(app)?;
    }

    let windows_state: tauri::State<'_, WindowsState> = app.state();
    let ws = windows_state.get_or_create(label);
    *ws.plans_root.lock().unwrap() = None;
    *ws.pending_initial_plan.lock().unwrap() = None;
    ws.watcher.clear();

    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn set_window_title_and_reapply(
    window: tauri::Window,
    title: String,
) -> Result<(), String> {
    let immediate = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(e) = set_native_window_title(&immediate, &title) {
                eprintln!("set native window title failed: {e}");
            }
            if let Err(e) = reapply_traffic_light_position(&immediate) {
                eprintln!("reapply traffic light position failed: {e}");
            }
            schedule_traffic_light_reapply(immediate.clone(), 16);
            schedule_traffic_light_reapply(immediate, 100);
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn set_native_window_title(window: &tauri::Window, title: &str) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::NSString;

    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    let title = NSString::from_str(title);

    unsafe {
        let ns_window: &NSWindow = &*ns_window.cast();
        ns_window.setTitle(&title);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn schedule_traffic_light_reapply(window: tauri::Window, delay_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        let callback_window = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Err(e) = reapply_traffic_light_position(&callback_window) {
                eprintln!("deferred traffic light reapply failed: {e}");
            }
        });
    });
}

#[cfg(target_os = "macos")]
fn reapply_traffic_light_position(window: &tauri::Window) -> Result<(), String> {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    let ns_window = window.ns_window().map_err(|e| e.to_string())?;

    unsafe {
        let ns_window: &NSWindow = &*ns_window.cast();
        let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
            return Ok(());
        };
        let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
        else {
            return Ok(());
        };
        let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton);
        let Some(title_bar_view) = close.superview().and_then(|view| view.superview()) else {
            return Ok(());
        };

        let close_rect = NSView::frame(&close);
        let title_bar_height = close_rect.size.height + TRAFFIC_LIGHT_Y;
        let mut title_bar_rect = NSView::frame(&title_bar_view);
        title_bar_rect.size.height = title_bar_height;
        title_bar_rect.origin.y = ns_window.frame().size.height - title_bar_height;
        title_bar_view.setFrame(title_bar_rect);

        let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
        let mut buttons = vec![close, miniaturize];
        if let Some(zoom) = zoom {
            buttons.push(zoom);
        }

        for (i, button) in buttons.into_iter().enumerate() {
            let mut rect = NSView::frame(&button);
            rect.origin.x = TRAFFIC_LIGHT_X + (i as f64 * space_between);
            button.setFrameOrigin(rect.origin);
        }
    }

    Ok(())
}

fn next_window_label(app: &tauri::AppHandle) -> String {
    let existing = app.webview_windows();
    let mut n = 2;
    loop {
        let candidate = format!("window-{n}");
        if !existing.contains_key(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(
            shell_quote("/tmp/SpecRider's App.app"),
            "'/tmp/SpecRider'\\''s App.app'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn terminal_command_script_contains_marker_and_command_name() {
        let script = terminal_command_script().unwrap();
        assert!(script.contains(TERMINAL_COMMAND_MARKER));
        assert!(script.contains("specrider: not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn install_terminal_command_at_refuses_unowned_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TERMINAL_COMMAND_NAME);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();

        let err = install_terminal_command_at(dir.path(), "replacement").unwrap_err();

        assert!(err.contains("already exists"));
    }

    #[cfg(unix)]
    #[test]
    fn install_terminal_command_at_replaces_owned_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TERMINAL_COMMAND_NAME);
        std::fs::write(&path, format!("{TERMINAL_COMMAND_MARKER}\nold\n")).unwrap();

        let installed = install_terminal_command_at(
            dir.path(),
            &format!("#!/bin/sh\n{TERMINAL_COMMAND_MARKER}\nnew\n"),
        )
        .unwrap();

        assert_eq!(installed, path);
        assert!(std::fs::read_to_string(&installed).unwrap().contains("new"));
        assert_eq!(
            std::fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
