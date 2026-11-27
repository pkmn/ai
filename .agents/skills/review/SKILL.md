---
name: review
description: >-
  Pre-deploy code review, atomic remediation, and deployment planning for pkmn.ai
  and the arena Mac mini (`/review`). Compares live deployed commits on `pkmn.ai`
  and `arena` against local `HEAD`, audits every un-deployed commit for security,
  competition exploits/exfiltration, `AGENTS.md` style/architecture, simplification,
  performance, test hygiene, and operational deploy risks; stops for feedback;
  applies one atomic commit per approved finding; summarizes all commits; and
  produces an ordered, verifiable deploy and rollback plan.
---

# Pre-Deploy Code Review & Release Runbook (`/review`)

End-to-end review, atomic fixup, and deployment-planning workflow comparing what is
currently running in production (`pkmn.ai` VPS and `arena` Mac mini) against local `HEAD`.

**Golden rules:**
- **Always read [AGENTS.md](../../../AGENTS.md) and [tasks/lessons.md](../../../tasks/lessons.md)
  first** so you enforce real repo invariants and never file false positives against
  intentional designs.
- **Verify every finding in the actual source before reporting it.** Never repeat a
  subagent claim or flag code without reading the exact lines yourself.
- **Stop after Phase 2 (Review Report) for user feedback** — never edit code, commit,
  push, or deploy before the user chooses which findings to fix.
- **One atomic commit per finding** in Phase 3 — never bundle unrelated review fixes into
  a single catch-all commit.
- **Never push or deploy automatically** at the end of Phase 4 unless the user explicitly
  asks you to execute the deploy plan.
- **Respect dirty working trees:** if unrelated uncommitted changes exist on `main`, call
  them out in Phase 0 and do not silently include or discard them.

---

## Phase 0 — Discover Deployed vs. Local Commits (Read-Only)

1. Read [AGENTS.md](../../../AGENTS.md) and [tasks/lessons.md](../../../tasks/lessons.md).
2. Query live deployed `HEAD` on both production hosts alongside local git state:

```sh
git status -sb
git fetch origin main
echo "local HEAD: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
echo "origin/main: $(git rev-parse --short origin/main) $(git log -1 --format=%s origin/main)"
ssh pkmn@pkmn.ai 'cd /home/pkmn/ai && echo "pkmn.ai HEAD: $(git rev-parse --short HEAD) $(git log -1 --format=%s)" && git status -sb'
ssh arena 'cd /opt/arena/repo && echo "arena HEAD: $(git rev-parse --short HEAD) $(git log -1 --format=%s)" && git status -sb'
```

3. Compute the exact un-deployed commit ranges (let `VPS_HEAD` = `pkmn.ai` SHA,
   `ARENA_HEAD` = `arena` SHA, and `BASE` = the older ancestor of the two):

```sh
echo "=== Un-deployed on pkmn.ai (VPS_HEAD..HEAD) ==="
git log --reverse --oneline <VPS_HEAD>..HEAD
echo "=== Un-deployed on arena (ARENA_HEAD..HEAD) ==="
git log --reverse --oneline <ARENA_HEAD>..HEAD
echo "=== Changed files across BASE..HEAD ==="
git diff --stat <BASE>..HEAD
```

4. Check deploy-sensitive paths across `<BASE>..HEAD` right away:

```sh
git diff --stat <BASE>..HEAD -- \
  package.json teams/package.json \
  db/schema/ db/migration/ arena/db/schema/ arena/db/migration/ \
  config/ arena/bin/ arena/config/ arena/scripts/ \
  static/projects.yml static/rules.dj static/llms.txt tools/shots.tsx docs/TESTING.md
git diff <BASE>..HEAD | grep -E '^\+.*process\.env' | sort -u || true
```

*(If `VPS_HEAD == HEAD` and `ARENA_HEAD == HEAD`, report that both hosts are up to date
and check whether the user wants uncommitted working-tree changes reviewed instead.)*

---

