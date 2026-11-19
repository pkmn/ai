#!/usr/bin/env bash
# arena/scripts/bake-image.sh
# Runs on a temporary GCP Staging VM (`n2-standard-8` with 300 GB SSD) to unpack all
# qualified tournament `linux/amd64` OCI images into `/opt/arena/agents/<id>` via `skopeo` + `umoci`,
# compile `tourney-relay`, install `tourney-agent`, and smoke-test every entrant inside `bwrap`.
#
# Usage:
#   bake-image.sh <entrants-manifest.tsv>
# where each line in <entrants-manifest.tsv> is:
#   <agent_id>\t<oci_image_url>\t<expected_sha256>[,<optional_auth_token>]
set -euo pipefail

MANIFEST="${1:?Usage: bake-image.sh <entrants-manifest.tsv>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARENA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

sudo apt-get update -y
sudo apt-get install -y bubblewrap skopeo umoci jq util-linux zstd gcc libc6-dev curl

echo "==> Blocking uncommon kernel socket modules (sctp, dccp, rds, tipc) in /etc/modprobe.d/arena-blacklist.conf"
# Prevent unprivileged `bwrap` entrants from auto-loading kernel socket modules via `request_module`
# (e.g. CVE-2026-64564 / CVE-2026-72447) during smoke tests and on snapshotted Spot Worker VMs.
sudo tee /etc/modprobe.d/arena-blacklist.conf >/dev/null <<'EOF'
install sctp /bin/false
blacklist sctp
install dccp /bin/false
blacklist dccp
install rds /bin/false
blacklist rds
install tipc /bin/false
blacklist tipc
EOF
sudo chmod 0644 /etc/modprobe.d/arena-blacklist.conf
sudo modprobe -r sctp dccp rds tipc 2>/dev/null || true
if lsmod | awk '{print $1}' | grep -qxE 'sctp|dccp|rds|tipc'; then
  echo "ERROR: Blocked kernel socket module remains loaded on staging VM" >&2
  exit 1
fi

echo "==> Compiling /usr/local/bin/tourney-relay and installing /usr/local/bin/tourney-agent"
RELAY_BUILD_DIR="$(mktemp -d /tmp/tourney-relay-build.XXXXXX)"
chmod 0700 "$RELAY_BUILD_DIR"
gcc -O2 -Wall -Wextra -o "${RELAY_BUILD_DIR}/tourney-relay" "${ARENA_DIR}/bin/tourney-relay.c"
sudo install -o root -g root -m 0755 "${RELAY_BUILD_DIR}/tourney-relay" /usr/local/bin/tourney-relay
rm -rf "$RELAY_BUILD_DIR"
sudo install -o root -g root -m 0755 "${ARENA_DIR}/bin/tourney-agent" /usr/local/bin/tourney-agent

sudo mkdir -p /opt/arena/agents /opt/arena/stats
sudo chown -R "$(id -u):$(id -g)" /opt/arena/agents
sudo chmod 0755 /opt/arena/stats

write_skopeo_authfile() {
  local image_ref="$1"
  local raw_token="$2"
  local auth_file="$3"
  local clean="${raw_token#Authorization: }"
  clean="${clean#authorization: }"
  clean="${clean#Bearer }"
  clean="${clean#bearer }"
  clean="${clean#Basic }"
  clean="${clean#basic }"
  local creds="$clean"
  if [[ "$creds" != *:* ]]; then
    creds="oauth2:${creds}"
  fi
  local first_seg="${image_ref%%/*}"
  local host="$first_seg"
  if [[ "$first_seg" == "$image_ref" || ( "$first_seg" != *.* && "$first_seg" != *:* && "$first_seg" != "localhost" ) || "$first_seg" == "docker.io" || "$first_seg" == "index.docker.io" || "$first_seg" == "registry-1.docker.io" ]]; then
    host="https://index.docker.io/v1/"
  fi
  local b64
  b64="$(printf '%s' "$creds" | base64 | tr -d '\r\n')"
  umask 077
  if [[ "$host" == "https://index.docker.io/v1/" ]]; then
    jq -n --arg auth "$b64" '{auths: {"https://index.docker.io/v1/": {auth: $auth}, "docker.io": {auth: $auth}, "registry-1.docker.io": {auth: $auth}}}' > "$auth_file"
  else
    jq -n --arg host "$host" --arg auth "$b64" '{auths: {($host): {auth: $auth}}}' > "$auth_file"
  fi
  chmod 0600 "$auth_file"
}

