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
#   - `DSH_HOME` defaults to ~/.dsh-web (NOT ~/.dsh) so plugin diagnostic markers
#     (e.g. thinking-effort-loaded.json) land there, not the repo, and so this web
#     server never shares a session store with the desktop app. See the DSH_HOME
#     block below for why the two homes are kept apart.
set -u

PORT="${PORT:-3080}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
# Default timeout is short on purpose: if the port does not come up within 10s,
# treat the start as a failure (exiting non-zero) instead of blocking for minutes.
# Override with WAIT=<seconds> for genuinely slow machines (cold pnpm install, etc.).
WAIT_SECS="${WAIT:-10}"

# DSH_HOME defaults to ~/.dsh-web, a home OWNED BY THE WEB SERVER.
#
# Why not ~/.dsh (2026-09-30): the installed desktop app keeps using ~/.dsh. A
# session directory is guarded by a cross-process write lease (single writer,
# enforced by the kernel — see packages/session/session-persistence-jsonl/
# src/lease.ts), so when both hosts share one home the second one is refused
# with `session/writer-held`, which the client renders as "当前会话已被占用…".
# A dsh web instance takes that lease on every session it restores, including
# the session the desktop currently has open — this web server therefore gets
# its own home and cannot touch the desktop's sessions.
#
# Override to re-share the desktop home: DSH_HOME=~/.dsh bash harness-server.sh
#
# Git Bash exports $USERPROFILE (a native Windows path, Node-safe). A shell that
# does not export it — WSL bash, where $HOME is /home/<user> — cannot be fixed
# up from inside: cmd.exe interop inherits the very environment that lacks the
# variable. So that case says so loudly instead of handing the Windows Node a
# POSIX path it would resolve against the current drive.
if [ -n "${USERPROFILE:-}" ]; then
  export DSH_HOME="${DSH_HOME:-$USERPROFILE/.dsh-web}"
else
  export DSH_HOME="${DSH_HOME:-$HOME/.dsh-web}"
  echo "WARNING: USERPROFILE is not exported, so DSH_HOME defaulted to $DSH_HOME" >&2
  echo "         — Windows Node resolves that POSIX path against the current drive." >&2
  echo "         Launch from Git Bash, or export DSH_HOME explicitly." >&2
fi

# pnpm 11 runs `pnpm install` before every script (`verify-deps-before-run`
# defaults to "install") whenever its status check deems node_modules out of
# sync. This repo is a git submodule, so the lefthook postinstall always fails
# (core.worktree lives in the common config) and that auto-install kills the
# server start. Disable the pre-run install; node_modules is already synced.
export pnpm_config_verify_deps_before_run=false

# (2026-09) The old DSH_WEB_NO_AUTH env-var patch lived inside upstream
# client-connection sources and was removed: upstream stays untouched now.
# Loopback no-auth comes from the @falling-ts/dsh-local-no-auth bundle in the
# web profile (it replaces the connection instance's auth methods at runtime).
# No environment variable to export here.

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
