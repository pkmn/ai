#!/usr/bin/env bash
# arena/scripts/deploy.sh
# Pulls origin/main on the Mac mini Arena runner, compiles TypeScript, verifies the build, and
# signals `ai.pkmn.arena` with SIGUSR1 so it drains any in-flight match before `launchd` respawns it.
set -euxo pipefail

export PATH="/opt/arena/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

command=${1:-reload}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

# Save our current commit to use for comparison and rollback
HEAD=$(git rev-parse HEAD)

# Fetch and verify fast-forward ancestor before modifying checkout
git fetch origin main
git merge-base --is-ancestor "$HEAD" origin/main
git merge --ff-only origin/main

# Update dependencies if package.json has changed (`npm_config_allow_git=all` for npm 12+)
git diff --quiet "$HEAD" package.json teams/package.json >/dev/null ||
    npm_config_allow_git=all npm install --silent

# Compile TypeScript
npm run compile

# Ensure default pinned @pkmn/sim 0.11.0 worker directory is installed
if [ ! -f sim/0.11.0/node_modules/@pkmn/sim/package.json ]; then
    node build/tools/pkmn install-sim 0.11.0 \
        --dex @pkmn/dex@0.11.0 \
        --mods @pkmn/mods@0.11.0 \
        --randoms @pkmn/randoms@0.11.0
fi

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
    "arena/config/ai.pkmn.archive.plist:/Library/LaunchDaemons/ai.pkmn.archive.plist"; do
    src="${pair%%:*}"
    dst="${pair#*:}"
    if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
        NEEDS_SETUP=1
    fi
done
if [ -x /opt/arena/bin/limit ] && [ arena/bin/limit.c -nt /opt/arena/bin/limit ]; then
    NEEDS_SETUP=1
fi
if [ "$NEEDS_SETUP" -ne 0 ]; then
    echo "ERROR: Privileged Arena helpers/configs changed or differ from installed copies." >&2
    echo "Refusing to restart ai.pkmn.arena against stale host binaries." >&2
    echo "Re-run ./arena/scripts/setup-arena.sh, then restart ai.pkmn.arena:" >&2
    echo "  ./arena/scripts/setup-arena.sh && sudo launchctl kickstart -k system/ai.pkmn.arena" >&2
    exit 1
fi

# Signal the running coordinator to drain after the current match (if Arena files changed)
if [ "${command}" = "restart" ] || ! git diff --quiet "$HEAD" arena/ server/ db/ teams/ static/util.tsx package.json teams/package.json; then
    sudo -n /bin/launchctl kill SIGUSR1 system/ai.pkmn.arena 2>/dev/null ||
        pkill -USR1 -u "$(id -un)" -f '/build/arena' || true
fi
