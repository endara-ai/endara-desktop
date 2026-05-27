//! Bridge for the relay's management API.
//!
//! The relay no longer exposes `/api/*` over TCP; it listens on a per-user
//! Unix-domain socket on macOS / Linux and a per-user Windows named pipe on
//! Windows. WebViews cannot dial those transports directly, so the desktop
//! provides a `mgmt_api_request` Tauri command that proxies HTTP requests from
//! the SvelteKit UI to the relay's local socket.
//!
//! Path resolution mirrors `endara_relay::management_listener::resolve_api_socket_path`
//! — see that module for details. On macOS / Linux the socket path includes an
//! 8-char hex hash of the canonicalized `data_dir` so a dev build
//! (`~/.endara-dev`) and an installed prod build (`~/.endara`) can run side by
//! side without colliding on the same path. Windows is unchanged — the pipe
//! name is already keyed on the user/session.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Type alias for a duplex stream that can be used for either request/response
/// or streaming bodies (SSE). Both the Unix-socket and named-pipe transports
/// implement `AsyncRead + AsyncWrite`, so callers that need to parse a long-
/// lived response (e.g. SSE frames) can dial the management API without
/// going through `hyper`.
pub type DuplexStream = Pin<Box<dyn DuplexIo + Send>>;

/// Marker trait for a tokio duplex stream. Implemented for both the Unix
/// socket and the Windows named-pipe client returned by [`connect_stream`].
pub trait DuplexIo: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> DuplexIo for T {}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
}

/// Resolve the management-API socket / pipe path. Mirrors the relay's
/// resolution so the two processes pick the same path without coordinating.
pub fn resolve_api_socket_path(data_dir: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("ENDARA_API_SOCKET") {
        return PathBuf::from(path);
    }

    #[cfg(target_os = "linux")]
    {
        let suffix = data_dir_suffix(data_dir);
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            let runtime = PathBuf::from(xdg);
            if !runtime.as_os_str().is_empty() {
                return runtime
                    .join(format!("endara-relay-{suffix}"))
                    .join("api.sock");
            }
        }
        data_dir.join("api.sock")
    }

    #[cfg(target_os = "macos")]
    {
        let suffix = data_dir_suffix(data_dir);
        let tmp = std::env::var("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"));
        let uid = unsafe { geteuid_u32() };
        tmp.join(format!("endara-relay-{uid}-{suffix}"))
            .join("api.sock")
    }

    #[cfg(windows)]
    {
        let session_id = current_user_pipe_suffix(data_dir);
        PathBuf::from(format!(r"\\.\pipe\endara-relay-{session_id}"))
    }

    // Final fallback for any other target (e.g. non-macOS unix variants not
    // covered above). The platform-specific branches above are all single tail
    // expressions, so this is only compiled where it can actually be reached.
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        data_dir.join("api.sock")
    }
}

/// Stable 8-char lowercase hex hash of `data_dir`.
///
/// Used as a suffix on macOS / Linux socket paths so that two relay processes
/// running under the same `uid` / `$XDG_RUNTIME_DIR` (e.g. an installed prod
/// build and a `pnpm tauri dev` instance) get distinct paths.
///
/// Lockstep contract with `packages/relay/src/management_listener.rs`'s copy
/// of this helper: both crates MUST produce the same 8 hex chars for the same
/// canonicalized path. Keep the algorithm byte-for-byte identical:
/// 1. `Path::canonicalize` the input; on error, hash the input path as-is.
/// 2. Hash with `std::collections::hash_map::DefaultHasher`.
/// 3. Format the resulting `u64` as `format!("{:016x}", hash)`, then take the
///    first 8 chars. (NOT `format!("{:08x}", hash as u32)` — that's a
///    different value.)
#[cfg_attr(windows, allow(dead_code))]
fn data_dir_suffix(data_dir: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let canonical = data_dir.canonicalize().unwrap_or_else(|_| data_dir.into());
    let mut h = DefaultHasher::new();
    canonical.hash(&mut h);
    let full = format!("{:016x}", h.finish());
    full[..8].to_string()
}

#[cfg(unix)]
unsafe fn geteuid_u32() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    geteuid()
}

#[cfg(windows)]
fn current_user_pipe_suffix(data_dir: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    if let Ok(user) = std::env::var("USERNAME") {
        let mut h = DefaultHasher::new();
        user.hash(&mut h);
        return format!("{:x}", h.finish());
    }
    let mut h = DefaultHasher::new();
    data_dir.hash(&mut h);
    format!("{:x}", h.finish())
}

/// Send an HTTP request to the management API socket / pipe and return the
/// response status and body bytes. The body bytes are returned as a UTF-8
/// `String` because every management-API response is JSON or empty; non-UTF-8
/// payloads would already be a bug on the relay side.
pub async fn send_request(
    socket_path: &Path,
    method: &str,
    path: &str,
    body: Option<Vec<u8>>,
    headers: &[(String, String)],
) -> Result<ApiResponse, String> {
    tokio::time::timeout(
        REQUEST_TIMEOUT,
        send_request_inner(socket_path, method, path, body, headers),
    )
    .await
    .map_err(|_| {
        format!(
            "management API request timed out after {:?}",
            REQUEST_TIMEOUT
        )
    })?
}

