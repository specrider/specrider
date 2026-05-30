//! Hybrid Linux menubar theming (Linux-only; macOS/Windows no-op).
//!
//! GTK draws the in-window menubar/menus with the system GTK theme.
//! Two knobs, applied together every time the app theme changes:
//!
//!   1. `gtk-application-prefer-dark-theme` flips the system GTK theme
//!      to its dark variant when the app is in a dark theme. Free
//!      coherence with installed GTK themes (Adwaita-dark, Yaru-dark…).
//!   2. A long-lived `GtkCssProvider` overrides ONLY the menubar
//!      background + foreground so custom app themes get their chrome
//!      color on the menubar surface. Hover / popup / accelerator
//!      states are intentionally left to the GTK theme so interactive
//!      feedback still looks native.
//!
//! All GTK calls run on the main thread. The caller is expected to
//! hop via `AppHandle::run_on_main_thread`.

#[cfg(target_os = "linux")]
use std::cell::RefCell;

#[cfg(target_os = "linux")]
use gtk::prelude::*;
#[cfg(target_os = "linux")]
use gtk::{CssProvider, Settings, StyleContext, STYLE_PROVIDER_PRIORITY_APPLICATION};

#[cfg(target_os = "linux")]
thread_local! {
    /// One provider per process, kept alive on the GTK main thread.
    /// Loading new CSS into the same provider replaces the old rules in
    /// place — no need to remove + re-add to the screen each time.
    static MENU_PROVIDER: RefCell<Option<CssProvider>> = const { RefCell::new(None) };
}

/// Whitelist of CSS color formats we forward into the GtkCssProvider.
/// GTK 3 understands rgb/rgba/hex; we resolve oklch/etc. on the JS
/// side via canvas before invoking, so legitimate inputs land here as
/// `#rrggbb`, `#rrggbbaa`, `rgb(…)`, or `rgba(…)`. Anything else is
/// rejected to avoid shipping arbitrary user-controlled strings into
/// the CSS parser.
#[cfg(target_os = "linux")]
fn is_safe_color(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    if s.contains(';') || s.contains('{') || s.contains('}') || s.contains('\n') {
        return false;
    }
    if let Some(hex) = s.strip_prefix('#') {
        let len_ok = matches!(hex.len(), 3 | 4 | 6 | 8);
        return len_ok && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let head_ok = s.starts_with("rgb(") || s.starts_with("rgba(");
    if !head_ok || !s.ends_with(')') {
        return false;
    }
    let inner = &s[s.find('(').unwrap() + 1..s.len() - 1];
    inner
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, ',' | ' ' | '.' | '%' | '/' | '\t'))
}

/// Apply the menubar palette + dark preference. Must run on the GTK
/// main thread. Failures are logged, not propagated — the menu just
/// keeps the previous (or default) styling.
#[cfg(target_os = "linux")]
pub fn apply_on_main_thread(bg: &str, fg: &str, is_dark: bool) {
    if !is_safe_color(bg) || !is_safe_color(fg) {
        eprintln!("gtk_menu_theme: rejecting unsafe color input");
        return;
    }
    if let Some(settings) = Settings::default() {
        settings.set_gtk_application_prefer_dark_theme(is_dark);
    }
    let screen = match gtk::gdk::Screen::default() {
        Some(s) => s,
        None => return,
    };
    let css = format!(
        "menubar {{ background-color: {bg}; color: {fg}; }} \
         menubar > menuitem {{ color: {fg}; }}"
    );
    MENU_PROVIDER.with(|cell| {
        let mut slot = cell.borrow_mut();
        let provider = slot.get_or_insert_with(|| {
            let p = CssProvider::new();
            StyleContext::add_provider_for_screen(&screen, &p, STYLE_PROVIDER_PRIORITY_APPLICATION);
            p
        });
        if let Err(e) = provider.load_from_data(css.as_bytes()) {
            eprintln!("gtk_menu_theme: load_from_data failed: {e}");
        }
    });
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::is_safe_color;

    #[test]
    fn accepts_common_formats() {
        assert!(is_safe_color("#fff"));
        assert!(is_safe_color("#FFAA00"));
        assert!(is_safe_color("#FFAA00CC"));
        assert!(is_safe_color("rgb(12, 34, 56)"));
        assert!(is_safe_color("rgba(12, 34, 56, 0.5)"));
        assert!(is_safe_color("rgb(100% 50% 25%)"));
    }

    #[test]
    fn rejects_injection_attempts() {
        assert!(!is_safe_color("red; background: url(x)"));
        assert!(!is_safe_color("#fff } body { display: none"));
        assert!(!is_safe_color("oklch(0.5 0.1 200)"));
        assert!(!is_safe_color("var(--evil)"));
        assert!(!is_safe_color(""));
        assert!(!is_safe_color(&"#".repeat(80)));
    }
}
