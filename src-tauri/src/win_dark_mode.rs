//! Hybrid Windows dark-mode plumbing (Windows-only; macOS/Linux no-op).
//!
//! Windows draws the title bar via DWM and the menu bar via the legacy
//! theming engine. Two knobs, applied together every time the app
//! theme flips between light and dark:
//!
//!   1. `DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE)` flips
//!      the title bar and DWM-drawn non-client frame between Windows'
//!      light and dark palettes. Documented since Win10 build 18985;
//!      we fall back to the pre-release attribute id `19` on older
//!      Win10 1809 - 18984 builds.
//!   2. `SetPreferredAppMode(AllowDark)` via the uxtheme.dll ordinal
//!      135 export opts the process into Windows' dark menus and
//!      themed standard controls. Undocumented but stable since Win10
//!      1903; the trick used by Notepad++, mintty, Windows Terminal.
//!
//! Custom app-theme colors (--paper, --ink) are NOT honored. Windows
//! native menus only ship light and dark palettes; tracking which one
//! is active is the closest analog to the GTK menubar fix on Linux.
//! Owner-drawing every menu item to match arbitrary colors is a
//! different, much larger project.

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{BOOL, FALSE, HWND, TRUE},
    Graphics::Dwm::DwmSetWindowAttribute,
    System::LibraryLoader::{GetProcAddress, LoadLibraryW},
    UI::WindowsAndMessaging::{SendMessageW, WM_THEMECHANGED},
};

/// `DWMWA_USE_IMMERSIVE_DARK_MODE` on Win10 build 18985+ / Win11.
/// On Win10 1809 - 18984 the same behavior was gated behind id `19`,
/// which we try as a fallback when `20` returns E_INVALIDARG.
#[cfg(target_os = "windows")]
const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
#[cfg(target_os = "windows")]
const DWMWA_USE_IMMERSIVE_DARK_MODE_OLD: u32 = 19;

#[cfg(target_os = "windows")]
#[repr(C)]
#[allow(dead_code)]
enum PreferredAppMode {
    Default = 0,
    AllowDark = 1,
    ForceDark = 2,
    ForceLight = 3,
}

#[cfg(target_os = "windows")]
type FnSetPreferredAppMode = unsafe extern "system" fn(PreferredAppMode) -> PreferredAppMode;

/// Lazy-resolved pointer to `uxtheme.dll!#135` (SetPreferredAppMode).
/// Resolves once per process; absent on systems older than Win10 1903.
#[cfg(target_os = "windows")]
fn set_preferred_app_mode_fn() -> Option<FnSetPreferredAppMode> {
    static FN: OnceLock<Option<usize>> = OnceLock::new();
    let raw = *FN.get_or_init(|| unsafe {
        let dll: Vec<u16> = "uxtheme.dll\0".encode_utf16().collect();
        // windows-sys 0.52 types HMODULE as `isize`, so the "null" check
        // is `== 0` rather than `.is_null()`.
        let module = LoadLibraryW(dll.as_ptr());
        if module == 0 {
            return None;
        }
        // Ordinal 135 — passing the ordinal as a "name" pointer with the
        // high bits zero is the documented GetProcAddress(MAKEINTRESOURCE)
        // protocol.
        let proc = GetProcAddress(module, 135 as *const u8);
        proc.map(|p| p as usize)
    });
    raw.map(|addr| unsafe { std::mem::transmute::<usize, FnSetPreferredAppMode>(addr) })
}

/// Apply dark/light to the title bar of `hwnd` via DWM, retrying with
/// the pre-release attribute id on older Win10 builds. Failures are
/// swallowed — worst case the title bar stays in its prior mode.
#[cfg(target_os = "windows")]
unsafe fn set_dwm_dark_mode(hwnd: HWND, is_dark: bool) {
    let value: BOOL = if is_dark { TRUE } else { FALSE };
    let size = std::mem::size_of::<BOOL>() as u32;
    let hr = DwmSetWindowAttribute(
        hwnd,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
        &value as *const _ as *const c_void,
        size,
    );
    // 0x80070057 = E_INVALIDARG. Older Win10 (1809–18984) shipped the
    // attribute under id 19, so retry once with that id.
    if hr == 0x8007_0057_u32 as i32 {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE_OLD,
            &value as *const _ as *const c_void,
            size,
        );
    }
}

/// Flip every webview window in the app between light and dark, then
/// nudge each one with `WM_THEMECHANGED` so cached theme handles in
/// the menu / scrollbar / button paint paths refresh.
#[cfg(target_os = "windows")]
pub fn apply_to_all_windows<R: Runtime>(app: &AppHandle<R>, is_dark: bool) {
    if let Some(set_mode) = set_preferred_app_mode_fn() {
        let mode = if is_dark {
            PreferredAppMode::AllowDark
        } else {
            PreferredAppMode::Default
        };
        unsafe {
            set_mode(mode);
        }
    }

    for (_label, window) in app.webview_windows() {
        if let Ok(hwnd) = window.hwnd() {
            // Tauri's HWND newtype carries either an `isize` (windows
            // 0.5x) or a `*mut c_void` (windows 0.6x). `as _` lets the
            // compiler bridge whichever shape we got into windows-sys's
            // `*mut c_void`-shaped HWND.
            let raw: HWND = hwnd.0 as _;
            unsafe {
                set_dwm_dark_mode(raw, is_dark);
                SendMessageW(raw, WM_THEMECHANGED, 0, 0);
            }
        }
    }
}
