# Endara Desktop

**A native tray application for managing the [Endara Relay](https://github.com/endara-ai/endara-relay).** Lives in your menu bar, keeps the relay running, and gives you a clean UI to monitor endpoints, browse tools, and view logs.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte_5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/endara-ai/endara-desktop/releases)

<!-- TODO: Add screenshot showing the main UI — sidebar with endpoints on the left, detail panel with tools/logs/config tabs on the right -->

## What is this?

Endara Desktop is a lightweight system tray application that wraps the [Endara Relay](https://github.com/endara-ai/endara-relay) — an MCP (Model Context Protocol) relay server that aggregates multiple MCP tool servers behind a single endpoint.

Instead of running the relay manually from a terminal, Endara Desktop gives you a single install that manages everything. It bundles the relay binary as a [Tauri sidecar](https://v2.tauri.app/plugin/shell/#spawning-a-sidecar), automatically starts it on launch, monitors its health, restarts it if it crashes, and kills it cleanly on quit.

The app provides a visual interface for everything the relay exposes: endpoint health at a glance, a searchable tool browser, real-time log output, and configuration inspection — all from a compact tray-app UI inspired by [Tailscale](https://tailscale.com/).

## Download

Download the latest release from [GitHub Releases](https://github.com/endara-ai/endara-desktop/releases).

| Platform | Format | File |
|----------|--------|------|
| 🍎 macOS | DMG installer | `Endara_x.x.x_aarch64.dmg` |
| 🪟 Windows | Setup installer | `Endara_x.x.x_x64-setup.exe` |
| 🪟 Windows | MSI installer | `Endara_x.x.x_x64_en-US.msi` |
| 🐧 Linux | Debian package | `endara_x.x.x_amd64.deb` |
| 🐧 Linux | AppImage | `Endara_x.x.x_amd64.AppImage` |

Or [build from source](#development) if you prefer.

## Features

- **System tray integration** — Runs in your menu bar / system tray, always available without cluttering your workspace
- **Relay lifecycle management** — Auto-starts the relay on launch, monitors it, auto-restarts on crash, kills on quit
- **Endpoint dashboard** — View all configured MCP server endpoints with live health indicators (🟢 healthy / 🟡 degraded / 🔴 down)
- **Tool browser** — Browse and search all tools exposed by each endpoint
- **Real-time logs** — Stream log output from each endpoint as it happens
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

**Backend (Rust):** Manages the relay as a sidecar process — spawning, monitoring stdout/stderr, handling crashes with auto-restart, and clean shutdown on exit. Exposes four Tauri commands: `start_relay`, `stop_relay`, `restart_relay`, and `relay_status`.

**Frontend (SvelteKit):** Talks to the relay's management API to fetch endpoint status, tools, logs, and configuration. The UI is composed of 12 Svelte components organized around a sidebar + detail panel layout.

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
│   │   ├── components/            # 12 Svelte UI components
│   │   │   ├── Sidebar.svelte     # Left panel — endpoint list + status
│   │   │   ├── DetailPanel.svelte # Right panel — tabbed endpoint details
│   │   │   ├── ToolsTab.svelte    # Tool browser with search
│   │   │   ├── LogsTab.svelte     # Real-time log viewer
│   │   │   ├── ConfigTab.svelte   # Configuration viewer
│   │   │   ├── SearchBar.svelte   # Global search (⌘K)
│   │   │   ├── Settings.svelte    # App settings panel
│   │   │   ├── EndpointRow.svelte # Individual endpoint in sidebar
│   │   │   ├── HealthDot.svelte   # Health status indicator
│   │   │   ├── TransportBadge.svelte # Transport type badge (STDIO/SSE/HTTP)
│   │   │   ├── ConfirmModal.svelte   # Confirmation dialogs
│   │   │   └── MiniPlayer.svelte     # Compact endpoint status view
│   │   ├── api.ts                 # API client for relay management
│   │   ├── stores.ts              # Svelte stores for app state
│   │   ├── types.ts               # TypeScript type definitions
│   │   └── mock.ts                # Mock data for development
│   ├── app.css                    # Global styles (Tailwind)
│   └── app.html                   # HTML shell
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                 # Tauri backend — sidecar lifecycle + commands
│   │   └── main.rs                # Entry point
│   ├── tauri.conf.json            # Tauri config (bundling, updater, sidecar)
│   ├── capabilities/default.json  # Permissions (shell, updater)
│   ├── binaries/                  # Relay sidecar binary (not committed)
│   └── icons/                     # App icons for all platforms
├── scripts/
│   └── copy-sidecar.sh            # Helper to copy relay binary for bundling
├── package.json
└── LICENSE                        # Apache-2.0
```

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

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

```
Copyright 2025 Endara

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
