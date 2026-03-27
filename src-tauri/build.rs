use std::process::Command;

fn git_hash(dir: &str) -> String {
    Command::new("git")
        .args(["rev-parse", "--short=8", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn main() {
    let monorepo_hash = git_hash("../../..");
    let relay_hash = git_hash("../../../packages/relay");
    let desktop_hash = git_hash("../..");

    // Build date without chrono
    let date_output = Command::new("date")
        .args(["+%Y-%m-%d"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=MONOREPO_COMMIT={}", monorepo_hash);
    println!("cargo:rustc-env=RELAY_COMMIT={}", relay_hash);
    println!("cargo:rustc-env=DESKTOP_COMMIT={}", desktop_hash);
    println!("cargo:rustc-env=BUILD_DATE={}", date_output);

    // Only emit rerun-if-changed for git paths that exist — in a standalone
    // checkout (outside the monorepo) these paths won't be present.
    for path in &["../../../.git/HEAD", "../../.git/HEAD"] {
        if std::path::Path::new(path).exists() {
            println!("cargo:rerun-if-changed={}", path);
        }
    }

    tauri_build::build()
}
