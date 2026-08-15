# Endara Desktop

**One endpoint for all your MCP servers.** [endara.ai](https://endara.ai)

Add MCP servers, manage OAuth, browse tools — without ever opening a terminal.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte_5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/endara-ai/endara-desktop/releases)

<!-- TODO(website): once these images are hosted on endara.ai, uncomment.
![Endara Desktop — endpoint dashboard](https://endara.ai/images/desktop-hero.png)
![Endara Desktop — dark mode](https://endara.ai/images/desktop-dark.png)
![OAuth flow and tool catalog](https://endara.ai/images/oauth-catalog.png)
-->

> Works with Claude Desktop, ChatGPT, Cursor, Windsurf, VS Code, Zed, Continue, and any MCP-compatible client.

## What can you do?

- **Visual endpoint dashboard** — see every MCP server you've added with live health indicators, all in one place.
- **Live tool-call overlay** — an always-on-top, click-through window in the corner of your screen shows every MCP tool call as it happens, with the calling client, success / failure / duration, and a repeat-call counter so bursts collapse into a single card. Click a card to jump to that exact call in the Observability tab.
- **Observability tab** — browse a searchable history of every tool call with filters, latency sparklines, and request / response payload drill-through.
- **Run servers in containers** — toggle Docker / Podman isolation when adding a STDIO server, with host bind mounts and an automatic direct-spawn fallback when no runtime is installed.
- **Endpoint profiles** — group endpoints into named profiles served under their own `/mcp/{profile}` URL so different agents can share one relay without sharing one catalog.
- **Tray health at a glance** — the tray icon flips green / yellow / red and the menu's first line spells out the exact reason (sign-in needed, endpoint unhealthy, relay stopped) without opening the app.
- **Search tools** across every connected server from a single ⌘K palette.
- **Watch real-time logs** stream from each endpoint as requests flow through — log views are virtualized, so even thousands of buffered lines scroll smoothly.
- **Grant sandbox write access visually** — pick the directories that JS-execution scripts may write into (the relay's `write_dirs` allowlist) with a native folder picker in Settings; scripts cannot write anywhere else on disk.
- **Manage OAuth flows** end-to-end inside the app — sign in just in time when a server needs it, and re-authenticate or refresh from the **Auth** tab without copy-pasting tokens.
- **Connect enterprise SSO once per organization** — add your identity provider (e.g. Okta) as an organization, sign in, and Endara detects which of your MCP servers accept it; every server sharing an organization draws from one pooled, silently-refreshed credential.
- **Single-click add server** for STDIO, SSE, or HTTP MCP servers — paste a command or URL (and, for STDIO servers, optionally run it in a container), and you're done.

## What is this?

Endara Desktop is a lightweight system tray application that wraps the [Endara Relay](https://github.com/endara-ai/endara-relay) — an MCP (Model Context Protocol) relay server that aggregates multiple MCP tool servers behind a single endpoint.

Instead of running the relay manually from a terminal, Endara Desktop gives you a single install that manages everything. It bundles the relay binary as a [Tauri sidecar](https://v2.tauri.app/plugin/shell/#spawning-a-sidecar), automatically starts it on launch, monitors its health, restarts it if it crashes, and kills it cleanly on quit.

The app provides a visual interface for everything the relay exposes: endpoint health at a glance, a searchable tool browser, real-time log output, and configuration inspection — all from a compact tray-app UI inspired by [Tailscale](https://tailscale.com/).

## Download

### macOS — Homebrew (recommended)

```bash
brew install --cask endara-ai/tap/endara
```

This installs the latest signed & notarized DMG from the [`endara-ai/homebrew-tap`](https://github.com/endara-ai/homebrew-tap) tap and registers the app for `brew upgrade`. Tauri's built-in updater also continues to work, so you'll get new versions whichever way you prefer.

### Direct downloads

Or grab an installer directly from [GitHub Releases](https://github.com/endara-ai/endara-desktop/releases) — useful on Windows / Linux, or if you don't use Homebrew.

| Platform | Format | File |
|----------|--------|------|
| 🍎 macOS | DMG installer | `Endara_x.x.x_aarch64.dmg` |
| 🪟 Windows | Setup installer | `Endara_x.x.x_x64-setup.exe` |
| 🪟 Windows | MSI installer | `Endara_x.x.x_x64_en-US.msi` |
| 🐧 Linux | Debian package | `endara_x.x.x_amd64.deb` |
| 🐧 Linux | AppImage | `Endara_x.x.x_amd64.AppImage` |

Or [build from source](#development) if you prefer.

## Quick Start

1. **Install** Endara Desktop using one of the options in [Download](#download) above.
2. **Launch the app** — the tray icon appears in your menu bar and the bundled relay starts automatically on `127.0.0.1:9400`.
3. **Add a server** — click the tray icon, choose **Add server**, and paste a STDIO command or an SSE / HTTP MCP server URL.
4. **Connect your client** — point Claude Desktop, Cursor, or any other MCP-compatible client at `http://localhost:9400/mcp` and your tools show up.

## Features

- **System tray integration** — Runs in your menu bar / system tray, always available without cluttering your workspace
- **Tray health indicator** — The tray icon itself flips green / yellow / red to reflect overall relay health, and the menu's first line spells out the exact reason (e.g. `Endara — Sign in required for linear`)
- **Tool-call overlay window** — Always-on-top, click-through window that surfaces every MCP tool call as a card (in-flight blue → success green / failure red), labelled with the calling client, with stacked count chips when the same tool is called in quick succession. A left accent bar reflects call status (blue while in flight, red on any failure), and clicking a card opens the main window on the **Observability** tab filtered to that exact call. Configurable corner, max-cards, and "hide while Endara is focused" toggles in the **Overlay** section of Settings.
- **Endpoint profiles** — Group endpoints into named profiles via the **Profiles** tab, each served at `/mcp/{profile}` with its own JS-execution and TOON-output toggles. The tab renders a copyable `claude_desktop_config.json` snippet for each profile.
- **Observability tab** — Browse recorded tool calls with filters (server, tool, status, time window), latency sparklines, and full request / response payload drill-through, plus a one-click purge. Backed by the relay's durable observability store.
- **Container isolation** — When adding a STDIO server, toggle **Run in container** to run it under Docker or Podman with optional host bind mounts; servers flagged as not-containerizable show a badge and run directly, and a missing runtime falls back to direct spawn.
- **Just-in-time OAuth** — Servers that need authentication prompt you to sign in at add time and again if a token goes stale; refresh or re-authenticate from the **Auth** tab.
- **Organizations (enterprise SSO)** — A guided onboarding flow takes you from picking an identity provider, through SSO sign-in and automatic detection of which MCP servers accept the organization's credentials, to connecting the ones you choose. Manage organizations from **Settings** (re-authenticate or remove them), a full-width banner warns when an organization's session expires, and per-server resource credentials (client ID / secret, scopes) live under the consolidated **Advanced** section when adding or editing a server.
- **Relay lifecycle management** — Auto-starts the relay on launch, monitors it, auto-restarts on crash, kills on quit
- **Endpoint dashboard** — View all configured MCP server endpoints with live health indicators (🟢 healthy / 🟡 degraded / 🔴 down), plus Starting… / Stopping… progress hints while a server is toggled on or off
- **Tool browser** — Browse and search all tools exposed by each endpoint
- **Real-time logs** — Stream log output from each endpoint as it happens; the Relay Logs and per-endpoint Logs views render only the visible rows (virtualized), so the full 5,000-line buffer never bogs down the UI
- **Write directories** — A **Write directories** section in Settings manages the relay's `[relay] write_dirs` allowlist — the directories sandbox scripts may write into via `writeFile()`. Add entries with a native folder picker, remove them with one click; changes are persisted to `config.toml` and pushed to the running relay without a restart
- **Config viewer** — Inspect the current relay configuration
- **Dark mode** — Follows your system preference automatically
- **Auto-updates** — Checks GitHub Releases for new versions via the Tauri updater plugin

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` | Open global search |
| `⌘,` | Open settings |
| `Esc` | Go back / close panel |

## Architecture

Endara Desktop is a [Tauri 2](https://v2.tauri.app) application with two layers:

```
┌─────────────────────────────────┐
│        SvelteKit Frontend       │
│   (Svelte 5 + Tailwind CSS 4)  │
│                                 │
│  Sidebar ←→ Detail Panel        │
│  (endpoints)  (tools/logs/cfg)  │
└────────────┬────────────────────┘
             │ Tauri IPC
┌────────────▼────────────────────┐
│        Tauri Backend (Rust)     │
│                                 │
│  Commands: start / stop /       │
│  restart / status               │
│                                 │
│  Sidecar ──→ endara-relay       │
│  (bundled binary)               │
└─────────────────────────────────┘
```

**Backend (Rust):** Manages the relay as a sidecar process — spawning, monitoring stdout/stderr, handling crashes with auto-restart, and clean shutdown on exit. Exposes a set of Tauri commands grouped roughly into:

- **Relay lifecycle** — `start_relay`, `stop_relay`, `restart_relay`, `relay_status`, `get_sidecar_status`, `get_buffered_relay_logs`, `get_relay_port`, `set_relay_port`.
- **Management-API proxy** — `mgmt_api_request` proxies HTTP-shaped `/api/*` calls from the SvelteKit frontend over the relay's per-user Unix socket / Named Pipe; `get_mgmt_api_socket_path` exposes the socket path for diagnostics.
- **Config & endpoints** — `get_endpoint_config`, `add_endpoint`, `update_endpoint`, `remove_endpoint`, `get_config_path_display`, `set_js_execution_mode`, `get_write_dirs`, `set_write_dirs`.
- **Updates & autostart** — `get_update_channel`, `set_update_channel`, `check_for_update`, `download_and_install_update`, `show_update_notification`, `get_autostart`, `set_autostart`, `get_build_info`.

**Frontend (SvelteKit):** Talks to the relay's management API to fetch endpoint status, tools, logs, and configuration. The UI is organized around a sidebar (endpoint list) + detail panel (per-endpoint tabs for tools, logs, config, auth) layout. Auxiliary components include onboarding, search palette, settings, an add-endpoint modal, and a unified tool catalog.

The Tauri webview runs under an explicit Content Security Policy (`src-tauri/tauri.conf.json` → `app.security.csp`) that restricts script, style, and connect sources to the app origin, IPC, and localhost endpoints. Management traffic from the SvelteKit frontend reaches the relay's `/api/*` through the `mgmt_api_request` Tauri command, which proxies HTTP semantics over the relay's per-user Unix-domain socket (Linux/macOS) or Named Pipe (Windows). MCP traffic flows over loopback TCP at the configured relay port.

## Process model

In the standard desktop install, **the desktop owns the relay**. There is no separate background service — the relay's lifetime is bounded by the desktop's lifetime.

```
Endara Desktop (parent)
└── endara-relay (Tauri sidecar child)
    └── listens on 127.0.0.1:9400 (prod) / 9500 (dev)
```

- **Spawn.** On startup the desktop spawns the bundled `endara-relay` binary as a [Tauri sidecar](https://v2.tauri.app/plugin/shell/#spawning-a-sidecar) child process. The desktop passes `--port` (and the data dir / config path) on the command line; in dev it uses `9500`, in production it uses `9400` by default.
- **Listen.** The relay binds to `127.0.0.1` only and accepts MCP traffic on the configured port. Other applications on the machine connect to it over loopback at that port.
- **Shutdown.** The relay dies with the desktop. On a clean quit the desktop sends `SIGTERM` to the sidecar; on a hard exit (force-quit, crash, logout) the OS reaps it with `SIGKILL`. There is no graceful-shutdown line emitted by the relay in the latter case — the last log entry is whatever it was doing when the parent died.
- **Auto-start.** If you enable "Launch at login" in Settings, the desktop registers a macOS LaunchAgent that re-launches *the desktop* (which then spawns the relay as its child). The LaunchAgent does **not** run the relay directly.

### Bundled vs. brew-installed relay (do not mix)

There are two ways to get a relay on your machine, and they are mutually exclusive on the same port:

| Install path | What it gives you | Relay lifecycle |
|---|---|---|
| `brew install --cask endara-ai/tap/endara` (or the DMG / `.msi` / `.deb` / `.AppImage`) | Full desktop GUI **with** the relay bundled inside the app bundle | Relay is a **child of the desktop**. Quitting the desktop kills the relay. |
| `brew install endara-ai/tap/endara-relay` | Headless CLI relay, **no GUI** | Standalone process you run yourself (or via your own launchd/systemd unit). |

Pick one. If both are installed and both try to bind `127.0.0.1:9400`, the second one to start will fail with `EADDRINUSE`. The desktop's bundled relay does not read or coordinate with a brew-installed `endara-relay` — they are separate binaries with separate config paths.

### File locations (macOS)

- **Bundled relay binary:** `/Applications/Endara Desktop.app/Contents/MacOS/endara-relay`
- **Auto-start LaunchAgent:** `~/Library/LaunchAgents/Endara Desktop.plist` (only present if "Launch at login" is enabled)
- **Desktop log:** `~/Library/Logs/ai.endara.desktop/Endara Desktop.log`
- **Relay log:** `~/.endara/logs/relay.log.<YYYY-MM-DD>` (rotated daily)
- **Relay config:** `~/.endara/config.toml`

On Linux and Windows the same parent/child model applies; only the file paths differ (Tauri's standard log/config dirs for the `ai.endara.desktop` identifier, and no LaunchAgent — autostart uses the platform's native mechanism).

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- [Tauri CLI](https://v2.tauri.app/start/create-project/) — `cargo install tauri-cli --version "^2"`
- The [Endara Relay](https://github.com/endara-ai/endara-relay) binary (see [Sidecar setup](#sidecar-setup))

### Setup

```bash
# Clone the repository
git clone https://github.com/endara-ai/endara-desktop.git
cd endara-desktop

# Install frontend dependencies
npm install

# Start the dev server with hot-reload
cargo tauri dev
```

### Sidecar setup

Tauri expects the relay binary at `src-tauri/binaries/endara-relay-{target-triple}` (e.g., `endara-relay-aarch64-apple-darwin`). A helper script is provided:

```bash
# Copy a locally-built relay binary into the correct sidecar location
./scripts/copy-sidecar.sh /path/to/endara-relay
```

## Building for Production

```bash
cargo tauri build
```

This produces platform-specific installers in `src-tauri/target/release/bundle/`:

- **macOS:** `.dmg` in `bundle/dmg/`
- **Windows:** `-setup.exe` in `bundle/nsis/`, `.msi` in `bundle/msi/`
- **Linux:** `.deb` in `bundle/deb/`, `.AppImage` in `bundle/appimage/`

## Project Structure

```
packages/desktop/
├── src/
│   ├── routes/                    # SvelteKit routes
│   │   ├── +layout.svelte         # Root layout
│   │   └── +page.svelte           # Main page
│   ├── lib/
│   │   ├── components/            # Svelte UI components (sidebar, detail panel, tabs, dialogs, modals, etc.)
│   │   ├── api.ts                 # API client for relay management
│   │   ├── stores.ts              # Svelte stores for app state
│   │   ├── types.ts               # TypeScript type definitions
│   │   └── mock.ts                # Mock data for development
│   ├── app.css                    # Global styles (Tailwind)
│   └── app.html                   # HTML shell
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                 # Tauri commands + relay sidecar lifecycle
│   │   ├── main.rs                # Entry point
│   │   ├── api_proxy.rs           # HTTP-over-UDS / Named-Pipe client for the relay's /api
│   │   └── webview_recovery.rs    # Webview crash detection + recovery
│   ├── tauri.conf.json            # Tauri config (bundling, updater, sidecar)
│   ├── capabilities/default.json  # Permissions (shell, updater)
│   ├── binaries/                  # Relay sidecar binary (not committed)
│   └── icons/                     # App icons for all platforms
├── scripts/
│   └── copy-sidecar.sh            # Helper to copy relay binary for bundling
├── package.json
└── LICENSE                        # Apache-2.0
```

## Releasing

Releases are automated via GitHub Actions. The desktop release depends on [Endara Relay](https://github.com/endara-ai/endara-relay) — the relay must be released first so the desktop can download its binaries.

### Release flow

1. **Release the relay first** — tag and push in [endara-ai/endara-relay](https://github.com/endara-ai/endara-relay) on the same tag the desktop will use (e.g. `v0.1.8`; release candidates use `vX.Y.Z-rc.N`)
2. **Tag the desktop** — `git tag v0.1.8 && git push origin v0.1.8`
3. The [release workflow](.github/workflows/release.yml) automatically:
   - Downloads the relay binary for each platform from the relay's GitHub Release
   - Places it at `src-tauri/binaries/endara-relay-{target_triple}`
   - Builds the Tauri app for macOS (x86_64 + aarch64), Windows, and Linux
   - Creates a GitHub Release with platform installers (.dmg, .msi, .deb, .AppImage)

You can pin to a specific relay version by triggering the workflow manually with the `relay_version` input (defaults to `latest`).

### CI

On every push and PR, the CI workflow runs:
- Svelte check (type checking)
- Rust check (`cargo check` on the Tauri backend)
- PR title validation (conventional commits)

## Contributing

Contributions are welcome! Here's how to get started:

1. [Fork the repository](https://github.com/endara-ai/endara-desktop/fork)
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes and test with `cargo tauri dev`
4. Commit your changes (`git commit -m 'feat: add my feature'`)
5. Push to your fork (`git push origin feat/my-feature`)
6. [Open a Pull Request](https://github.com/endara-ai/endara-desktop/pulls)

Please make sure `npm run check` passes before submitting.

## Related Projects

- **[Endara Relay](https://github.com/endara-ai/endara-relay)** — The MCP relay server that Endara Desktop manages
- **[Endara](https://endara.ai)** — Project website
- **[endara-ai/homebrew-tap](https://github.com/endara-ai/homebrew-tap)** — Homebrew tap that ships the signed DMG and the headless relay CLI

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

```
Copyright 2025–2026 Endara AI

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
