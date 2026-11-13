#!/usr/bin/env bash
# arena/scripts/bake-image.sh
# Runs on a temporary GCP Staging VM (`n2-standard-8` with 300 GB SSD) to unpack all
# qualified tournament OCI images into `/opt/arena/agents/<id>` via `skopeo` + `umoci`,
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

while IFS=$'\t' read -r AGENT_ID IMAGE_URL SHA_AND_CREDS; do
  [[ -z "$AGENT_ID" || "$AGENT_ID" =~ ^# ]] && continue
  EXPECTED_SHA="${SHA_AND_CREDS%%,*}"
  CREDS=""
  if [[ "$SHA_AND_CREDS" == *,* ]]; then
    CREDS="${SHA_AND_CREDS#*,}"
  fi

  echo "==> Baking entrant ${AGENT_ID} from ${IMAGE_URL}"
  WORK_DIR="$(mktemp -d "/tmp/oci-${AGENT_ID}-XXXXXX")"
  SKOPEO_ARGS=()
  if [[ -n "$CREDS" ]]; then
    SKOPEO_ARGS+=(--src-creds "$CREDS")
  fi

  # 1. Inspect remote manifest before pulling layers (<= 32 layers, <= 500 MB compressed)
  RAW_MANIFEST="$(skopeo inspect --raw "${SKOPEO_ARGS[@]}" "docker://${IMAGE_URL}")"
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

  # 2. Pull OCI layout and unpack rootfs via umoci
  skopeo copy "${SKOPEO_ARGS[@]}" "docker://${IMAGE_URL}" "oci:${WORK_DIR}/layout:latest"
  umoci unpack --rootless --image "${WORK_DIR}/layout:latest" "${WORK_DIR}/bundle"

  DEST_DIR="/opt/arena/agents/${AGENT_ID}"
  sudo rm -rf "$DEST_DIR"
  sudo mv "${WORK_DIR}/bundle/rootfs" "$DEST_DIR"
  rm -rf "$WORK_DIR"

  # 3. Verify unpacked size <= 500 MB and executable /run entrypoint exists
  UNPACKED_KB="$(sudo du -sk "$DEST_DIR" | awk '{print $1}')"
  if (( UNPACKED_KB > 512000 )); then
    echo "ERROR: ${AGENT_ID} unpacked rootfs exceeds 500 MB (${UNPACKED_KB} KiB)" >&2
    exit 1
  fi
  if [[ ! -x "${DEST_DIR}/run" ]]; then
    echo "ERROR: ${AGENT_ID} is missing executable /run at rootfs root" >&2
    exit 1
  fi

  sudo chown -R root:root "$DEST_DIR"
  sudo chmod -R a+rX,u+w,go-w "$DEST_DIR"

  # 4. Smoke test inside rootless bubblewrap with a dummy Turn-1 Showdown request
  SMOKE_REQ='|request|{"active":[{"moves":[{"move":"Tackle","id":"tackle","pp":35,"maxpp":35,"target":"normal","disabled":false}]}],"side":{"name":"Agent A","id":"p1","pokemon":[{"ident":"p1: Pikachu","details":"Pikachu, L50","condition":"100/100","active":true,"stats":{"atk":55,"def":40,"spa":50,"spd":50,"spe":90},"moves":["tackle"],"baseAbility":"static","item":"","pokeball":"pokeball"}]},"rqid":1}'
  SMOKE_OUT="$(printf '%s\n' "$SMOKE_REQ" | timeout 30s /usr/local/bin/tourney-agent "$AGENT_ID" | head -n 1 || true)"
  if [[ -z "$SMOKE_OUT" ]]; then
    echo "ERROR: ${AGENT_ID} failed bwrap smoke test (empty stdout)" >&2
    exit 1
  fi
  echo "    OK (${AGENT_ID} responded: ${SMOKE_OUT}, expected digest: ${EXPECTED_SHA})"
done < "$MANIFEST"

sudo sync
echo "==> All tournament agents unpacked and verified in /opt/arena/agents/."
