#!/usr/bin/env bash
# arena/scripts/maintenance.sh
# Nightly 10:00 UTC maintenance wrapper invoked by `ai.pkmn.maintenance.plist`:
#   1. Acquires `/opt/arena/state/maintenance.lock` (PID-checked) so `ai.pkmn.arena` holds off
#      starting new matches while sending idle heartbeats.
#   2. Waits for any in-flight match (`/opt/arena/state/match.lock`) to finish cleanly.
#   3. Runs `archive.sh` (SQLite backup, monthly tar rollup, GCS rsync).
#   4. Runs a non-fatal macOS `softwareupdate --list` check and stashes the result in
#      `/opt/arena/state/updates-status.json` so `softwareupdated` never wakes mid-match.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${ARENA_STATE_DIR:-/opt/arena/state}"
MAINT_LOCK="${STATE_DIR}/maintenance.lock"
MATCH_LOCK="${STATE_DIR}/match.lock"
UPDATES_FILE="${STATE_DIR}/updates-status.json"
MAX_WAIT_SECONDS="${ARENA_MAINT_WAIT_SECONDS:-900}"

umask 077
mkdir -p "$STATE_DIR"

pid_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

cleanup() {
  if [[ -f "$MAINT_LOCK" ]]; then
    local owner=""
    owner="$(cat "$MAINT_LOCK" 2>/dev/null || true)"
    if [[ "$owner" == "$$" ]]; then
      rm -f "$MAINT_LOCK"
    fi
  fi
}
trap cleanup EXIT

# Signal `ai.pkmn.arena` to pause scheduling new matches until this maintenance window finishes.
printf '%s\n' "$$" > "${MAINT_LOCK}.tmp.$$"
mv -f "${MAINT_LOCK}.tmp.$$" "$MAINT_LOCK"

# Wait for any in-flight match to finish (clearing stale locks whose PID is no longer alive).
WAITED=0
while [[ -f "$MATCH_LOCK" ]]; do
  MATCH_PID="$(cat "$MATCH_LOCK" 2>/dev/null || true)"
  if ! pid_alive "$MATCH_PID"; then
    rm -f "$MATCH_LOCK"
    break
  fi
  if (( WAITED >= MAX_WAIT_SECONDS )); then
    echo "WARNING: match.lock (PID ${MATCH_PID}) still held after ${MAX_WAIT_SECONDS}s; proceeding" >&2
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

ARCHIVE_RC=0
"${SCRIPT_DIR}/archive.sh" || ARCHIVE_RC=$?

# Non-fatal macOS Software Update check (separated from archive.sh; never fails the archive job).
if [[ "$(uname -s)" == "Darwin" ]] && [[ -x /usr/sbin/softwareupdate ]] && command -v node >/dev/null 2>&1; then
  SW_OUT="$(/usr/sbin/softwareupdate --list 2>&1 || true)"
  UPDATES_FILE="$UPDATES_FILE" SW_OUT="$SW_OUT" node -e '
    const fs = require("fs");
    const sw = process.env.SW_OUT || "";
    if (!/No new software available|\*\s*Label:/i.test(sw)) process.exit(0);
    const labels = [];
    let rebootRequired = false;
    for (const line of sw.split("\n")) {
      const m = /^\s*\*\s*Label:\s*(.+)$/.exec(line);
      if (m) labels.push(m[1].trim());
      if (/Action:\s*restart/i.test(line)) rebootRequired = true;
    }
    const payload = {
      pending: labels.length,
      rebootRequired,
      checkedAt: Math.floor(Date.now() / 1000),
      ...(labels.length > 0 ? {summary: labels.slice(0, 3).join(", ")} : {}),
    };
    const file = process.env.UPDATES_FILE;
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload) + "\n", {mode: 0o600});
    fs.renameSync(tmp, file);
  ' >/dev/null 2>&1 || true
fi

exit "$ARCHIVE_RC"
