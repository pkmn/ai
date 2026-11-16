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

# Update dependencies if package.json has changed
git diff --quiet "$HEAD" package.json teams/package.json >/dev/null ||
    npm install --silent

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

# Signal the running coordinator to drain after the current match (if Arena files changed)
if [ "${command}" = "restart" ] || ! git diff --quiet "$HEAD" arena/ server/ db/ teams/ static/util.tsx package.json teams/package.json; then
    sudo -n /bin/launchctl kill SIGUSR1 system/ai.pkmn.arena 2>/dev/null ||
        pkill -USR1 -u "$(id -un)" -f '/build/arena' || true
fi