async fn send_request_inner(
    socket_path: &Path,
    method: &str,
    path: &str,
    body: Option<Vec<u8>>,
    headers: &[(String, String)],
) -> Result<ApiResponse, String> {
    let body_bytes = body.map(Bytes::from).unwrap_or_default();
    let has_body = !body_bytes.is_empty();

    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "relay.local")
        .header("accept", "application/json");
    if has_body {
        builder = builder.header("content-type", "application/json");
    }
    for (k, v) in headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    let req = builder
        .body(Full::new(body_bytes))
        .map_err(|e| format!("build request: {e}"))?;

    let io = connect(socket_path).await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("HTTP handshake on {}: {e}", socket_path.display()))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let resp = sender
        .send_request(req)
        .await
        .map_err(|e| format!("send_request to {}: {e}", socket_path.display()))?;
    let status = resp.status().as_u16();
    let raw = resp
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("read body: {e}"))?
        .to_bytes();
    let body = String::from_utf8(raw.to_vec())
        .map_err(|e| format!("management API returned non-UTF-8 body: {e}"))?;
    Ok(ApiResponse { status, body })
}

#[cfg(unix)]
async fn connect(path: &Path) -> Result<TokioIo<tokio::net::UnixStream>, String> {
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .map_err(|e| format!("connect to {}: {e}", path.display()))?;
    Ok(TokioIo::new(stream))
}

#[cfg(windows)]
async fn connect(
    path: &Path,
) -> Result<TokioIo<tokio::net::windows::named_pipe::NamedPipeClient>, String> {
    let name = path
        .to_str()
        .ok_or_else(|| "non-utf8 pipe name".to_string())?;
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(name)
        .map_err(|e| format!("open pipe {name}: {e}"))?;
    Ok(TokioIo::new(client))
}

#[cfg(not(any(unix, windows)))]
async fn connect(_path: &Path) -> Result<TokioIo<tokio::net::TcpStream>, String> {
    Err("management API bridge is unsupported on this platform".to_string())
}

/// Open a raw duplex stream to the management API socket / pipe. Unlike
/// [`send_request`], the caller is responsible for writing the HTTP request
/// and parsing the response — used by the SSE event bridge so it can keep
/// reading the response body for the lifetime of the subscription.
#[cfg(unix)]
pub async fn connect_stream(path: &Path) -> Result<DuplexStream, String> {
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .map_err(|e| format!("connect to {}: {e}", path.display()))?;
    Ok(Box::pin(stream))
}

#[cfg(windows)]
pub async fn connect_stream(path: &Path) -> Result<DuplexStream, String> {
    let name = path
        .to_str()
        .ok_or_else(|| "non-utf8 pipe name".to_string())?;
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(name)
        .map_err(|e| format!("open pipe {name}: {e}"))?;
    Ok(Box::pin(client))
}

#[cfg(not(any(unix, windows)))]
pub async fn connect_stream(_path: &Path) -> Result<DuplexStream, String> {
    Err("management API bridge is unsupported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Serializes env-mutating tests in this module. Cargo runs tests in the
    // same binary in parallel by default; without this, setting/removing
    // `ENDARA_API_SOCKET` could race between tests sharing the process-wide
    // env.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn resolve_api_socket_path_honors_env_var() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("ENDARA_API_SOCKET", "/tmp/endara-desktop-test.sock");
        let p = resolve_api_socket_path(Path::new("/tmp"));
        assert_eq!(p, PathBuf::from("/tmp/endara-desktop-test.sock"));
        std::env::remove_var("ENDARA_API_SOCKET");
    }

    #[test]
    fn data_dir_suffix_returns_eight_lowercase_hex_chars() {
        let dir = tempfile::tempdir().unwrap();
        let s = data_dir_suffix(dir.path());
        assert_eq!(s.len(), 8, "expected 8 chars, got {s:?}");
        assert!(
            s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
            "expected lowercase hex, got {s:?}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_api_socket_path_macos_differs_per_data_dir() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("ENDARA_API_SOCKET");
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let pa = resolve_api_socket_path(a.path());
        let pb = resolve_api_socket_path(b.path());
        assert_ne!(
            pa, pb,
            "different data_dirs should produce different socket paths"
        );
        let parent_a = pa.parent().unwrap().file_name().unwrap().to_string_lossy();
        let parent_b = pb.parent().unwrap().file_name().unwrap().to_string_lossy();
        assert!(parent_a.starts_with("endara-relay-"));
        assert!(parent_b.starts_with("endara-relay-"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_api_socket_path_macos_is_deterministic() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("ENDARA_API_SOCKET");
        let dir = tempfile::tempdir().unwrap();
        let p1 = resolve_api_socket_path(dir.path());
        let p2 = resolve_api_socket_path(dir.path());
        assert_eq!(p1, p2, "same data_dir should produce the same path");
    }
}
