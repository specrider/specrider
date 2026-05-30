//! Persistent app-icon swap, à la Bear's icon picker.
//!
//! macOS's `NSWorkspace.setIcon(_:forFile:options:)` writes a Finder
//! custom-icon override into the bundle's extended attributes
//! (`com.apple.ResourceFork` + `com.apple.FinderInfo` with the
//! `kHasCustomIcon` flag). That override persists across launches and
//! is honored by Dock / Finder / Spotlight without touching the
//! bundled `.icns` (so code signing stays valid). We also pump
//! `NSApp.setApplicationIconImage` so the running dock updates without
//! waiting for LaunchServices to re-read the bundle.
//!
//! The flip side: anything that replaces the `.app` bundle wholesale
//! (DMG-drag installer, Sparkle replace) wipes the override, so the
//! setup hook in `lib.rs` re-applies the saved variant on launch.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::{path::BaseDirectory, Manager};

/// Resolve the variant id (e.g. `"default"`, `"dark"`) to the bundled
/// PNG path under `Contents/Resources/icons/variants/<id>.png`. In dev
/// (`tauri dev`) Tauri remaps `BaseDirectory::Resource` to the source
/// `src-tauri/` tree, so the same call works there.
#[cfg(target_os = "macos")]
fn variant_path(app: &AppHandle, variant: &str) -> Result<PathBuf, String> {
    if !is_safe_variant_id(variant) {
        return Err(format!("invalid variant id: {variant}"));
    }
    app.path()
        .resolve(
            format!("icons/variants/{variant}.png"),
            BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())
}

/// Defense in depth — `apply_setting` already keys on a known set, but
/// this command also runs at launch from on-disk settings, which a
/// user could edit by hand. Reject anything that could escape the
/// variants directory (path separators, parent traversal, NUL).
#[cfg(target_os = "macos")]
fn is_safe_variant_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Apply a variant. Hops to the main thread internally because
/// `setApplicationIconImage:` requires it; the persistent
/// `setIcon_forFile_options:` call piggybacks on the same hop. Runs
/// asynchronously — failures are logged, not propagated, since the
/// caller (Tauri command or launch setup) already returned by then.
///
/// Silent no-op in `tauri dev`: the dev binary isn't inside a `.app`
/// bundle so there's nothing to write the custom-icon attribute onto,
/// and Tauri doesn't stage `bundle.resources` PNGs into `target/`
/// either, so we skip the whole thing rather than spam the console
/// every time the user picks a variant or relaunches.
pub fn apply_async(app: &AppHandle, variant: &str) {
    let app_clone = app.clone();
    let variant = variant.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = apply_on_main_thread(&app_clone, &variant) {
            eprintln!("app_icon::apply({variant}) failed: {e}");
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_on_main_thread(app: &AppHandle, variant: &str) -> Result<(), String> {
    use objc2::rc::autoreleasepool;
    use objc2::AnyThread;
    use objc2_app_kit::{NSApplication, NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
    use objc2_foundation::{MainThreadMarker, NSString, NSURL};

    // Dev mode: no .app bundle to write to, no bundled resources to
    // resolve. Silently skip — the user accepts the generic dev icon.
    let bundle_path = match bundle_path() {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    let png_path = variant_path(app, variant)?;
    if !png_path.exists() {
        return Err(format!("variant png missing: {}", png_path.display()));
    }
    let mtm = MainThreadMarker::new().ok_or_else(|| "apply_on_main_thread off main".to_string())?;

    autoreleasepool(|_| unsafe {
        let png_str = NSString::from_str(&png_path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&png_str);
        let image = NSImage::initWithContentsOfURL(NSImage::alloc(), &url)
            .ok_or_else(|| format!("NSImage failed to load {}", png_path.display()))?;

        let bundle_str = NSString::from_str(&bundle_path.to_string_lossy());
        let workspace = NSWorkspace::sharedWorkspace();
        let ok = workspace.setIcon_forFile_options(
            Some(&image),
            &bundle_str,
            NSWorkspaceIconCreationOptions(0),
        );
        if !ok {
            return Err(format!(
                "NSWorkspace.setIcon returned false for {}",
                bundle_path.display()
            ));
        }

        let ns_app = NSApplication::sharedApplication(mtm);
        ns_app.setApplicationIconImage(Some(&image));

        Ok::<(), String>(())
    })
}

#[cfg(not(target_os = "macos"))]
fn apply_on_main_thread(_app: &AppHandle, _variant: &str) -> Result<(), String> {
    Ok(())
}

/// Walk up from the running executable to the enclosing `.app`
/// directory. `current_exe()` lands at
/// `…/SpecRider.app/Contents/MacOS/SpecRider`, so we ascend three
/// levels. Returns an error if no `.app` ancestor is found (e.g. when
/// running the bare `cargo` binary outside a bundle — `tauri dev`
/// hits this and the apply call no-ops gracefully).
#[cfg(target_os = "macos")]
fn bundle_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cur: &Path = &exe;
    while let Some(parent) = cur.parent() {
        if parent.extension().is_some_and(|e| e == "app") {
            return Ok(parent.to_path_buf());
        }
        cur = parent;
    }
    Err("not running inside a .app bundle (likely `tauri dev`)".to_string())
}
