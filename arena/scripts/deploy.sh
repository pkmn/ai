#!/usr/bin/env bash
# arena/scripts/deploy.sh
# Pulls origin/main on the Mac mini Arena runner, pauses new matches via deploy.lock while waiting
# for any in-flight match to finish before mutating the checkout/build, compiles TypeScript, verifies
# the build, and signals `ai.pkmn.arena` with SIGUSR1 before `launchd` respawns it.
set -euxo pipefail

export PATH="/opt/arena/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

command=${1:-reload}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

STATE_DIR="/opt/arena/state"
DEPLOY_LOCK="${STATE_DIR}/deploy.lock"
MATCH_LOCK="${STATE_DIR}/match.lock"
MAINT_LOCK="${STATE_DIR}/maintenance.lock"

pid_alive() {
    local pid="$1"
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

cleanup() {
    rm -f "${DEPLOY_LOCK}.tmp.$$"
    if [[ -f "$DEPLOY_LOCK" ]]; then
        local owner=""
        owner="$(cat "$DEPLOY_LOCK" 2>/dev/null || true)"
        if [[ "$owner" == "$$" ]]; then
            rm -f "$DEPLOY_LOCK"
        fi
    fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

# Save our current commit to use for comparison and rollback
HEAD=$(git rev-parse HEAD)

# Fetch and verify fast-forward ancestor before modifying checkout
git fetch origin main
git merge-base --is-ancestor "$HEAD" origin/main

NEEDS_RESTART=0
if [ "${command}" = "restart" ] || ! git diff --quiet "$HEAD" origin/main -- \
    arena/ server/ db/ teams/ static/util.tsx static/dom.ts static/build.tsx \
    package.json teams/package.json tsconfig.json; then
    NEEDS_RESTART=1
fi

NEEDS_COMPILE=0
if [ "$NEEDS_RESTART" -ne 0 ] || [ ! -s build/arena/index.js ]; then
    NEEDS_COMPILE=1
fi

# Pause scheduling and wait for any in-flight match or nightly maintenance to finish before
# mutating repo/node_modules/build.
if [ "$NEEDS_COMPILE" -ne 0 ]; then
    mkdir -p "$STATE_DIR"
    if [[ -f "$DEPLOY_LOCK" ]]; then
        EXISTING_PID="$(cat "$DEPLOY_LOCK" 2>/dev/null || true)"
        if pid_alive "$EXISTING_PID"; then
            echo "ERROR: Another deploy (PID ${EXISTING_PID}) is already in progress." >&2
            exit 1
        fi
    fi
    (umask 077 && printf '%s\n' "$$" > "${DEPLOY_LOCK}.tmp.$$")
    mv -f "${DEPLOY_LOCK}.tmp.$$" "$DEPLOY_LOCK"

    set +x
    WAITED=0
    while true; do
        BLOCKER=""
        BLOCKER_PID=""
        if [[ -f "$MATCH_LOCK" ]]; then
            MATCH_PID="$(cat "$MATCH_LOCK" 2>/dev/null || true)"
            if pid_alive "$MATCH_PID"; then
                BLOCKER="in-flight match"
                BLOCKER_PID="$MATCH_PID"
            else
                rm -f "$MATCH_LOCK"
            fi
        fi
        if [[ -z "$BLOCKER" && -f "$MAINT_LOCK" ]]; then
            MAINT_PID="$(cat "$MAINT_LOCK" 2>/dev/null || true)"
            if pid_alive "$MAINT_PID"; then
                BLOCKER="nightly maintenance"
                BLOCKER_PID="$MAINT_PID"
            else
                rm -f "$MAINT_LOCK"
            fi
        fi
        [[ -z "$BLOCKER" ]] && break
        if (( WAITED == 0 || WAITED % 60 == 0 )); then
            echo "Waiting for ${BLOCKER} (PID ${BLOCKER_PID}) to finish before deploying..." >&2
        fi
        sleep 2
        WAITED=$((WAITED + 2))
    done
    set -x
fi

git merge --ff-only origin/main

if [ "$NEEDS_COMPILE" -ne 0 ]; then
    # Update dependencies if package.json has changed (`npm_config_allow_git=all` for npm 12+)
    git diff --quiet "$HEAD" package.json teams/package.json >/dev/null ||
        npm_config_allow_git=all npm install --silent

    # Compile TypeScript
    npm run compile

    # Post-compile smoke verification with automatic rollback on failure
    verify_arena() {
        test -s build/arena/index.js || return 1
        node -e "const a = require('./build/arena'); if (typeof a.runDaemon !== 'function') process.exit(1);"
    }

    if ! verify_arena; then
        echo "Post-deploy Arena build check failed; rolling back to $HEAD" >&2
        if [ "$(git rev-parse HEAD)" != "$HEAD" ]; then
            git reset --hard "$HEAD"
            npm run compile
        fi
        exit 1
    fi
fi

# Ensure default pinned @pkmn/sim 0.11.0 worker directory is installed
if [ ! -f sim/0.11.0/node_modules/@pkmn/sim/package.json ]; then
    node build/tools/pkmn install-sim 0.11.0 \
        --dex @pkmn/dex@0.11.0 \
        --mods @pkmn/mods@0.11.0 \
        --randoms @pkmn/randoms@0.11.0
fi

# Refuse to restart the daemon if Mac mini privileged helpers or system configs changed or
# drifted from their installed copies (`setup-arena.sh` requires interactive `sudo`).
NEEDS_SETUP=0
if ! git diff --quiet "$HEAD" -- \
    arena/bin/limit.c arena/bin/arena arena/bin/baseline \
    arena/config/ arena/scripts/setup-arena.sh; then
    NEEDS_SETUP=1
fi
for pair in \
    "arena/bin/arena:/opt/arena/bin/arena" \
    "arena/bin/baseline:/opt/arena/agents/_baseline/run" \
    "arena/config/sandbox.sb:/opt/arena/etc/sandbox.sb" \
    "arena/config/ai.pkmn.pf.plist:/Library/LaunchDaemons/ai.pkmn.pf.plist" \
    "arena/config/ai.pkmn.podman.plist:/Library/LaunchDaemons/ai.pkmn.podman.plist" \
    "arena/config/ai.pkmn.arena.plist:/Library/LaunchDaemons/ai.pkmn.arena.plist" \
    "arena/config/ai.pkmn.maintenance.plist:/Library/LaunchDaemons/ai.pkmn.maintenance.plist"; do
    src="${pair%%:*}"
    dst="${pair#*:}"
    if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
        NEEDS_SETUP=1
    fi
done
if [ -f /Library/LaunchDaemons/ai.pkmn.archive.plist ]; then
    NEEDS_SETUP=1
fi
if [ -x /opt/arena/bin/limit ] && [ arena/bin/limit.c -nt /opt/arena/bin/limit ]; then
    NEEDS_SETUP=1
fi
if [ "$NEEDS_SETUP" -ne 0 ]; then
    echo "ERROR: Privileged Arena helpers/configs changed or differ from installed copies." >&2
    echo "Refusing to restart ai.pkmn.arena against stale host binaries." >&2
    echo "Re-run ./arena/scripts/setup-arena.sh, then restart ai.pkmn.arena:" >&2
    echo "  ./arena/scripts/setup-arena.sh && sudo launchctl kill SIGUSR1 system/ai.pkmn.arena" >&2
    exit 1
fi

# Signal the paused coordinator to exit and respawn via launchd (if Arena files changed)
if [ "$NEEDS_RESTART" -ne 0 ]; then
    sudo -n /bin/launchctl kill SIGUSR1 system/ai.pkmn.arena 2>/dev/null ||
        pkill -USR1 -u "$(id -un)" -f '/build/arena' || true
fi