## Phase 1 — Multi-Angle Review of `<BASE>..HEAD`

Inspect the full diff (`git log -p <BASE>..HEAD` or per-area diffs). When `<BASE>..HEAD`
is large (`> ~1,000` changed lines or `> 8` commits), you may fan out read-only `research`
subagents — **one focused angle per subagent** — to keep main context clean, then **read
and verify every cited file and line directly yourself** before including any finding.

Audit **all six dimensions** below:

### 1. Security, Competition Exploits & Data Exfiltration
Apply the **threat-actor boundary** from [AGENTS.md](../../../AGENTS.md):
- **Enforce strict hardening on untrusted boundaries:**
  - Artifact/OCI/bundle unpacking (`arena/unpack.ts`, `arena/packages.ts`,
    `arena/tournament.ts` `finalizeUnpackedOciRootfs`): zip-slip/path traversal, symlink
    escapes, archive bombs, executable bit/mode leaks, CAS poisoning.
  - Agent stdio, `/utm`, & `/info` (`server/protocol.ts`, `arena/arbiter.ts`,
    `arena/tournament.ts`): stdout/stderr line-length DoS, control-line spoofing (ensure
    `ARENA_AGENT_STDERR=` runs *before* `ARENA_TURN_MS=` / `ARENA_PEAK_RAM=` /
    `ARENA_SPOT_PREEMPTED` / `TOURNEY_ERROR`), malformed JSON/UTF-8, illegal teams.
  - Sandbox & privilege boundaries (`arena/bin/limit.c`, `arena/bin/arena`, `sandbox.sb`,
    `pf.anchor`, `sudoers`): airgap (`(deny network*)`, PF anchor, `podman --network=none`),
    fail-closed root drop, per-game `/Volumes/P1` & `/Volumes/P2` scratch wipe (no
    cross-game persistence/side-channels), no Xcode/dev-tool leaks into `sandbox.sb`.
  - Auth, web & external surfaces (`server/auth.ts`, `server/account.tsx`,
    `server/admin.tsx`, `server/discord.ts`, `server/wiki.tsx`, `server/smogon.ts`,
    `server/teams.ts`, viewer `postMessage`): CSRF (`isCrossSiteRequest`), session/API
    token validation & constant-time compare, admin gating (`isAdmin`), HTML escaping vs
    `raw(...)` XSS, SQL injection, rate limits, wiki Djot/slug/git safety, Smogon
    redirect allowlist, team paste validation.
- **Competition privacy & fairness invariants:**
  - **`pools` privacy:** Never leak `pools` (`VGC`) battle logs, raw team pastes, or
    `teams.json` before `status = 'archived'`, and never leak `ladder_teams` /
    `agent_ladder_teams` to public HTML, `.json`, SSE, or other agents.
  - **Telemetry privacy:** Never leak host `system` telemetry or private diagnostic
    logs/stderr to public `/api/live*`, `/arena/battles`, or non-owner requests.
  - **Fairness & anti-cheat:** Preserve `samplePoolsPair` `2/N` marginal probability,
    `Team.canonicalize` slot/move sorting (keeping `shiny`/`gender`/under-leveled sets;
    stripping only in dedup keys), `THRESHOLD = 1.30`, blind opponent names in
    ladders/tournaments, accurate turn/clock billing (`SIGSTOP`, `|t:|` before `|turn|N`).
- **Flag *over-validation* on trusted internal boundaries:** Per `AGENTS.md`, we own both
  ends of `Bearer $ARENA_SECRET` `/api/arena/*`, `config/*.yml`, admin CLI args, and
  server→browser DB/SSE payloads — flag newly added defensive coercion, path-traversal
  guards, or legacy fallbacks on self-controlled inputs as bloat to remove.

### 2. Bugs, Races & Edge Cases
- Async races, unhandled promise rejections, missing `try/finally` resource cleanup
  (child processes, timers, temp dirs, SQLite handles, file descriptors, locks).
