#!/usr/bin/env bash
# harness-server.sh — start the DeepSeek Harness web server (pnpm dsh web).
#
# Cross-platform: works on Linux and on Windows Git Bash.
# This is the workspace's DEFAULT DEVELOPMENT INSTANCE (127.0.0.1:3080).
# Usage:
#   bash harness-server.sh                # default port 3080
#   PORT=8123 bash harness-server.sh      # custom port
#   WAIT=60 bash harness-server.sh        # longer startup wait (default 10s;
#                                         # a 10s miss is treated as a failure)
#   DSH_HOME=~/.dsh bash harness-server.sh  # override the home
#
# Steps:
#   [1/4] bootstrap this home's `web` profile with the workspace plugins
#   [2/4] kill whatever is listening on the port
#   [3/4] start `pnpm dsh web` in the background (nohup, output appended to $LOG)
#   [4/4] wait up to $WAIT seconds for the port; on failure dump the log tail
#
# Notes:
#   - Step [2/4] kills any process listening on $PORT (default 3080).
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
# Two homes, one per host:
#   ~/.dsh        the desktop app's own home (its built-in default)
#   ~/.dsh-web    this script's web server — port 3080, the workspace's default
#                 development instance
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
# CAVEAT: an explicit DSH_HOME in the environment WINS over this default (the
# `:-` below), so a machine-wide DSH_HOME (e.g. a User-scope variable pointing at
# ~/.dsh) silently defeats this isolation — that is exactly how a web instance
# once came up reading the desktop app's session list and account. Check with
# `[Environment]::GetEnvironmentVariable('DSH_HOME','User')` in PowerShell.
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
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"   # workspace root containing dsh-force-compact/

LOG="$(pwd)/dsh-web-${PORT}.log"   # log goes to the current directory (at invocation time); appended (>>) on each start

echo "[web] DSH_HOME      = $DSH_HOME"
echo "[web] port          = $PORT (bind $BIND_HOST)"
echo "[web] plugin src    = $PLUGIN_DIR"
echo "[web] log           = $LOG"

# ── [1/4] ensure THIS home's web profile carries the workspace plugins ───────
# The web home is its own home (see the DSH_HOME block), so it needs its own
# install; the desktop app's install does not reach it, and a home that was
# never bootstrapped would serve WITHOUT the plugins (the loopback no-auth
# plugin included, so the browser would ask for the launch token). Idempotent
# and cheap: `dsh plugin add` links the working tree, and a profile-manifest
# change is picked up live by the profile HMR watcher (packages/boot/hmr), so
# this is also safe to run against an instance that is already up.
PROFILE_MANIFEST="$DSH_HOME/profiles/web/package.json"
PLUGIN_NAMES=(dsh-force-compact dsh-local-no-auth dsh-web-ding dsh-start-command)
NEED_INSTALL=0
for name in "${PLUGIN_NAMES[@]}"; do
  if [ ! -f "$PROFILE_MANIFEST" ] || ! grep -q "@falling-ts/$name" "$PROFILE_MANIFEST"; then
    NEED_INSTALL=1
  fi
done
if [ "$NEED_INSTALL" = "1" ]; then
  echo "[1/4] Bootstrapping $DSH_HOME/profiles/web with the workspace plugins..."
  cd "$ROOT" || { echo "ERROR: repo root not found at $ROOT" >&2; exit 1; }
  command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found on PATH" >&2; exit 1; }
  PLUGIN_PATHS=()
  for name in "${PLUGIN_NAMES[@]}"; do PLUGIN_PATHS+=("$PLUGIN_DIR/$name"); done
  # "Y" answers pnpm's interactive reinstall prompt; a detached pnpm would hang on it.
  if echo Y | pnpm dsh plugin --profile web add "${PLUGIN_PATHS[@]}" >/dev/null 2>&1; then
    echo "      linked: ${PLUGIN_NAMES[*]}"
  else
    echo "      WARNING: bootstrap failed — the web instance will start WITHOUT the plugins" >&2
  fi
else
  echo "[1/4] $DSH_HOME/profiles/web already carries the workspace plugins"
fi

echo "[2/4] Stopping existing service on port $PORT..."
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
  echo "      (none found on $PORT)"
fi

echo "[3/4] Starting pnpm dsh web (--host $BIND_HOST --port $PORT) in the background..."
cd "$ROOT" || { echo "ERROR: repo root not found at $ROOT"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found on PATH"; exit 1; }
echo Y | nohup pnpm dsh web --host "$BIND_HOST" --port "$PORT" --no-open >> "$LOG" 2>&1 &
SRV_PID=$!
echo "      (server PID $SRV_PID, log: $LOG)"

echo "[4/4] Waiting for port $PORT (up to ${WAIT_SECS}s)..."
i=0
while [ "$i" -lt "$WAIT_SECS" ]; do
  if (exec 3<>"/dev/tcp/$BIND_HOST/$PORT") 2>/dev/null; then
    echo "OK: port $PORT is up -> http://$BIND_HOST:$PORT"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "ERROR: port $PORT did not open within ${WAIT_SECS}s. Last log lines:"
tail -n 40 "$LOG" 2>/dev/null
echo "(If pnpm is still reinstalling node_modules it may come up later; watch: tail -f $LOG)"
exit 1
