#!/usr/bin/env bash
# arena/scripts/archive.sh
# Nightly battle log compression (.7z solid LZMA2), monthly .tar GCS rollup,
# and daily SQLite WAL-safe .backup + zstd compression on the Mac mini.
set -euo pipefail
shopt -s nullglob

if [[ -f /opt/arena/repo/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /opt/arena/repo/.env
  set +a
fi

ARCHIVE_ROOT="${ARENA_ARCHIVE_DIR:-/Volumes/Archive}"
LOG_ROOT="${ARCHIVE_ROOT}/logs"
COLD_DIR="${ARCHIVE_ROOT}/cold-agents"
BACKUP_DIR="${ARCHIVE_ROOT}/db-backups"
STATE_DB="${ARENA_STATE_DB:-/opt/arena/state/arena.sqlite}"
GCS_BUCKET="${ARENA_GCS_BUCKET:-gs://pkmn-arena}"

# Guard against silently writing into the internal rootfs if the external APFS drive is unmounted
if [[ "$ARCHIVE_ROOT" == "/Volumes/Archive" && "$(uname -s)" == "Darwin" ]]; then
  if ! mount | grep -q " on /Volumes/Archive "; then
    echo "ERROR: /Volumes/Archive is not mounted; aborting archive.sh" >&2
    exit 1
  fi
fi

mkdir -p "$LOG_ROOT" "$COLD_DIR" "$BACKUP_DIR"

# 1. Daily SQLite backup of local Mac mini state DB (/opt/arena/state/arena.sqlite)
if [[ -f "$STATE_DB" ]]; then
  TODAY="$(date -u +%Y-%m-%d)"
  OUT_DB="${BACKUP_DIR}/arena-state-${TODAY}.sqlite"
  sqlite3 -cmd ".timeout 10000" "$STATE_DB" ".backup '${OUT_DB}'"
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
      LOG_FILES=("${DAY_DIR}"/*.log)
      if (( ${#LOG_FILES[@]} > 0 )); then
        mkdir -p "${LADDER_DIR}/${YEAR_MONTH}"
        TMP_7Z="${ARCHIVE_7Z}.tmp"
        rm -f "$TMP_7Z"
        7z a -t7z -m0=lzma2 -mx=9 -mfb=64 -md=64m -ms=on "$TMP_7Z" "${LOG_FILES[@]}"
        7z t "$TMP_7Z" >/dev/null
        mv -f "$TMP_7Z" "$ARCHIVE_7Z"

        # For random-battle ladders, append the daily .7z archive to the cumulative
        # <ladderId>-logs.tar archive and publish it to the web server so spectators
        # can download the full history (excluding the current day's in-progress battles).
        LADDER_ID="$(basename "$LADDER_DIR")"
        if [[ "$LADDER_ID" == *random* ]]; then
          FULL_TAR="${LADDER_DIR}/${LADDER_ID}-logs.tar"
          if [[ -f "$FULL_TAR" ]]; then
            tar -rf "$FULL_TAR" -C "$LADDER_DIR" "${YEAR_MONTH}/${YESTERDAY}.7z"
          else
            tar -cf "$FULL_TAR" -C "$LADDER_DIR" "${YEAR_MONTH}/${YESTERDAY}.7z"
          fi
          if [[ -n "${ARENA_SERVER_URL:-}" && -n "${ARENA_SECRET:-}" ]]; then
            SHA256="$(shasum -a 256 "$FULL_TAR" | awk '{print $1}')"
            curl -fsS -X PUT \
              -H "Authorization: Bearer ${ARENA_SECRET}" \
              -H "Content-Type: application/x-tar" \
              -H "X-Content-SHA256: ${SHA256}" \
              --data-binary @"${FULL_TAR}" \
              "${ARENA_SERVER_URL%/}/api/arena/ladders/${LADDER_ID}/archive" >/dev/null || true
          fi
        fi
      fi
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

# 4. Sync archives, cold agent bundles, and database backups to Google Cloud Storage
if command -v gcloud >/dev/null 2>&1 && [[ -n "${ARENA_GCS_SYNC:-}" ]]; then
  gcloud storage rsync -r "$LOG_ROOT" "${GCS_BUCKET}/archives"
  gcloud storage rsync -r "$COLD_DIR" "${GCS_BUCKET}/agents"
  gcloud storage rsync -r "$BACKUP_DIR" "${GCS_BUCKET}/db-backups"
fi
