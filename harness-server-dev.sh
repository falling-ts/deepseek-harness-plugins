#!/usr/bin/env bash
# harness-server-dev.sh — start a DEV copy of the DeepSeek Harness web server.
#
# A sibling of harness-server.sh that NEVER touches port 3080. It spins up an
# isolated `pnpm dsh web` on its own port (default 3180) so new plugin source can
# be exercised without interrupting the primary web instance (3080) or the
# desktop app.
#
# THREE HOMES, ON PURPOSE (one per host):
#   ~/.dsh        the desktop app's own home (its built-in default)
#   ~/.dsh-web    the primary web server (harness-server.sh, port 3080)
#   ~/.dsh-dev    this dev instance (port 3180)
# A session directory is guarded by a cross-process write lease (single writer,
# enforced by the kernel — packages/session/session-persistence-jsonl/src/lease.ts),
# so two hosts sharing one home refuse each other's sessions with
# `session/writer-held`, which the client renders as "当前会话已被占用…".
# Each host therefore gets its own home. Note the dev home is NOT the web home:
# sharing those two would make a dev experiment fight the 3080 instance over the
# same sessions.
#
# Because the home is separate, this profile needs its own plugin install; the
# script bootstraps it (see step [1/4]) by linking the workspace plugins below
# into ~/.dsh-dev/profiles/web. Links point at the working tree, so editing a
# plugin's source is picked up without reinstalling.
#
# Usage:
#   bash harness-server-dev.sh              # default port 3180
#   DEV_PORT=3280 bash harness-server-dev.sh
#   PORT=3280 bash harness-server-dev.sh    # PORT also honored (falls back to DEV_PORT)
#   WAIT=60 bash harness-server-dev.sh      # longer startup wait (default 10s;
#                                           # a 10s miss is treated as a failure)
#   DSH_HOME=~/.dsh-dev bash harness-server-dev.sh   # override the home
#
# Differences from harness-server.sh:
#   - Kills ONLY whatever listens on DEV_PORT (never 3080).
#   - Logs to ./dsh-web-dev-<DEV_PORT>.log (distinct from the main 3080 log).
#   - Uses its own home (~/.dsh-dev) and bootstraps the workspace plugins there.
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

# This instance's own home: ~/.dsh-dev, deliberately NOT ~/.dsh-web (the primary
# web server's home, see harness-server.sh) and NOT ~/.dsh (the desktop app's).
# Each host owns a home so none of them can take another's session write lease.
# Point a run elsewhere with DSH_HOME=... (a throwaway home is fine).
#
# NOTE an explicit DSH_HOME in the environment WINS over this default (`:-`), so
# a machine-wide DSH_HOME would silently defeat this isolation — that is exactly
# how the web instance once ended up reading the desktop app's sessions.
#
# Git Bash exports $USERPROFILE; a shell that does not (WSL bash, $HOME=/home/x)
# cannot be fixed up from inside — cmd.exe interop inherits the same missing
# variable — so that case warns instead of handing the Windows Node a POSIX
# path it would resolve against the current drive.
if [ -n "${USERPROFILE:-}" ]; then
  export DSH_HOME="${DSH_HOME:-$USERPROFILE/.dsh-dev}"
else
  export DSH_HOME="${DSH_HOME:-$HOME/.dsh-dev}"
  echo "WARNING: USERPROFILE is not exported, so DSH_HOME defaulted to $DSH_HOME" >&2
  echo "         — Windows Node resolves that POSIX path against the current drive." >&2
  echo "         Launch from Git Bash, or export DSH_HOME explicitly." >&2
fi

# pnpm 11 auto-installs before every script (`verify-deps-before-run` default
# "install"); in this git-submodule checkout the lefthook postinstall always
# fails, so the pre-run install aborts the server start. Disable it; node_modules
# is already synced.
export pnpm_config_verify_deps_before_run=false

# (2026-09) The old DSH_WEB_NO_AUTH env-var patch lived inside upstream
# client-connection sources and was removed: upstream stays untouched now.
# Loopback no-auth comes from the @falling-ts/dsh-local-no-auth bundle in the
# web profile (it replaces the connection instance's auth methods at runtime).
# No environment variable to export here.

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

# ── [1/4] ensure THIS home's web profile carries the workspace plugins ───────
# The dev home is its own home (see the DSH_HOME block), so it needs its own
# install; the main web home's install does not reach it. Idempotent and cheap:
# `dsh plugin add` links the working tree, and a profile-manifest change is picked
# up live by the profile HMR watcher (packages/boot/hmr), so this is also safe to
# run against an instance that is already up.
PROFILE_MANIFEST="$DSH_HOME/profiles/web/package.json"
PLUGIN_NAMES=(dsh-force-compact dsh-local-no-auth dsh-web-ding)
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
    echo "      WARNING: bootstrap failed — the dev instance will start WITHOUT the plugins" >&2
  fi
else
  echo "[1/4] $DSH_HOME/profiles/web already carries the workspace plugins"
fi

echo "[2/4] Stopping any existing service on port $DEV_PORT..."
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

echo "[3/4] Starting pnpm dsh web (--host $BIND_HOST --port $DEV_PORT) in the background..."
cd "$ROOT" || { echo "ERROR: repo root not found at $ROOT" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found on PATH" >&2; exit 1; }
# Pipe "Y" into pnpm stdin so the "modules will be removed and reinstalled.
# Proceed?" prompt is auto-answered (without it a detached pnpm hangs forever).
# The plugins are activated through the profile's dsh.profile.bundles list plus
# each plugin package's own `dsh.bundle.patch` declaration — installed and
# referenced by [1/4] above, not overlaid from the CLI.
echo Y | nohup pnpm dsh web --host "$BIND_HOST" --port "$DEV_PORT" --no-open >> "$LOG" 2>&1 &
SRV_PID=$!
echo "      (server PID $SRV_PID, log: $LOG)"

echo "[4/4] Waiting for port $DEV_PORT (up to ${WAIT_SECS}s)..."
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
