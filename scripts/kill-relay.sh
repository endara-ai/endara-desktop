#!/usr/bin/env bash
# Kill any running relay process before dev restart

CONFIG="$HOME/.endara/config.toml"
PORT=9400

# Try to read port from config
if [ -f "$CONFIG" ]; then
  PARSED_PORT=$(grep -A5 '\[relay\]' "$CONFIG" | grep '^port' | head -1 | sed 's/.*= *//' | tr -d ' ')
  if [ -n "$PARSED_PORT" ] && [ "$PARSED_PORT" -gt 0 ] 2>/dev/null; then
    PORT=$PARSED_PORT
  fi
fi

# Kill whatever is on that port
PIDS=$(lsof -ti ":$PORT" 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "[dev] Killing existing relay on port $PORT (pids: $PIDS)"
  echo "$PIDS" | xargs kill 2>/dev/null
fi