strip_tag_or_digest() {
  local ref="$1"
  ref="${ref%@*}"
  local last_slash="${ref##*/}"
  if [[ "$last_slash" == *:* ]]; then
    local prefix="${ref%/*}"
    local repo="${last_slash%%:*}"
    if [[ "$prefix" == "$ref" ]]; then
      printf '%s' "$repo"
    else
      printf '%s/%s' "$prefix" "$repo"
    fi
  else
    printf '%s' "$ref"
  fi
}

ensure_safe_rootfs_dir() {
  local rootfs="$1"
  local rel="$2"
  local cur="$rootfs"
  local IFS='/'
  local part
  for part in $rel; do
    [[ -z "$part" ]] && continue
    cur="${cur}/${part}"
    if [[ -L "$cur" ]]; then
      echo "ERROR: Unsafe symlink at OCI mount target ${rel}" >&2
      return 1
    fi
    if [[ -e "$cur" && ! -d "$cur" ]]; then
      echo "ERROR: Non-directory at OCI mount target ${rel}" >&2
      return 1
    fi
    if [[ ! -d "$cur" ]]; then
      mkdir "$cur"
    fi
  done
}

smoke_test_agent() {
  local agent_id="$1"
  local smoke_req="$2"
  local fifo_dir in_fifo out_fifo agent_pid
  fifo_dir="$(mktemp -d /tmp/tourney-smoke.XXXXXX)"
  chmod 0700 "$fifo_dir"
  in_fifo="${fifo_dir}/in"
  out_fifo="${fifo_dir}/out"
  mkfifo "$in_fifo" "$out_fifo"

  # Keep stdin open via FIFO FD 3 so `tourney-relay` does not trigger its 100 ms stdin-EOF
  # SIGKILL while the agent is still booting (up to 60s `/ready` or `/utm` grace + 60s Turn 1).
  timeout 120s /usr/local/bin/tourney-agent "$agent_id" <"$in_fifo" >"$out_fifo" 2>/dev/null &
  agent_pid=$!

  exec 3>"$in_fifo"
  exec 4<"$out_fifo"

  local first_line="" reply_line="" line="" trimmed="" lines=0 rem=0 deadline=0
  deadline=$(( SECONDS + 60 ))
  while (( lines < 64 )); do
    rem=$(( deadline - SECONDS ))
    (( rem > 0 )) || break
    IFS= read -r -t "$rem" line <&4 || break
    line="${line%$'\r'}"
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    lines=$(( lines + 1 ))
    if [[ "$trimmed" == "/ready" || "$trimmed" == "/utm "* ]]; then
      first_line="$trimmed"
      break
    fi
  done

  if [[ -n "$first_line" ]]; then
    printf '%s\n' "$smoke_req" >&3 || true
    lines=0
    deadline=$(( SECONDS + 60 ))
    while (( lines < 64 )); do
      rem=$(( deadline - SECONDS ))
      (( rem > 0 )) || break
      IFS= read -r -t "$rem" line <&4 || break
      line="${line%$'\r'}"
      trimmed="${line#"${line%%[![:space:]]*}"}"
      trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
      lines=$(( lines + 1 ))
      if [[ -n "$trimmed" && "$trimmed" != "/ready" && "$trimmed" != "|c|"* && "$trimmed" != "/c "* ]]; then
        reply_line="$trimmed"
        break
      fi
    done
  fi

  exec 3>&- || true
  exec 4<&- || true
  kill "$agent_pid" 2>/dev/null || true
  wait "$agent_pid" 2>/dev/null || true
  rm -rf "$fifo_dir"

  if [[ -n "$reply_line" ]]; then
    SMOKE_OUT="${first_line} -> ${reply_line}"
    return 0
  fi
  return 1
}

