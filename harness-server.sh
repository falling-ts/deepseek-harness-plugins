#!/usr/bin/env bash
# harness-server.sh — start the DeepSeek Harness web server (pnpm dsh web).
#
# Cross-platform: works on Linux and on Windows Git Bash.
# Usage:
#   bash harness-server.sh                # default port 3080
#   PORT=8123 bash harness-server.sh      # custom port
#   WAIT=60 bash harness-server.sh        # longer startup wait (default 10s;
#                                         # a 10s miss is treated as a failure)
#
# Steps:
#   [1/3] kill whatever is listening on the port
#   [2/3] start `pnpm dsh web` in the background (nohup, output appended to $LOG)
#   [3/3] wait up to $WAIT seconds for the port; on failure dump the log tail
#
# Notes:
#   - Step [1/3] kills any process listening on $PORT (default 3080).
#   - `echo Y |` pipes "Y" into pnpm's stdin so the
#     "The modules directories will be removed and reinstalled from scratch.
#     Proceed? (Y/n)" prompt is answered automatically. Without a piped
#     answer, a detached (no-stdin) pnpm hangs on that prompt forever and
#     the port never opens.
#   - `--no-open` suppresses the automatic browser launch (background start).
#   - `DSH_HOME` defaults to the DSH home dir (~/.dsh) so plugin diagnostic
#     markers (e.g. thinking-effort-loaded.json) land there, not the repo.
set -u

PORT="${PORT:-3080}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
# Default timeout is short on purpose: if the port does not come up within 10s,
# treat the start as a failure (exiting non-zero) instead of blocking for minutes.
# Override with WAIT=<seconds> for genuinely slow machines (cold pnpm install, etc.).
WAIT_SECS="${WAIT:-10}"

# DSH_HOME defaults to the DSH home dir so plugins that write diagnostic
# markers (e.g. @hytime/dsh-thinking-effort -> thinking-effort-loaded.json)
# write there instead of the process cwd (repo root).
# Windows Git Bash: $USERPROFILE is the native Windows path (Node-safe);
# Linux: $HOME.
if [ -n "${USERPROFILE:-}" ]; then
  export DSH_HOME="${DSH_HOME:-$USERPROFILE/.dsh}"
else
  export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
fi

ROOT="$(cd "$(dirname "$0")/deepseek-harness" && pwd)"

LOG="$(pwd)/dsh-web-${PORT}.log"   # log goes to the current directory (at invocation time); appended (>>) on each start

echo "[1/3] Stopping existing service on port $PORT..."
PIDS="$(netstat -ano 2>/dev/null | tr -d '\r' | grep -E "[:.]${PORT}[[:space:]]" | grep -iE 'LISTEN' | awk '{print $NF}' | sed 's/\/.*//' | sort -u)"
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
  echo "      (none found)"
fi

echo "[2/3] Starting pnpm dsh web (--host $BIND_HOST --port $PORT) in the background..."
cd "$ROOT" || { echo "ERROR: repo root not found at $ROOT"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found on PATH"; exit 1; }
echo Y | nohup pnpm dsh web --host "$BIND_HOST" --port "$PORT" --no-open >> "$LOG" 2>&1 &
SRV_PID=$!
echo "      (server PID $SRV_PID, log: $LOG)"

echo "[3/3] Waiting for port $PORT (up to ${WAIT_SECS}s)..."
i=0
while [ "$i" -lt "$WAIT_SECS" ]; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    echo "OK: port $PORT is up -> http://127.0.0.1:$PORT"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "ERROR: port $PORT did not open within ${WAIT_SECS}s. Last log lines:"
tail -n 40 "$LOG" 2>/dev/null
echo "(If pnpm is still reinstalling node_modules it may come up later; watch: tail -f $LOG)"
exit 1
