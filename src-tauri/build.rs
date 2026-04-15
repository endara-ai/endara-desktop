use std::process::Command;

fn git_hash(dir: &str) -> String {
    Command::new("git")
        .args(["rev-parse", "--short=8", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "n/a".to_string())
}

/// Read from environment variable first (CI-provided), fall back to git command.
/// Treats empty strings as unset (CI may set vars to empty).
/// Truncates to 8 chars to match git short hash format.
fn env_or_git(env_key: &str, git_dir: &str) -> String {
    std::env::var(env_key)
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s[..s.len().min(8)].to_string())
        .unwrap_or_else(|| git_hash(git_dir))
}

fn main() {
    // Check env vars first (set by CI), fall back to git commands for local builds
    let desktop_hash = env_or_git("DESKTOP_COMMIT", "../..");

    // BUILD_VERSION from CI (e.g., "0.1.0-rc6"), stripped of leading "v" if present
    let build_version = std::env::var("BUILD_VERSION")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|v| v.strip_prefix('v').map(|s| s.to_string()).unwrap_or(v));
    if let Some(version) = build_version {
        println!("cargo:rustc-env=BUILD_VERSION={}", version);
    }

    // Build date without chrono
    let date_output = Command::new("date")
        .args(["+%Y-%m-%d"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=DESKTOP_COMMIT={}", desktop_hash);
    println!("cargo:rustc-env=BUILD_DATE={}", date_output);

    // Rerun if env vars change (for CI builds)
    println!("cargo:rerun-if-env-changed=DESKTOP_COMMIT");
    println!("cargo:rerun-if-env-changed=BUILD_VERSION");

    // Only emit rerun-if-changed for git paths that exist — in a standalone
    // checkout (outside the monorepo) these paths won't be present.
    if std::path::Path::new("../../.git/HEAD").exists() {
        println!("cargo:rerun-if-changed=../../.git/HEAD");
    }

    tauri_build::build()
}
