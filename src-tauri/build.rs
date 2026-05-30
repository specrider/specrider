fn main() {
    // Re-export the cargo-provided target triple as a compile-time env
    // var so `diagnostics.rs` can include it in the bug-report snapshot
    // without a runtime probe. Cargo sets `TARGET` for build scripts
    // but not for the crate itself, so we forward it explicitly.
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=SPECRIDER_TARGET_TRIPLE={target}");
    }
    tauri_build::build()
}
