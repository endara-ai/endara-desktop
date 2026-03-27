#!/usr/bin/env bash
# Copies the endara-relay binary into the Tauri sidecar binaries directory
# with the correct target-triple suffix.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

# Detect target triple
TARGET_TRIPLE="${TARGET_TRIPLE:-$(rustc --print host-tuple 2>/dev/null || rustc -vV | grep '^host:' | cut -d' ' -f2)}"

RELAY_BIN="$MONOREPO_DIR/packages/relay/target/release/endara-relay"
DEST_DIR="$DESKTOP_DIR/src-tauri/binaries"
DEST_BIN="$DEST_DIR/endara-relay-${TARGET_TRIPLE}"

# Check if relay binary exists
if [ ! -f "$RELAY_BIN" ]; then
    echo "Error: Relay binary not found at $RELAY_BIN"
    echo "Build it first: cd packages/relay && cargo build --release"
    exit 1
fi

# Ensure destination directory exists
mkdir -p "$DEST_DIR"

# Copy binary with target triple suffix
cp "$RELAY_BIN" "$DEST_BIN"
chmod +x "$DEST_BIN"

echo "Copied relay binary to $DEST_BIN"
echo "Target triple: $TARGET_TRIPLE"

