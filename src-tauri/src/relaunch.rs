//! Post-update relaunch.
//!
//! On macOS the updater swaps the `.app` bundle underneath the running
//! process. Exec'ing the swapped binary directly from the exiting parent is
//! unreliable: the child can be killed by dyld/code-signature validation
//! before it reaches `setup`, and `spawn()` reports success regardless. The
//! macOS strategy therefore starts a small detached `/bin/sh` helper that
//! waits for this process to exit and then relaunches the bundle through
//! LaunchServices (`open -n`). Everything else (non-bundle/dev runs, other
//! platforms) falls back to a direct `Command` spawn.
//!
//! Launch arguments are never propagated: a relaunched instance is a normal
//! foreground launch carrying only the [`RELAUNCHED_FROM_FLAG`] marker.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Launch-mode flags that must not survive a relaunch (e.g. `--autostarted`
/// would bring the updated instance up hidden, in accessory mode).
const STRIPPED_LAUNCH_FLAGS: &[&str] = &["--autostarted"];

/// Marker passed to the relaunched instance so startup logging can identify
/// it: `--relaunched-from=<previous version>`.
pub const RELAUNCHED_FROM_FLAG: &str = "--relaunched-from=";

/// Upper bound the helper waits for the parent to exit before relaunching
/// anyway (150 × 200 ms = 30 s), so a reused PID cannot wedge it forever.
const HELPER_MAX_POLLS: u32 = 150;

/// Shell script run by the macOS helper. Positional parameters:
/// `$1` = parent pid, `$2` = bundle path, `$3..` = app arguments. Passing the
/// values as parameters (rather than interpolating them) avoids any quoting
/// of paths containing spaces such as `/Applications/Endara Desktop.app`.
const HELPER_SCRIPT_TEMPLATE: &str = r#"pid="$1"; bundle="$2"; shift 2
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt @MAX_POLLS@ ]; do sleep 0.2; i=$((i+1)); done
if [ "$#" -gt 0 ]; then exec /usr/bin/open -n "$bundle" --args "$@"; fi
exec /usr/bin/open -n "$bundle""#;

pub fn helper_script() -> String {
    HELPER_SCRIPT_TEMPLATE.replace("@MAX_POLLS@", &HELPER_MAX_POLLS.to_string())
}

/// How the relaunch will be performed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelaunchStrategy {
    /// Detached `/bin/sh` helper: wait for `parent_pid` to exit, then
    /// `open -n <bundle> --args <args>`.
    LaunchServices {
        bundle: PathBuf,
        parent_pid: u32,
        args: Vec<OsString>,
    },
    /// `Command::new(exe).args(args).spawn()`.
    Direct { exe: PathBuf, args: Vec<OsString> },
}

impl RelaunchStrategy {
    pub fn name(&self) -> &'static str {
        match self {
            RelaunchStrategy::LaunchServices { .. } => "launch_services_helper",
            RelaunchStrategy::Direct { .. } => "direct_spawn",
        }
    }
}

/// Build the argv (without argv[0]) for the relaunched instance: every
/// original launch flag is dropped and the relaunch marker is appended.
pub fn relaunch_args(original: &[OsString], previous_version: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = original
        .iter()
        .filter(|a| !is_stripped_launch_flag(a))
        .filter(|a| !starts_with(a, RELAUNCHED_FROM_FLAG))
        .filter(|a| !starts_with(a, "-psn_"))
        .cloned()
        .collect();
    args.push(OsString::from(format!(
        "{RELAUNCHED_FROM_FLAG}{previous_version}"
    )));
    args
}

fn is_stripped_launch_flag(arg: &OsStr) -> bool {
    STRIPPED_LAUNCH_FLAGS.iter().any(|f| arg == *f)
}

fn starts_with(arg: &OsStr, prefix: &str) -> bool {
    arg.to_str().is_some_and(|s| s.starts_with(prefix))
}

/// The version recorded by [`relaunch_args`], if this process was relaunched
/// after an update.
pub fn relaunched_from(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .find_map(|a| a.strip_prefix(RELAUNCHED_FROM_FLAG).map(str::to_string))
}

