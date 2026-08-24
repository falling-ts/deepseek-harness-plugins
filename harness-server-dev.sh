#!/usr/bin/env bash
# harness-server-dev.sh — start a DEV copy of the DeepSeek Harness web server.
#
# A sibling of harness-server.sh that NEVER touches port 3080. It spins up an
# isolated `pnpm dsh web` on its own port (default 3180) reusing the same
# DSH_HOME profile/plugins, so new plugin source can be exercised without
# interrupting the primary 3080 instance that your current session rides on.
#
# Usage:
#   bash harness-server-dev.sh              # default port 3180
#   DEV_PORT=3280 bash harness-server-dev.sh
#   PORT=3280 bash harness-server-dev.sh    # PORT also honored (falls back to DEV_PORT)
#   WAIT=60 bash harness-server-dev.sh      # longer startup wait (default 10s;
#                                           # a 10s miss is treated as a failure)
#
# Differences from harness-server.sh:
#   - Kills ONLY whatever listens on DEV_PORT (never 3080).
#   - Logs to ./dsh-web-dev-<DEV_PORT>.log (distinct from the main 3080 log).
#   - Prints the effective DSH_HOME + plugin dir so the loaded source is auditable.
set -u

# Dev instance port. DEV_PORT wins; PORT (honored for parity) is the fallback;
# 3180 is the final default. Never targets 3080.
DEV_PORT="${DEV_PORT:-${PORT:-3180}}"
if [ "$DEV_PORT" = "3080" ]; then
  echo "REFUSING to target 3080 (the primary session port). Pass a different DEV_PORT." >&2
  exit 1
fi
BIND_HOST="${BIND_HOST:-127.0.0.1}"
# Default timeout is short on purpose: if the port does not come up within 10s,
# treat the start as a failure (exiting non-zero) instead of blocking for minutes.
# Override with WAIT=<seconds> for genuinely slow machines (cold pnpm install, etc.).
WAIT_SECS="${WAIT:-10}"

# Same DSH_HOME as the main script so the identical profile/plugins (including
# the freshly-edited dsh-force-compact source) are loaded.
if [ -n "${USERPROFILE:-}" ]; then
  export DSH_HOME="${DSH_HOME:-$USERPROFILE/.dsh}"
else
  export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
fi

ROOT="$(cd "$(dirname "$0")/deepseek-harness" && pwd)"
PLUGIN_DIR="$ROOT/.."            # workspace root containing dsh-force-compact/
PLUGIN_SRC="$PLUGIN_DIR/dsh-force-compact"

# Log alongside the script, distinct from the main 3080 log. Appended (>>) so
# repeated starts accumulate like the main script (each kill leaves an
# [ELIFECYCLE] exit-code marker).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/dsh-web-dev-${DEV_PORT}.log"

echo "[dev] DSH_HOME      = $DSH_HOME"
echo "[dev] port          = $DEV_PORT (bind $BIND_HOST)"
echo "[dev] plugin src    = $PLUGIN_SRC"
echo "[dev] log           = $LOG"

echo "[1/3] Stopping any existing service on port $DEV_PORT..."
PIDS="$(netstat -ano 2>/dev/null | tr -d '\r' | grep -E "[:.]${DEV_PORT}[[:space:]]" | grep -iE 'LISTEN' | awk '{print $NF}' | sed 's/\/.*//' | sort -u)"
if [ -n "$PIDS" ]; then
  for PID in $PIDS; do
    if command -v taskkill >/dev/null 2>&1; then
      MSYS_NO_PATHCONV=1 taskkill /F /T /PID "$PID" >/dev/null 2>&1 || true
    else
      kill -9 "$PID" 2>/dev/null || true
    fi
  done
  sleep 1
else
  echo "      (none found on $DEV_PORT)"
fi

cd "$ROOT" || { echo "ERROR: repo root not found at $ROOT" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found on PATH" >&2; exit 1; }
# Pipe "Y" into pnpm stdin so the "modules will be removed and reinstalled.
# Proceed?" prompt is auto-answered (without it a detached pnpm hangs forever).
# NOTE: `dsh web` has NO --patch option. The `force-compact` entry is activated
# through the profile's own cordis.patch.yml referencing the installed package's
# `dsh.bundle.patch` layer — so this launch relies on the profile having the
# plugin installed (via `dsh plugin add`) and referenced, NOT on a CLI overlay.
echo Y | nohup pnpm dsh web --host "$BIND_HOST" --port "$DEV_PORT" --no-open >> "$LOG" 2>&1 &
SRV_PID=$!
echo "      (server PID $SRV_PID, log: $LOG)"

echo "[3/3] Waiting for port $DEV_PORT (up to ${WAIT_SECS}s)..."
i=0
while [ "$i" -lt "$WAIT_SECS" ]; do
  if (exec 3<>"/dev/tcp/$BIND_HOST/$DEV_PORT") 2>/dev/null; then
    echo "OK: port $DEV_PORT is up -> http://$BIND_HOST:$DEV_PORT"
    echo "      Next: confirm the dev instance loaded the NEW plugin source by"
    echo "      checking for the first line of the debug log (see below)."
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "ERROR: port $DEV_PORT did not open within ${WAIT_SECS}s. Last log lines:"
tail -n 40 "$LOG" 2>/dev/null
echo "(If pnpm is still reinstalling node_modules it may come up later; watch: tail -f $LOG)"
exit 1
