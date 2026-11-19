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
GCS_BUCKET="gs://pkmn-arena"

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

umask 077
mkdir -p "$LOG_ROOT" "$COLD_DIR" "$BACKUP_DIR"

# 1. Daily SQLite backup of local Mac mini state DB (/opt/arena/state/arena.sqlite)
if [[ -f "$STATE_DB" ]]; then
  TODAY="$(date -u +%Y-%m-%d)"
  OUT_DB="${BACKUP_DIR}/arena-state-${TODAY}.sqlite"
  ESCAPED_OUT_DB="${OUT_DB//\'/\'\'}"
  sqlite3 -cmd ".timeout 10000" "$STATE_DB" ".backup '${ESCAPED_OUT_DB}'"
  zstd -19 --rm -f "$OUT_DB"
  find "$BACKUP_DIR" -name "arena-state-*.sqlite.zst" -mtime +30 -delete
fi

# 2. On the 1st of each month, bundle the previous month's .7z files into a single .tar
if [[ "$(date -u +%d)" == "01" ]]; then
  PREV_MONTH="$(date -u -v-1m +%Y-%m 2>/dev/null || date -u -d 'last month' +%Y-%m)"
  for LADDER_DIR in "$LOG_ROOT"/*; do
    [[ -d "${LADDER_DIR}/${PREV_MONTH}" ]] || continue
    TAR_PATH="${LADDER_DIR}/${PREV_MONTH}.tar"
    if [[ ! -f "$TAR_PATH" ]]; then
      tar -cf "$TAR_PATH" -C "$LADDER_DIR" "$PREV_MONTH"
      rm -rf "${LADDER_DIR:?}/${PREV_MONTH}"
    fi
  done
fi

# 3. Sync archives, cold agent bundles, and database backups to Google Cloud Storage
if command -v gcloud >/dev/null 2>&1 && [[ -n "${ARENA_GCS_SYNC:-}" ]]; then
  gcloud storage rsync -r "$LOG_ROOT" "${GCS_BUCKET}/archives"
  gcloud storage rsync -r "$COLD_DIR" "${GCS_BUCKET}/agents"
  gcloud storage rsync -r "$BACKUP_DIR" "${GCS_BUCKET}/db-backups"
fi