/// `<X>.app` for an executable at `<X>.app/Contents/MacOS/<bin>`, else `None`.
pub fn bundle_root(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name() != Some(OsStr::new("MacOS")) {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name() != Some(OsStr::new("Contents")) {
        return None;
    }
    let bundle = contents_dir.parent()?;
    if bundle.extension() != Some(OsStr::new("app")) {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// Choose the strategy for `exe`. `use_launch_services` is `true` on macOS
/// (callers pass `cfg!(target_os = "macos")`); it only takes effect when
/// `exe` lives inside an `.app` bundle.
pub fn plan(
    exe: &Path,
    parent_pid: u32,
    args: Vec<OsString>,
    use_launch_services: bool,
) -> RelaunchStrategy {
    if use_launch_services {
        if let Some(bundle) = bundle_root(exe) {
            return RelaunchStrategy::LaunchServices {
                bundle,
                parent_pid,
                args,
            };
        }
    }
    RelaunchStrategy::Direct {
        exe: exe.to_path_buf(),
        args,
    }
}

/// The process to spawn for `strategy`. Stdio is detached so the child never
/// holds our pipes; on unix it is also placed in its own process group so it
/// outlives us regardless of how we exit.
pub fn command(strategy: &RelaunchStrategy) -> Command {
    let mut cmd = match strategy {
        RelaunchStrategy::LaunchServices {
            bundle,
            parent_pid,
            args,
        } => {
            let mut cmd = Command::new("/bin/sh");
            cmd.arg("-c")
                .arg(helper_script())
                .arg("endara-relaunch")
                .arg(parent_pid.to_string())
                .arg(bundle)
                .args(args);
            cmd
        }
        RelaunchStrategy::Direct { exe, args } => {
            let mut cmd = Command::new(exe);
            cmd.args(args);
            cmd
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// Describe the argv of `cmd` for logging.
pub fn describe(cmd: &Command) -> String {
    let mut parts = vec![cmd.get_program().to_string_lossy().into_owned()];
    parts.extend(cmd.get_args().map(|a| a.to_string_lossy().into_owned()));
    format!("{parts:?}")
}

/// Plan and spawn the relaunch, logging every step. The current executable is
/// resolved through Tauri (the path canonicalised at process start) and the
/// original launch args come from `env.args_os`.
///
/// If the LaunchServices helper fails to spawn, falls back to a direct spawn
/// before giving up. Returns whether any spawn succeeded.
pub fn spawn(env: &tauri::Env, previous_version: &str) -> bool {
    let exe = match tauri::process::current_binary(env) {
        Ok(path) => path,
        Err(e) => {
            log::error!("[relaunch] cannot resolve current executable error={e}");
            return false;
        }
    };
    let original: Vec<OsString> = env.args_os.iter().skip(1).cloned().collect();
    let args = relaunch_args(&original, previous_version);
    log::info!(
        "[relaunch] exe={} original_args={:?} relaunch_args={:?}",
        exe.display(),
        original,
        args
    );

    let primary = plan(
        &exe,
        std::process::id(),
        args.clone(),
        cfg!(target_os = "macos"),
    );
    if try_spawn(&primary) {
        return true;
    }
    let fallback = RelaunchStrategy::Direct { exe, args };
    if fallback == primary {
        return false;
    }
    log::warn!(
        "[relaunch] primary strategy failed; trying {}",
        fallback.name()
    );
    try_spawn(&fallback)
}

fn try_spawn(strategy: &RelaunchStrategy) -> bool {
    let mut cmd = command(strategy);
    log::info!(
        "[relaunch] strategy={} spawning {}",
        strategy.name(),
        describe(&cmd)
    );
    match cmd.spawn() {
        Ok(child) => {
            log::info!(
                "[relaunch] strategy={} spawned pid={}",
                strategy.name(),
                child.id()
            );
            true
        }
        Err(e) => {
            log::error!(
                "[relaunch] strategy={} spawn failed error={e}",
                strategy.name()
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn relaunch_args_strips_autostarted_and_adds_marker() {
        let args = relaunch_args(&os(&["--autostarted"]), "0.1.13-rc.15");
        assert_eq!(args, os(&["--relaunched-from=0.1.13-rc.15"]));
    }

    #[test]
    fn relaunch_args_strips_stale_marker_and_psn() {
        let args = relaunch_args(
            &os(&["--relaunched-from=0.1.12", "-psn_0_12345", "--keep"]),
            "0.1.13",
        );
        assert_eq!(args, os(&["--keep", "--relaunched-from=0.1.13"]));
    }

    #[test]
    fn relaunch_args_empty_input_yields_only_marker() {
        assert_eq!(
            relaunch_args(&[], "1.0.0"),
            os(&["--relaunched-from=1.0.0"])
        );
    }

    #[test]
    fn relaunched_from_parses_marker() {
        let args = vec![
            "app".to_string(),
            "--relaunched-from=0.1.13-rc.15".to_string(),
        ];
        assert_eq!(relaunched_from(args).as_deref(), Some("0.1.13-rc.15"));
        assert_eq!(relaunched_from(vec!["app".to_string()]), None);
    }

    #[test]
    fn bundle_root_detects_app_bundle() {
        let exe = Path::new("/Applications/Endara Desktop.app/Contents/MacOS/Endara Desktop");
        assert_eq!(
            bundle_root(exe),
            Some(PathBuf::from("/Applications/Endara Desktop.app"))
        );
    }

    #[test]
    fn bundle_root_rejects_non_bundle_layouts() {
        assert_eq!(bundle_root(Path::new("/usr/local/bin/endara")), None);
        assert_eq!(
            bundle_root(Path::new("/tmp/target/debug/Contents/MacOS/endara")),
            None
        );
        assert_eq!(
            bundle_root(Path::new("/x/Foo.app/Contents/bin/endara")),
            None
        );
    }

    #[test]
    fn plan_uses_launch_services_only_for_macos_bundles() {
        let bundle_exe =
            Path::new("/Applications/Endara Desktop.app/Contents/MacOS/Endara Desktop");
        let args = os(&["--relaunched-from=1"]);
        assert_eq!(
            plan(bundle_exe, 4242, args.clone(), true),
            RelaunchStrategy::LaunchServices {
                bundle: PathBuf::from("/Applications/Endara Desktop.app"),
                parent_pid: 4242,
                args: args.clone(),
            }
        );
        assert_eq!(
            plan(bundle_exe, 4242, args.clone(), false),
            RelaunchStrategy::Direct {
                exe: bundle_exe.to_path_buf(),
                args: args.clone(),
            }
        );
        let dev_exe = Path::new("/repo/target/debug/endara-desktop");
        assert_eq!(
            plan(dev_exe, 4242, args.clone(), true),
            RelaunchStrategy::Direct {
                exe: dev_exe.to_path_buf(),
                args,
            }
        );
    }

    #[test]
    fn launch_services_command_passes_values_as_positional_params() {
        let strategy = RelaunchStrategy::LaunchServices {
            bundle: PathBuf::from("/Applications/Endara Desktop.app"),
            parent_pid: 4242,
            args: os(&["--relaunched-from=1.0.0"]),
        };
        let cmd = command(&strategy);
        assert_eq!(cmd.get_program(), "/bin/sh");
        let argv: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv[0], "-c");
        assert_eq!(argv[1], helper_script());
        assert_eq!(
            &argv[2..],
            &[
                "endara-relaunch",
                "4242",
                "/Applications/Endara Desktop.app",
                "--relaunched-from=1.0.0"
            ]
        );
    }

    #[test]
    fn helper_script_waits_for_parent_then_opens_bundle() {
        let script = helper_script();
        assert!(script.contains(r#"kill -0 "$pid""#));
        assert!(script.contains(&format!("-lt {HELPER_MAX_POLLS}")));
        assert!(script.contains(r#"exec /usr/bin/open -n "$bundle" --args "$@""#));
        assert!(script.ends_with(r#"exec /usr/bin/open -n "$bundle""#));
        assert!(
            !script.contains("@MAX_POLLS@"),
            "unsubstituted placeholder: {script}"
        );
    }

    #[test]
    fn direct_command_uses_exe_and_args() {
        let strategy = RelaunchStrategy::Direct {
            exe: PathBuf::from("/opt/endara/endara-desktop"),
            args: os(&["--relaunched-from=1.0.0"]),
        };
        let cmd = command(&strategy);
        assert_eq!(cmd.get_program(), "/opt/endara/endara-desktop");
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("--relaunched-from=1.0.0")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn helper_script_relaunches_after_parent_exits() {
        use std::time::Instant;

        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("relaunched");
        let fake_open_dir = dir.path().join("bin");
        std::fs::create_dir(&fake_open_dir).unwrap();
        let fake_open = fake_open_dir.join("open");
        std::fs::write(
            &fake_open,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
                marker.display()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_open, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut parent = Command::new("sleep").arg("1").spawn().unwrap();
        let script = helper_script().replace("/usr/bin/open", fake_open.to_str().unwrap());
        let start = Instant::now();
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .arg("endara-relaunch")
            .arg(parent.id().to_string())
            .arg("/Applications/Endara Desktop.app")
            .arg("--relaunched-from=1.0.0")
            .status()
            .unwrap();
        assert!(status.success());
        assert!(
            start.elapsed() >= std::time::Duration::from_millis(500),
            "helper returned before the parent exited"
        );
        parent.wait().unwrap();
        let recorded = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(
            recorded,
            "-n\n/Applications/Endara Desktop.app\n--args\n--relaunched-from=1.0.0\n"
        );
    }
}
