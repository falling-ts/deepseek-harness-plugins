#!/usr/bin/env bash
# Verify the launcher scripts resolve DSH_HOME to the web home in every shell
# situation, using a stub pnpm (no server is started). The stub's stdout lands
# in the script's log, so each run clears the log first and reads the last stub
# line back out of it. GNU env requires -u options BEFORE NAME=VALUE pairs.
# Usage: bash <this-file> [harness-server.sh|harness-server-dev.sh]
HERE="$(cd "$(dirname "$0")" && pwd)"
STUB="$HERE"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT" || exit 1
SCRIPT="${1:-harness-server-dev.sh}"
echo "shell: bash $BASH_VERSION   USERPROFILE=${USERPROFILE:-<unset>}   DSH_HOME=${DSH_HOME:-<unset>}"
echo "cmd.exe interop: $(cmd.exe /c echo %USERPROFILE% 2>/dev/null | tr -d '\r\n')"

report() {
  local label="$1" rc="$2" out="$3"
  echo "--- $label   (script exit=$rc)"
  printf '%s\n' "$out" | grep -m1 '^\[dev\] DSH_HOME' | sed 's/^/    /'
  printf '%s\n' "$out" | grep 'STUB pnpm: DSH_HOME' | tail -1 | sed 's/^/    (stub) /'
}

run_default_no_profile() {
  rm -f dsh-web-3080.log dsh-web-dev-3180.log
  local out rc
  out="$(env -u USERPROFILE -u DSH_HOME PATH="$STUB:$PATH" WAIT=1 bash "$SCRIPT" 2>&1)"; rc=$?
  report "A) USERPROFILE 未导出（默认值）" "$rc" "$out"
}

run_default_gitbash() {
  rm -f dsh-web-3080.log dsh-web-dev-3180.log
  local out rc
  out="$(env -u DSH_HOME USERPROFILE='C:\Users\zghyu' PATH="$STUB:$PATH" WAIT=1 bash "$SCRIPT" 2>&1)"; rc=$?
  report "B) USERPROFILE 有值（Git Bash 常态，默认值）" "$rc" "$out"
}

run_override() {
  local value="$1" label="$2"
  rm -f dsh-web-3080.log dsh-web-dev-3180.log
  local out rc
  out="$(env USERPROFILE='C:\Users\zghyu' DSH_HOME="$value" PATH="$STUB:$PATH" WAIT=1 bash "$SCRIPT" 2>&1)"; rc=$?
  report "$label" "$rc" "$out"
}

echo "== defaults (DSH_HOME absent) =="
run_default_no_profile
run_default_gitbash
echo "== override still wins =="
run_override 'C:\Users\zghyu\.dsh' "C) DSH_HOME=~/.dsh"
run_override 'C:\Users\zghyu\.dsh-dev' "D) DSH_HOME=~/.dsh-dev"