- Transaction atomicity (`BEGIN IMMEDIATE` / `txRunner`), foreign-key cascades, WAL
  concurrency, crash recovery / idempotency (`outbox`, `recordCompletedMatch`).
- UI/SSR edge cases: empty states, zero matches, dark/light contrast, `375px` mobile
  overflow, SSE reconnect/disconnect cleanup.

### 3. `AGENTS.md` Style, Naming & Architecture
Check every changed file against [AGENTS.md](../../../AGENTS.md) and
[tasks/lessons.md](../../../tasks/lessons.md):
- Never `"bot"` in identifiers, types, filenames, SQL, config, or UI (only `"agent"` /
  `"project"`, except upstream names/citations).
- Uppercase `P1`/`P2` in all site UI surfaces; lowercase `p1`/`p2` in code/DOM/Showdown
  battle logs.
- `undefined` over `null` (translate SQLite `NULL` at the row boundary); constructor
  field initialization for monomorphic V8 shapes; string literal unions (never `enum`).
- No underscores outside SQL/wire payloads (`kebab-case` filenames, `camelCase`/`PascalCase`
  TS); no `DEFAULT_` constant prefixes; no filename repetition in exports; spell out
  `Millis`/`Seconds`; `@pkmn` `toID`/`ID` casing; 2-space indent, 100-char max, single
  quotes, no banned `eslint-disable` comments.
- Structured params ($\le 7\text{–}8$ positional args; `p1`/`p2` substructs and `games`
  arrays instead of flat 15–30 property bags; SQLite row structs exempt).
- **Don't cache — fix the design:** flag ad-hoc `Map`/memoization caches masking slow
  lifecycle or data-flow designs.
- **`db/` boundaries:** 1-to-1 `db/<table>.ts` + `db/schema/<table>.sql` +
  `db/migration/NNNN-*.sql` (keep `schema/` and `migration/` in sync; no `DEFAULT` baked
  into `version TEXT NOT NULL`; no `db/types.ts`).
- **Routes, errors & config:** `.json` mirrors only on SQLite-backed pages; generic site
  error pages (`renderErrorPage`, never custom HTML error pages); gate prod side effects
  strictly on `NODE_ENV === 'production'` (never `NODE_ENV === 'development'`); hardcoded
  canonical paths & port `1234` (no `PORT`/`HOST`/`ARENA_DB_PATH`).
- **Required cross-file syncs:**
  - `static/rules.dj` (or protocol/limits/formats/hardware/packaging) ↔ `static/llms.txt`
  - UI routes/views/controls/lifecycle states ↔ `tools/shots.tsx` & `docs/TESTING.md`

