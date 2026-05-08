//! Bridge for the relay's management API.
//!
//! The relay no longer exposes `/api/*` over TCP; it listens on a per-user
//! Unix-domain socket on macOS / Linux and a per-user Windows named pipe on
//! Windows. WebViews cannot dial those transports directly, so the desktop
//! provides a `mgmt_api_request` Tauri command that proxies HTTP requests from
//! the SvelteKit UI to the relay's local socket.
//!
//! Path resolution mirrors `endara_relay::management_listener::resolve_api_socket_path`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
}

/// Resolve the management-API socket / pipe path. Mirrors the relay's
/// resolution so the two processes pick the same path without coordinating.
#[allow(clippy::needless_return)]
pub fn resolve_api_socket_path(#[allow(unused_variables)] data_dir: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("ENDARA_API_SOCKET") {
        return PathBuf::from(path);
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            let runtime = PathBuf::from(xdg);
            if !runtime.as_os_str().is_empty() {
                return runtime.join("endara-relay").join("api.sock");
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let tmp = std::env::var("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"));
        let uid = unsafe { geteuid_u32() };
        return tmp.join(format!("endara-relay-{uid}")).join("api.sock");
    }

    #[cfg(windows)]
    {
        let session_id = current_user_pipe_suffix(data_dir);
        return PathBuf::from(format!(r"\\.\pipe\endara-relay-{session_id}"));
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        data_dir.join("api.sock")
    }
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
