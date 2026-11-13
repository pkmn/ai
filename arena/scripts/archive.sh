#!/usr/bin/env bash
# arena/scripts/archive.sh
# Nightly battle log compression (.7z solid LZMA2), monthly .tar GCS rollup,
# and daily SQLite WAL-safe .backup + zstd compression on the Mac mini.
set -euo pipefail

ARCHIVE_ROOT="${ARENA_ARCHIVE_DIR:-/Volumes/Archive}"
LOG_ROOT="${ARCHIVE_ROOT}/logs"
BACKUP_DIR="${ARCHIVE_ROOT}/db-backups"
STATE_DB="${ARENA_STATE_DB:-/opt/arena/state/arena.sqlite}"
GCS_BUCKET="${ARENA_GCS_BUCKET:-gs://pkmn-arena}"

mkdir -p "$LOG_ROOT" "$BACKUP_DIR"

# 1. Daily SQLite backup of local Mac mini state DB (/opt/arena/state/arena.sqlite)
if [[ -f "$STATE_DB" ]]; then
  TODAY="$(date -u +%Y-%m-%d)"
  OUT_DB="${BACKUP_DIR}/arena-state-${TODAY}.sqlite"
  sqlite3 "$STATE_DB" ".backup '${OUT_DB}'"
  zstd -19 --rm -f "$OUT_DB"
  find "$BACKUP_DIR" -name "arena-state-*.sqlite.zst" -mtime +30 -delete
fi

# 2. Nightly solid .7z compression of yesterday's raw .log directories per ladder
YESTERDAY="$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d 'yesterday' +%Y-%m-%d)"
YEAR_MONTH="${YESTERDAY:0:7}"

if [[ -d "$LOG_ROOT" ]]; then
  for LADDER_DIR in "$LOG_ROOT"/*; do
    [[ -d "$LADDER_DIR" ]] || continue
    DAY_DIR="${LADDER_DIR}/${YESTERDAY}"
    ARCHIVE_7Z="${LADDER_DIR}/${YEAR_MONTH}/${YESTERDAY}.7z"
    if [[ -d "$DAY_DIR" ]]; then
      mkdir -p "${LADDER_DIR}/${YEAR_MONTH}"
      7z a -t7z -m0=lzma2 -mx=9 -mfb=64 -md=64m -ms=on "$ARCHIVE_7Z" "${DAY_DIR}"/*.log
      7z t "$ARCHIVE_7Z" >/dev/null
      rm -rf "$DAY_DIR"
    fi
  done
fi

# 3. On the 1st of each month, bundle the previous month's .7z files into a single .tar
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

# 4. Sync archives and database backups to Google Cloud Storage if gcloud is configured
if command -v gcloud >/dev/null 2>&1 && [[ -n "${ARENA_GCS_SYNC:-}" ]]; then
  gcloud storage rsync -r "$LOG_ROOT" "${GCS_BUCKET}/archives"
  gcloud storage rsync -r "$BACKUP_DIR" "${GCS_BUCKET}/db-backups"
fi
