#!/usr/bin/env bash
# arena/scripts/archive.sh
# Daily SQLite WAL-safe .backup + zstd, 1st-of-month .tar rollup, and GCS rsync on the Mac mini.
# (Daily `.7z` log compression and `<ladderId>-logs.tar` upload are owned by `arena/coordinator.ts`.)
set -euo pipefail
shopt -s nullglob

if [[ -f /opt/arena/repo/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /opt/arena/repo/.env
  set +a
fi

ARCHIVE_ROOT="/Volumes/Archive"
LOG_ROOT="${ARCHIVE_ROOT}/logs"
COLD_DIR="${ARCHIVE_ROOT}/cold-agents"
BACKUP_DIR="${ARCHIVE_ROOT}/db-backups"
STATE_DB="/opt/arena/state/arena.sqlite"
STATUS_FILE="/opt/arena/state/archive-status.json"
GCS_BUCKET="gs://pkmn-arena"
STAGE_DIR="/Volumes/Staging"
[[ -d "$STAGE_DIR" ]] || STAGE_DIR="${TMPDIR:-/tmp}"

umask 077
ERR_LOG="${STAGE_DIR}/archive-err.$$.log"
TMP_DB=""
TMP_ZST=""
TMP_TAR=""
BACKUP_AT=""
BACKUP_BYTES=""
GCS_SYNCED_AT=""
write_status() {
  local err_msg="${1:-}"
  [[ -d "$(dirname "$STATUS_FILE")" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  STATUS_FILE="$STATUS_FILE" BACKUP_AT="$BACKUP_AT" BACKUP_BYTES="$BACKUP_BYTES" \
    GCS_SYNCED_AT="$GCS_SYNCED_AT" ERR_MSG="$err_msg" node -e '
      const fs = require("fs");
      const file = process.env.STATUS_FILE;
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const now = Math.floor(Date.now() / 1000);
      const next = {
        ...prev,
        completedAt: now,
        ...(process.env.BACKUP_AT ? {backupAt: Number(process.env.BACKUP_AT)} : {}),
        ...(process.env.BACKUP_BYTES ? {backupBytes: Number(process.env.BACKUP_BYTES)} : {}),
        ...(process.env.GCS_SYNCED_AT ? {gcsSyncedAt: Number(process.env.GCS_SYNCED_AT)} : {}),
      };
      if (process.env.ERR_MSG) {
        next.error = process.env.ERR_MSG;
        next.errorAt = now;
      } else {
        delete next.error;
        delete next.errorAt;
      }
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next) + "\n", {mode: 0o600});
      fs.renameSync(tmp, file);
    ' >/dev/null 2>&1 || true
}
on_exit() {
  local rc=$?
  exec 2>&3
  if [[ -f "$ERR_LOG" ]]; then
    cat "$ERR_LOG" >&2
  fi
  if [[ "$rc" -ne 0 ]]; then
    local detail=""
    if [[ -f "$ERR_LOG" ]]; then
      detail="$(tail -n 5 "$ERR_LOG" 2>/dev/null | tr '\n' ' ' | cut -c1-240 || true)"
    fi
    write_status "${detail:-archive.sh exited ${rc}}"
  fi
  if [[ "$rc" -ne 0 && -n "${ARENA_SECRET:-}" ]] && command -v node >/dev/null 2>&1; then
    ARENA_ALERT_RC="$rc" ARENA_ALERT_LOG="$ERR_LOG" node -e '
      const fs = require("fs");
      const url = (process.env.ARENA_SERVER_URL || "http://127.0.0.1:1234").replace(/\/+$/, "");
      const detail = fs.existsSync(process.env.ARENA_ALERT_LOG)
        ? fs.readFileSync(process.env.ARENA_ALERT_LOG, "utf8").trim().slice(-3072)
        : "";
      fetch(`${url}/api/arena/alert`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.ARENA_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          key: "arena-archive",
          message: `Nightly arena archive failed (exit ${process.env.ARENA_ALERT_RC})`,
          ...(detail ? {detail} : {}),
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    ' >/dev/null 2>&1 || true
  fi
  [[ -n "$TMP_DB" ]] && rm -f "$TMP_DB" "${TMP_DB}.zst"
  [[ -n "$TMP_ZST" ]] && rm -f "$TMP_ZST"
  [[ -n "$TMP_TAR" ]] && rm -f "$TMP_TAR"
  rm -f "$ERR_LOG"
}
exec 3>&2 2>"$ERR_LOG"
trap on_exit EXIT

# Guard against silently writing into the internal rootfs if the external APFS drive is unmounted
if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! mount | grep -q " on /Volumes/Archive "; then
    sudo -n /usr/sbin/diskutil mount Archive >/dev/null 2>&1 ||
      /usr/sbin/diskutil mount Archive >/dev/null 2>&1 || true
  fi
  if ! mount | grep -q " on /Volumes/Archive "; then
    echo "ERROR: /Volumes/Archive is not mounted; aborting archive.sh" >&2
    exit 1
  fi
fi

mkdir -p "$LOG_ROOT" "$COLD_DIR" "$BACKUP_DIR"

# 1. Daily SQLite backup of local Mac mini state DB (/opt/arena/state/arena.sqlite).
# Stage `.backup` + `zstd` on internal `/Volumes/Staging` so non-Apple Homebrew `zstd` never
# touches external USB `/Volumes/Archive` under macOS TCC, then install atomically via `/bin/cp`.
if [[ -f "$STATE_DB" ]]; then
  TODAY="$(date -u +%Y-%m-%d)"
  OUT_ZST="${BACKUP_DIR}/arena-state-${TODAY}.sqlite.zst"
  TMP_DB="${STAGE_DIR}/arena-state-${TODAY}.$$.sqlite"
  TMP_ZST="${OUT_ZST}.tmp.$$"
  ESCAPED_TMP_DB="${TMP_DB//\'/\'\'}"
  sqlite3 -cmd ".timeout 10000" "$STATE_DB" ".backup '${ESCAPED_TMP_DB}'"
  zstd -19 --rm -f "$TMP_DB"
  cp "${TMP_DB}.zst" "$TMP_ZST"
  mv -f "$TMP_ZST" "$OUT_ZST"
  rm -f "${TMP_DB}.zst"
  TMP_DB=""
  TMP_ZST=""
  BACKUP_AT="$(date -u +%s)"
  BACKUP_BYTES="$(stat -f%z "$OUT_ZST" 2>/dev/null || stat -c%s "$OUT_ZST" 2>/dev/null || echo "")"
  find "$BACKUP_DIR" -name "arena-state-*.sqlite.zst" -mtime +30 -delete
fi

# 2. On the 1st of each month, bundle the previous month's .7z files into a single .tar
if [[ "$(date -u +%d)" == "01" ]]; then
  PREV_MONTH="$(date -u -v-1m +%Y-%m 2>/dev/null || date -u -d 'last month' +%Y-%m)"
  for LADDER_DIR in "$LOG_ROOT"/*; do
    [[ -d "${LADDER_DIR}/${PREV_MONTH}" ]] || continue
    TAR_PATH="${LADDER_DIR}/${PREV_MONTH}.tar"
    if [[ ! -f "$TAR_PATH" ]]; then
      TMP_TAR="${TAR_PATH}.tmp.$$"
      rm -f "$TMP_TAR"
      if tar -cf "$TMP_TAR" -C "$LADDER_DIR" "$PREV_MONTH"; then
        mv -f "$TMP_TAR" "$TAR_PATH"
        rm -rf "${LADDER_DIR:?}/${PREV_MONTH}"
      else
        rm -f "$TMP_TAR"
        exit 1
      fi
    fi
  done
fi

# 3. Sync archives, cold agent bundles, and database backups to Google Cloud Storage
if command -v gcloud >/dev/null 2>&1 && [[ -n "${ARENA_GCS_SYNC:-}" ]]; then
  gcloud storage rsync -r "$LOG_ROOT" "${GCS_BUCKET}/archives"
  gcloud storage rsync -r "$COLD_DIR" "${GCS_BUCKET}/agents"
  gcloud storage rsync -r "$BACKUP_DIR" "${GCS_BUCKET}/db-backups"
  # Verify today's backup actually reached GCS: Python's `os.walk` inside `gcloud storage rsync`
  # silently ignores macOS TCC `EPERM` on `/Volumes/Archive` and exits 0 after uploading nothing.
  if [[ -n "${OUT_ZST:-}" && -f "$OUT_ZST" ]]; then
    BACKUP_NAME="$(basename "$OUT_ZST")"
    if ! gcloud storage ls "${GCS_BUCKET}/db-backups/${BACKUP_NAME}" >/dev/null 2>&1; then
      echo "ERROR: GCS sync did not upload ${BACKUP_NAME} (check macOS Full Disk Access for gcloud's Python binary)" >&2
      exit 1
    fi
  fi
  GCS_SYNCED_AT="$(date -u +%s)"
fi

write_status ""
