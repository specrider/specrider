use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Window};

use crate::config::ConfigState;
use crate::state::WindowsState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPlan {
    pub plan_path: String,
    pub pinned_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedSection {
    pub heading_id: String,
    pub heading_text: String,
    pub pinned_at: u64,
}

/// Per-plans-root pins. Two parallel buckets so the sidebar's "pinned
/// plans" view doesn't have to walk every section list, and the
/// outline's "pinned sections for this plan" lookup is one HashMap
/// hit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pins {
    pub plans: Vec<PinnedPlan>,
    pub sections: HashMap<String, Vec<PinnedSection>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn canonical(root: &Path) -> PathBuf {
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

fn root_for(window: &Window, windows: &WindowsState) -> Option<PathBuf> {
    let ws = windows.get_or_create(window.label());
    let root = ws.plans_root.lock().unwrap().clone()?;
    Some(canonical(&root))
}

#[tauri::command]
pub fn get_pins(
    window: Window,
    windows: State<'_, WindowsState>,
    state: State<'_, ConfigState>,
) -> Pins {
    let Some(root) = root_for(&window, &windows) else {
        return Pins::default();
    };
    let cfg = state.0.lock().unwrap();
    cfg.pins.get(&root).cloned().unwrap_or_default()
}

#[tauri::command]
pub fn toggle_plan_pin(
    plan_path: String,
    window: Window,
    app: AppHandle,
    windows: State<'_, WindowsState>,
    state: State<'_, ConfigState>,
) -> Result<bool, String> {
    let Some(root) = root_for(&window, &windows) else {
        return Err("plans root not configured".into());
    };
    let pinned_now;
    {
        let mut cfg = state.0.lock().unwrap();
        let entry = cfg.pins.entry(root.clone()).or_default();
        pinned_now = toggle_plan_pin_in(entry, &plan_path, now_secs());
        if entry.plans.is_empty() && entry.sections.is_empty() {
            cfg.pins.remove(&root);
        }
        cfg.save(&app)?;
    }
    broadcast_pins_changed(&app, &root, &state, &windows);
    Ok(pinned_now)
}

#[tauri::command]
pub fn toggle_section_pin(
    plan_path: String,
    heading_id: String,
    heading_text: String,
    window: Window,
    app: AppHandle,
    windows: State<'_, WindowsState>,
    state: State<'_, ConfigState>,
) -> Result<bool, String> {
    let Some(root) = root_for(&window, &windows) else {
        return Err("plans root not configured".into());
    };
    let pinned_now;
    {
        let mut cfg = state.0.lock().unwrap();
        let entry = cfg.pins.entry(root.clone()).or_default();
        pinned_now =
            toggle_section_pin_in(entry, &plan_path, &heading_id, &heading_text, now_secs());
        if entry.plans.is_empty() && entry.sections.is_empty() {
            cfg.pins.remove(&root);
        }
        cfg.save(&app)?;
    }
    broadcast_pins_changed(&app, &root, &state, &windows);
    Ok(pinned_now)
}

/// Toggle a plan pin inside a single `Pins` entry. Returns whether the
/// plan is pinned *after* the call (true = newly pinned, false = newly
/// unpinned). Pure: takes only the data it mutates.
pub fn toggle_plan_pin_in(pins: &mut Pins, plan_path: &str, now: u64) -> bool {
    if let Some(idx) = pins.plans.iter().position(|p| p.plan_path == plan_path) {
        pins.plans.remove(idx);
        false
    } else {
        pins.plans.push(PinnedPlan {
            plan_path: plan_path.to_string(),
            pinned_at: now,
        });
        true
    }
}

/// Toggle a section pin inside a single `Pins` entry. Cleans up the
/// per-plan list when it goes empty so empty entries don't accumulate
/// in the sections map.
pub fn toggle_section_pin_in(
    pins: &mut Pins,
    plan_path: &str,
    heading_id: &str,
    heading_text: &str,
    now: u64,
) -> bool {
    let list = pins.sections.entry(plan_path.to_string()).or_default();
    let pinned_now = if let Some(idx) = list.iter().position(|s| s.heading_id == heading_id) {
        list.remove(idx);
        false
    } else {
        list.push(PinnedSection {
            heading_id: heading_id.to_string(),
            heading_text: heading_text.to_string(),
            pinned_at: now,
        });
        true
    };
    if list.is_empty() {
        pins.sections.remove(plan_path);
    }
    pinned_now
}

/// Emit a `pins-changed` event to every window whose plans-root
/// canonicalizes to `target_root`. Multi-window correctness depends on
/// this fan-out — without it, window B keeps stale pins after window A
/// toggles.
fn broadcast_pins_changed(
    app: &AppHandle,
    target_root: &Path,
    state: &State<'_, ConfigState>,
    windows: &State<'_, WindowsState>,
) {
    let snapshot = {
        let cfg = state.0.lock().unwrap();
        cfg.pins.get(target_root).cloned().unwrap_or_default()
    };
    for (label, _win) in app.webview_windows() {
        let ws = windows.get_or_create(&label);
        let root = ws.plans_root.lock().unwrap().clone();
        let Some(root) = root else { continue };
        if canonical(&root) != target_root {
            continue;
        }
        let _ = app.emit_to(
            EventTarget::webview_window(&label),
            "pins-changed",
            &snapshot,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- toggle_plan_pin_in ----

    #[test]
    fn pin_then_unpin_a_plan() {
        let mut pins = Pins::default();
        assert!(toggle_plan_pin_in(&mut pins, "active/x.md", 100));
        assert_eq!(pins.plans.len(), 1);
        assert_eq!(pins.plans[0].plan_path, "active/x.md");
        assert_eq!(pins.plans[0].pinned_at, 100);

        // Toggle again → unpin.
        assert!(!toggle_plan_pin_in(&mut pins, "active/x.md", 200));
        assert!(pins.plans.is_empty());
    }

    #[test]
    fn distinct_plans_pin_independently() {
        let mut pins = Pins::default();
        toggle_plan_pin_in(&mut pins, "a.md", 1);
        toggle_plan_pin_in(&mut pins, "b.md", 2);
        assert_eq!(pins.plans.len(), 2);
        // Unpinning one leaves the other.
        toggle_plan_pin_in(&mut pins, "a.md", 3);
        assert_eq!(pins.plans.len(), 1);
        assert_eq!(pins.plans[0].plan_path, "b.md");
    }

    // ---- toggle_section_pin_in ----

    #[test]
    fn pin_then_unpin_a_section_cleans_up_empty_list() {
        let mut pins = Pins::default();
        assert!(toggle_section_pin_in(&mut pins, "p.md", "h", "Heading", 10));
        assert!(pins.sections.contains_key("p.md"));

        // Unpin the only section → the plan-keyed list is removed
        // entirely so empty entries don't accumulate.
        assert!(!toggle_section_pin_in(
            &mut pins, "p.md", "h", "Heading", 20
        ));
        assert!(!pins.sections.contains_key("p.md"));
    }

    #[test]
    fn pinning_a_second_section_keeps_the_first() {
        let mut pins = Pins::default();
        toggle_section_pin_in(&mut pins, "p.md", "h1", "One", 1);
        toggle_section_pin_in(&mut pins, "p.md", "h2", "Two", 2);
        assert_eq!(pins.sections.get("p.md").unwrap().len(), 2);

        // Unpinning the first leaves the list non-empty → don't remove
        // the per-plan entry.
        toggle_section_pin_in(&mut pins, "p.md", "h1", "One", 3);
        let list = pins.sections.get("p.md").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].heading_id, "h2");
    }

    #[test]
    fn sections_under_different_plans_are_independent() {
        let mut pins = Pins::default();
        toggle_section_pin_in(&mut pins, "a.md", "h", "H", 1);
        toggle_section_pin_in(&mut pins, "b.md", "h", "H", 2);
        assert_eq!(pins.sections.len(), 2);
        toggle_section_pin_in(&mut pins, "a.md", "h", "H", 3);
        assert_eq!(pins.sections.len(), 1);
        assert!(pins.sections.contains_key("b.md"));
    }
}