while IFS=$'\t' read -r AGENT_ID IMAGE_URL SHA_AND_CREDS; do
  [[ -z "$AGENT_ID" || "$AGENT_ID" =~ ^# ]] && continue
  if [[ ! "$AGENT_ID" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ || "$AGENT_ID" == *..* ]]; then
    echo "ERROR: Invalid agent_id '${AGENT_ID}'" >&2
    exit 1
  fi
  EXPECTED_SHA="${SHA_AND_CREDS%%,*}"
  CREDS=""
  if [[ "$SHA_AND_CREDS" == *,* ]]; then
    CREDS="${SHA_AND_CREDS#*,}"
  fi

  CLEAN_IMAGE="${IMAGE_URL#docker://}"
  REPO_REF="$(strip_tag_or_digest "$CLEAN_IMAGE")"

  echo "==> Baking entrant ${AGENT_ID} from ${CLEAN_IMAGE}"
  WORK_DIR="$(mktemp -d "/tmp/oci-${AGENT_ID}-XXXXXX")"
  chmod 0700 "$WORK_DIR"
  SKOPEO_ARGS=()
  if [[ -n "$CREDS" ]]; then
    AUTH_FILE="${WORK_DIR}/auth.json"
    write_skopeo_authfile "$CLEAN_IMAGE" "$CREDS" "$AUTH_FILE"
    SKOPEO_ARGS+=(--authfile "$AUTH_FILE")
  fi

  # 1. Inspect remote manifest/index directly to disk so trailing newlines are preserved when hashing
  MANIFEST_FILE="${WORK_DIR}/manifest.json"
  skopeo inspect --raw "${SKOPEO_ARGS[@]}" "docker://${CLEAN_IMAGE}" > "$MANIFEST_FILE"
  OUTER_SHA="$(sha256sum "$MANIFEST_FILE" | awk '{print $1}')"
  if [[ -n "$EXPECTED_SHA" ]]; then
    CLEAN_EXPECTED="$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f' | sed 's/^sha256://')"
    if [[ "$CLEAN_EXPECTED" != "$OUTER_SHA" ]]; then
      echo "ERROR: ${AGENT_ID} OCI manifest digest mismatch (expected ${CLEAN_EXPECTED}, got ${OUTER_SHA})" >&2
      rm -rf "$WORK_DIR"
      exit 1
    fi
  fi

  TARGET_SHA="$OUTER_SHA"
  if jq -e '.manifests != null' "$MANIFEST_FILE" >/dev/null 2>&1; then
    AMD64_DIGEST="$(jq -r '
      [.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // ""
    ' "$MANIFEST_FILE")"
    if [[ -z "$AMD64_DIGEST" ]]; then
      echo "ERROR: ${AGENT_ID} multi-arch index has no linux/amd64 manifest" >&2
      rm -rf "$WORK_DIR"
      exit 1
    fi
    TARGET_SHA="${AMD64_DIGEST#sha256:}"
    skopeo inspect --raw "${SKOPEO_ARGS[@]}" "docker://${REPO_REF}@sha256:${TARGET_SHA}" > "$MANIFEST_FILE"
  fi

  LAYER_COUNT="$(jq -r '.layers | length' "$MANIFEST_FILE")"
  COMPRESSED_BYTES="$(jq -r '[.layers[].size] | add // 0' "$MANIFEST_FILE")"
  if (( LAYER_COUNT == 0 || LAYER_COUNT > 32 )); then
    echo "ERROR: ${AGENT_ID} has invalid layer count (${LAYER_COUNT})" >&2
    rm -rf "$WORK_DIR"
    exit 1
  fi
  if (( COMPRESSED_BYTES > 524288000 )); then
    echo "ERROR: ${AGENT_ID} compressed layers exceed 500 MB (${COMPRESSED_BYTES} bytes)" >&2
    rm -rf "$WORK_DIR"
    exit 1
  fi

  # 2. Pull digest-pinned linux/amd64 OCI layout and unpack rootfs via umoci
  PINNED_REF="${REPO_REF}@sha256:${TARGET_SHA}"
  skopeo copy --override-os linux --override-arch amd64 "${SKOPEO_ARGS[@]}" \
    "docker://${PINNED_REF}" "oci:${WORK_DIR}/layout:latest"
  rm -f "${WORK_DIR}/auth.json"
  umoci unpack --rootless --image "${WORK_DIR}/layout:latest" "${WORK_DIR}/bundle"

  ROOTFS_STAGE="${WORK_DIR}/bundle/rootfs"
  if [[ -L "$ROOTFS_STAGE" || ! -d "$ROOTFS_STAGE" ]]; then
    echo "ERROR: ${AGENT_ID} unpacked rootfs is not a directory" >&2
    rm -rf "$WORK_DIR"
    exit 1
  fi

  # Synthesize /.arena-run from OCI config.json Entrypoint/Cmd when /run is absent or an FHS directory
  if [[ ! -f "${ROOTFS_STAGE}/run" || -L "${ROOTFS_STAGE}/run" || ! -x "${ROOTFS_STAGE}/run" ]]; then
    if [[ -e "${ROOTFS_STAGE}/.arena-run" || -L "${ROOTFS_STAGE}/.arena-run" ]]; then
      echo "ERROR: ${AGENT_ID} contains colliding /.arena-run path" >&2
      rm -rf "$WORK_DIR"
      exit 1
    fi
    PROC_ARGS="$(jq -r '(.process.args // []) | map(@sh) | join(" ")' "${WORK_DIR}/bundle/config.json")"
    if [[ -n "$PROC_ARGS" ]]; then
      PROC_CWD="$(jq -r '.process.cwd // "/"' "${WORK_DIR}/bundle/config.json")"
      {
        echo "#!/bin/sh"
        jq -r '(.process.env // [])[]
          | select((startswith("HOME=") or startswith("TMPDIR=") or startswith("XDG_CACHE_HOME=") or startswith("PKMN_STATS_DIR=") or startswith("ARENA_PONDER=")) | not)
          | "export " + (@sh)' "${WORK_DIR}/bundle/config.json"
        printf 'cd %s\n' "$(printf '%s' "$PROC_CWD" | jq -r '@sh' -R)"
        printf 'exec %s "$@"\n' "$PROC_ARGS"
      } > "${ROOTFS_STAGE}/.arena-run"
      chmod 0755 "${ROOTFS_STAGE}/.arena-run"
    fi
  fi

  if [[ ( ! -f "${ROOTFS_STAGE}/run" || -L "${ROOTFS_STAGE}/run" || ! -x "${ROOTFS_STAGE}/run" ) && ( ! -f "${ROOTFS_STAGE}/.arena-run" || ! -x "${ROOTFS_STAGE}/.arena-run" ) ]]; then
    echo "ERROR: ${AGENT_ID} is missing executable /run (and has no OCI Entrypoint/Cmd)" >&2
    rm -rf "$WORK_DIR"
    exit 1
  fi

  # Verify bwrap mountpoint directories and NVIDIA driver bind targets without following symlinks
  for mnt_dir in tmp scratch proc dev usr/lib/x86_64-linux-gnu; do
    if ! ensure_safe_rootfs_dir "$ROOTFS_STAGE" "$mnt_dir"; then
      rm -rf "$WORK_DIR"
      exit 1
    fi
  done
  for nvlib in libcuda.so.1 libnvidia-ml.so.1 libnvidia-ptxjitcompiler.so.1; do
    nv_target="${ROOTFS_STAGE}/usr/lib/x86_64-linux-gnu/${nvlib}"
    if [[ -L "$nv_target" ]]; then
      echo "ERROR: ${AGENT_ID} has symlink at NVIDIA bind target ${nvlib}" >&2
      rm -rf "$WORK_DIR"
      exit 1
    fi
    if [[ ! -e "$nv_target" ]]; then
      touch "$nv_target"
    fi
  done

  DEST_DIR="/opt/arena/agents/${AGENT_ID}"
  sudo rm -rf "$DEST_DIR"
  sudo mv "$ROOTFS_STAGE" "$DEST_DIR"
  rm -rf "$WORK_DIR"

  # 3. Verify unpacked size <= 500 MB and lock down read-only permissions
  UNPACKED_KB="$(sudo du -sk "$DEST_DIR" | awk '{print $1}')"
  if (( UNPACKED_KB > 512000 )); then
    echo "ERROR: ${AGENT_ID} unpacked rootfs exceeds 500 MB (${UNPACKED_KB} KiB)" >&2
    sudo rm -rf "$DEST_DIR"
    exit 1
  fi
  sudo chown -R root:root "$DEST_DIR"
  sudo chmod -R a+rX,u+w,go-w "$DEST_DIR"

  # 4. Smoke test inside rootless bubblewrap (`/ready` or `/utm` -> dummy Turn-1 Showdown request)
  SMOKE_REQ='|request|{"active":[{"moves":[{"move":"Tackle","id":"tackle","pp":35,"maxpp":35,"target":"normal","disabled":false}]}],"side":{"name":"Agent A","id":"p1","pokemon":[{"ident":"p1: Pikachu","details":"Pikachu, L50","condition":"100/100","active":true,"stats":{"atk":55,"def":40,"spa":50,"spd":50,"spe":90},"moves":["tackle"],"baseAbility":"static","item":"","pokeball":"pokeball"}]},"rqid":1}'
  SMOKE_OUT=""
  if ! smoke_test_agent "$AGENT_ID" "$SMOKE_REQ"; then
    echo "ERROR: ${AGENT_ID} failed bwrap smoke test (missing /ready or /utm -> Turn-1 choice)" >&2
    sudo rm -rf "$DEST_DIR"
    exit 1
  fi
  echo "    OK (${AGENT_ID} responded: ${SMOKE_OUT}, verified digest: ${TARGET_SHA})"
done < "$MANIFEST"

sudo sync
echo "==> All tournament agents unpacked and verified in /opt/arena/agents/."