### 4. Simplification & Conciseness
- Flag verbose or over-engineered code that can be made shorter and clearer ("boring,
  readable code"), duplicated logic that should reuse `static/util.tsx` or existing
  helpers, trivial 1-line wrappers, unnecessary abstractions, or dead/unreachable code.

### 5. Performance & Optimization
- SQLite N+1 queries inside loops, missing indexes on filtered/sorted columns, redundant
  full-table scans on hot HTTP routes or SSE heartbeats.
- Synchronous I/O or subprocess spawns on request or mid-match hot paths (especially on
  the Mac mini between turns).
- Unbounded `Map`/`Set`/array/buffer growth in long-running daemons (`pkmn.ai-server`,
  `ai.pkmn.arena`) or SSE fan-out.

### 6. Test Hygiene & Coverage
- Redundant tests duplicating the exact same assertion/code path.
- Grab-bag `test('does X and Y', ...)` cases that should be split into focused
  single-responsibility tests (per `tasks/lessons.md`).
- Flaky timing assumptions (tight wall-clock timeouts like `0.1s` racing process spawns
  on saturated CI, missing `rootDir` isolation, shared mutable state).
- Missing regression tests for new untrusted-boundary validation, privacy gates, or
  migrations — and conversely, unnecessary tests for malformed self-inputs on trusted
  internal APIs.

---

## Phase 2 — Report Findings & Wait for User Feedback (HARD STOP)

Present a clear, high-signal review report:

1. **Deployment Scope Snapshot:** table showing current `pkmn.ai` HEAD, `arena` HEAD,
   `origin/main`, local `HEAD`, and commit counts for each host.
2. **Findings Grouped by Category** (*Security & Competition Exploits*, *Bugs & Races*,
   *`AGENTS.md` Style & Architecture*, *Simplification & Performance*, *Test Hygiene*,
   *Deploy / Operational Risks* — omit empty categories):
   - Assign each finding a stable ID (**`F1`**, **`F2`**, ...), severity (`Critical` /
     `High` / `Medium` / `Low` / `Nit`), clickable `file://` path + line range, concise
     explanation of root cause/impact, and concrete recommended fix.
   - Distinguish **confirmed issues** from **optional polish/nits**.
3. **Clean Areas Checked:** 2–4 concise bullets summarizing security/fairness/deploy
   checks that passed with no issues found.
4. **STOP and ask the user** which findings (`F1`, `F2`, ... or "all", "all except F7",
   etc.) they want implemented (plus resolve any design ambiguity or dead-code removal
   permission up front).

**Do NOT edit files or make commits until the user replies.**

---

## Phase 3 — Atomic Fixes (One Commit Per Approved Finding)

For **each** approved finding, one at a time:

1. Make the minimal, surgical change addressing **only that single finding**.
2. Run relevant targeted tests (`npx vitest run test/<suite>.test.ts`) to confirm the fix
   (and add a focused regression test in the same commit when fixing a bug or security
   issue).
3. Stage **only** the files belonging to that finding and commit immediately with a clear,
   specific commit message (e.g. `Enforce pools archive gate on ...`, `Split combined
   cooldown tests in test/account.test.ts`, `Inline single-use helper in server/admin.tsx`).
   - **Never combine multiple findings into one commit.**
   - **Never mix unrelated uncommitted working-tree edits into a review commit.**

After **all** approved finding commits are created:
- If any TSX/CSS/client code changed: run scoped visual verification
  (`npm run shots -- --only <affected-sections>`), inspect changed PNGs and verify zero
  console errors and zero `375px` overflow, then clean mock artifacts.
- Run the full verification suite:
  ```sh
  npm run clean && npm test
  ```
  Confirm `tsc`, static build, `eslint`, `stylelint`, `hyperlink`, and **all** `vitest`
  tests pass with zero failures (never dismiss a flaky test — diagnose and fix it!).

---

## Phase 4 — Commit Inventory & Detailed Deploy Plan

After all fixes are committed and `npm test` is green, deliver two concrete sections:

### A. Complete Commit Summary (Original + Review Commits)
List **every** commit from `<BASE>..HEAD` in chronological order (oldest → newest),
separating or tagging original commits vs. review-fix commits, with:
- `<short-sha>`
- Concise 1-line summary of what it does
- Target host(s): `pkmn.ai`, `arena`, `both`, or `dev/tests only`

### B. Tailored Deploy & Rollback Plan
Inspect live host configuration (read-only) whenever deploy-sensitive files changed so
the instructions contain **zero guesswork**:
- Check symlinks/timers on `pkmn.ai` if `config/` changed (`nginx.conf`,
  `pkmn.ai-*.{service,timer}`).
- Check installed privileged files on `arena` if `arena/bin/`, `arena/config/`, or
  `arena/scripts/setup-arena.sh` changed (compare against `/opt/arena/bin/`,
  `/opt/arena/etc/`, `/Library/LaunchDaemons/`, `/etc/sudoers.d/arena`).
- Check if any `static/projects.yml` registrations need post-deploy `pkmn set-ladders`.
- Check if any `db/migration/` or `arena/db/migration/` files will run on boot (SQLite
  automatically backs up `arena.sqlite.pre-<migration>.bak` before running migrations —
  verify whether rollback needs restoring that backup!).

Structure the deploy instructions with exact copy-pasteable commands:

1. **Pre-Deploy Checks:** clean tree, `npm run clean && npm test`, verify `pkmn.ai` &
   `arena` HEADs and whether a match is currently active on `arena`
   (`/opt/arena/state/match.lock`).
2. **Exact Deployment Order & Why:**
   - **Push:** `git push origin main`
   - **Deploy `pkmn.ai` FIRST** (`npm run deploy:reload` — or `npm run deploy:restart` if
     a forced restart is needed; explain what [deploy](../../../deploy) handles
     automatically: `./private/sync`, `npm install --omit=dev` if `package.json` changed,
     submodules, `systemctl daemon-reload` if unit/timer changed, build, server restart,
     smoke check, `./private/deploy`, `nginx -t && service nginx reload`).
   - **Deploy `arena` SECOND (ONLY if needed)** — required if `<ARENA_HEAD>..HEAD` touches
     `arena/`, `server/`, `db/`, `teams/`, `static/util.tsx`, or `package.json`:
     - Run `npm run deploy:arena` ([arena/scripts/deploy.sh](../../../arena/scripts/deploy.sh)).
     - **Privileged-file gate (`NEEDS_SETUP=1`):** If `arena/bin/{limit.c,arena,baseline}`,
       `arena/config/`, or `arena/scripts/setup-arena.sh` changed, explicitly warn that
       `npm run deploy:arena` will pull & compile and then **exit 1 without restarting
       `ai.pkmn.arena`**. Provide the exact interactive `ssh -t arena` surgical
       privileged-install commands (preferring surgical `sudo install` + `visudo -cf` +
       `launchctl bootout`/`rm` for renamed plists + `launchctl bootstrap` over full
       `setup-arena.sh` while matches may be live!) followed by graceful drain
       (`sudo -n /bin/launchctl kill SIGUSR1 system/ai.pkmn.arena`).
     - **Mac mini safety constraints (always include when deploying `arena`):**
       - Always drain gracefully with `SIGUSR1` (never hard-restart/reboot the Mac mini or
         trigger macOS GUI/TCC dialogs — headless remote host with no screen sharing).
       - Leave `ARENA_GCS_SYNC` untouched in `/opt/arena/repo/.env` unless explicitly asked.
3. **Post-Deploy Manual Operator Steps** (only those actually needed for this release):
   - e.g. `pkmn set-ladders ...`, `.env` updates, `pkmn install-sim ...`, LaunchDaemon
     bootout/bootstrap, etc. (State *"None required"* if none apply.)
4. **Safe Post-Deploy Verification Checklist** (exact commands + expected outputs):
   - `pkmn.ai`: `git rev-parse --short HEAD`, `schema_migrations` (if migrated),
     `journalctl -u pkmn.ai-server -n 25 --no-pager`, `systemctl status` for any updated
     timers, targeted `curl` checks for every changed route/API/JSON/asset, and
     regression checks for any security/privacy fixes.
   - `arena` (if deployed): `git rev-parse --short HEAD`, `sudo -n /bin/launchctl print
     system/ai.pkmn.arena` (new PID, `state = running`), `tail -n 25 /opt/arena/logs/arena.err`,
     and `curl -fsS https://pkmn.ai/api/live.json | jq '{updatedAt, stale, live}'`
     (`stale: false` with fresh heartbeat).
5. **Rollback Procedure:**
   - Note [deploy](../../../deploy)'s automatic `trap rollback ERR` on `pkmn.ai` build/smoke
     failure.
   - Exact manual rollback commands for `pkmn.ai` (`git reset --hard <VPS_HEAD>` +
     `npm run compile && npm run build && sudo service pkmn.ai-server restart` + nginx/unit
     reload if changed, plus restoring `arena.sqlite.pre-<migration>.bak` if a breaking DB
     migration ran) and `arena` (`git reset --hard <ARENA_HEAD>` + `npm run compile` +
     `SIGUSR1` drain + restoring `arena.sqlite.pre-*.bak` / privileged configs if changed).
6. **Ask the user** whether they want you to execute the deploy plan now (or hand it off).
