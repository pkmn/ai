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

echo "==> Compiling /usr/local/bin/tourney-relay and installing /usr/local/bin/tourney-agent"
gcc -O2 -Wall -Wextra -o /tmp/tourney-relay "${ARENA_DIR}/bin/tourney-relay.c"
sudo mv /tmp/tourney-relay /usr/local/bin/tourney-relay
sudo cp "${ARENA_DIR}/bin/tourney-agent" /usr/local/bin/tourney-agent
sudo chown root:root /usr/local/bin/tourney-relay /usr/local/bin/tourney-agent
sudo chmod 0755 /usr/local/bin/tourney-relay /usr/local/bin/tourney-agent

sudo mkdir -p /opt/arena/agents
sudo chown -R "$(id -u):$(id -g)" /opt/arena/agents

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
  local host="${image_ref%%/*}"
  local b64
  b64="$(printf '%s' "$creds" | base64 | tr -d '\r\n')"
  umask 077
  jq -n --arg host "$host" --arg auth "$b64" '{auths: {($host): {auth: $auth}}}' > "$auth_file"
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

while IFS=$'\t' read -r AGENT_ID IMAGE_URL SHA_AND_CREDS; do
  [[ -z "$AGENT_ID" || "$AGENT_ID" =~ ^# ]] && continue
  if [[ ! "$AGENT_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
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

  # 1. Inspect remote manifest/index, enforce exact manifest digest match, and resolve linux/amd64
  RAW_MANIFEST="$(skopeo inspect --raw "${SKOPEO_ARGS[@]}" "docker://${CLEAN_IMAGE}")"
  OUTER_SHA="$(printf '%s' "$RAW_MANIFEST" | sha256sum | awk '{print $1}')"
  if [[ -n "$EXPECTED_SHA" ]]; then
    CLEAN_EXPECTED="$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f' | sed 's/^sha256://')"
    if [[ "$CLEAN_EXPECTED" != "$OUTER_SHA" ]]; then
      echo "ERROR: ${AGENT_ID} OCI manifest digest mismatch (expected ${CLEAN_EXPECTED}, got ${OUTER_SHA})" >&2
      rm -rf "$WORK_DIR"
      exit 1
    fi
  fi

  TARGET_SHA="$OUTER_SHA"
  if printf '%s' "$RAW_MANIFEST" | jq -e '.manifests != null' >/dev/null 2>&1; then
    AMD64_DIGEST="$(printf '%s' "$RAW_MANIFEST" | jq -r '
      [.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // ""
    ')"
    if [[ -z "$AMD64_DIGEST" ]]; then
      echo "ERROR: ${AGENT_ID} multi-arch index has no linux/amd64 manifest" >&2
      rm -rf "$WORK_DIR"
      exit 1
    fi
    TARGET_SHA="${AMD64_DIGEST#sha256:}"
    RAW_MANIFEST="$(skopeo inspect --raw "${SKOPEO_ARGS[@]}" "docker://${REPO_REF}@sha256:${TARGET_SHA}")"
  fi

  LAYER_COUNT="$(printf '%s' "$RAW_MANIFEST" | jq '.layers | length')"
  COMPRESSED_BYTES="$(printf '%s' "$RAW_MANIFEST" | jq '[.layers[].size] | add // 0')"
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

  # Synthesize /run from OCI config.json Entrypoint/Cmd/Env/WorkingDir when /run is not provided
  if [[ ! -e "${WORK_DIR}/bundle/rootfs/run" ]]; then
    PROC_ARGS="$(jq -r '(.process.args // []) | map(@sh) | join(" ")' "${WORK_DIR}/bundle/config.json")"
    if [[ -n "$PROC_ARGS" ]]; then
      PROC_CWD="$(jq -r '.process.cwd // "/"' "${WORK_DIR}/bundle/config.json")"
      {
        echo "#!/bin/sh"
        jq -r '(.process.env // [])[] | "export " + (@sh)' "${WORK_DIR}/bundle/config.json"
        printf 'cd %s\n' "$(printf '%s' "$PROC_CWD" | jq -R '@sh')"
        printf 'exec %s "$@"\n' "$PROC_ARGS"
      } > "${WORK_DIR}/bundle/rootfs/run"
      chmod 0755 "${WORK_DIR}/bundle/rootfs/run"
    fi
  fi

  DEST_DIR="/opt/arena/agents/${AGENT_ID}"
  sudo rm -rf "$DEST_DIR"
  sudo mv "${WORK_DIR}/bundle/rootfs" "$DEST_DIR"
  rm -rf "$WORK_DIR"

  # 3. Verify unpacked size <= 500 MB and executable /run entrypoint exists
  UNPACKED_KB="$(sudo du -sk "$DEST_DIR" | awk '{print $1}')"
  if (( UNPACKED_KB > 512000 )); then
    echo "ERROR: ${AGENT_ID} unpacked rootfs exceeds 500 MB (${UNPACKED_KB} KiB)" >&2
    sudo rm -rf "$DEST_DIR"
    exit 1
  fi
  if [[ ! -x "${DEST_DIR}/run" ]]; then
    echo "ERROR: ${AGENT_ID} is missing executable /run (and has no OCI Entrypoint/Cmd)" >&2
    sudo rm -rf "$DEST_DIR"
    exit 1
  fi

  # Ensure bwrap mountpoint directories and NVIDIA driver bind targets exist before read-only chmod
  sudo mkdir -p "${DEST_DIR}"/{tmp,scratch,proc,dev} "${DEST_DIR}/usr/lib/x86_64-linux-gnu"
  for nvlib in libcuda.so.1 libnvidia-ml.so.1 libnvidia-ptxjitcompiler.so.1; do
    if [[ ! -e "${DEST_DIR}/usr/lib/x86_64-linux-gnu/${nvlib}" ]]; then
      sudo touch "${DEST_DIR}/usr/lib/x86_64-linux-gnu/${nvlib}"
    fi
  done
  sudo chown -R root:root "$DEST_DIR"
  sudo chmod -R a+rX,u+w,go-w "$DEST_DIR"

  # 4. Smoke test inside rootless bubblewrap with a dummy Turn-1 Showdown request
  SMOKE_REQ='|request|{"active":[{"moves":[{"move":"Tackle","id":"tackle","pp":35,"maxpp":35,"target":"normal","disabled":false}]}],"side":{"name":"Agent A","id":"p1","pokemon":[{"ident":"p1: Pikachu","details":"Pikachu, L50","condition":"100/100","active":true,"stats":{"atk":55,"def":40,"spa":50,"spd":50,"spe":90},"moves":["tackle"],"baseAbility":"static","item":"","pokeball":"pokeball"}]},"rqid":1}'
  SMOKE_OUT="$(printf '%s\n' "$SMOKE_REQ" | timeout 30s /usr/local/bin/tourney-agent "$AGENT_ID" | head -n 1 || true)"
  if [[ -z "$SMOKE_OUT" ]]; then
    echo "ERROR: ${AGENT_ID} failed bwrap smoke test (empty stdout)" >&2
    sudo rm -rf "$DEST_DIR"
    exit 1
  fi
  echo "    OK (${AGENT_ID} responded: ${SMOKE_OUT}, verified digest: ${TARGET_SHA})"
done < "$MANIFEST"

sudo sync
echo "==> All tournament agents unpacked and verified in /opt/arena/agents/."
