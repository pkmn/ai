# Testing

This guide covers automated unit/integration tests, responsive visual-regression checks, interactive
multi-persona walkthroughs, and the declarative `.mock` scenario engine used to test **pkmn.ai**
end-to-end without real agent containers or cloud VMs.

For initial local setup and environment variables, see [DEVELOPMENT.md](DEVELOPMENT.md); for
production operator commands, see [ADMIN.md](ADMIN.md).

---

## 1. Automated Build, Lint & Test Suite

Run both the static build/lint pipeline and the Vitest suite before considering any change complete:

```sh
# 1. Type-check (tsc -p .), build static HTML/JSON, run ESLint, Stylelint, and Hyperlink anchor checks
npm run test

# 2. Run all unit, database, HTTP API, rating math, and Playwright E2E tests
npx vitest run

# Or run both in one command (used by GitHub Actions CI):
npm run test:integration
```

### What the Automated Suite Covers

- **`npm run test`:**
  - `tsc -p .` compiles `static/`, `server/`, `db/`, `teams/`, and `tools/` into `build/`.
  - `node build/static/build` renders all Djot essays, BibTeX/YAML catalogs, and static Arena pages
    into `public/`.
  - `eslint --cache` enforces `@pkmn/eslint-config` across TypeScript sources and tests.
  - `stylelint static/*.css` checks CSS property ordering and selector specificity.
  - `hyperlink public --check-anchors` verifies zero broken internal links or `#anchor` fragments
    across every generated HTML file in `public/`.
- **`npx vitest run` (`test/*.test.ts`):**
  - `test/ratings.test.ts` — Finite-difference gradients/Hessians, KKT optimality, index-permutation
    invariance, bipartite/disconnected graphs, Monte Carlo convergence, and active-learning
    matchmaking (`server/ratings.ts`).
  - `test/protocol.test.ts` — Verifies stdio command parsing and opponent chat / covert-channel
    elision across `@pkmn/sim` battles (`server/protocol.ts`).
  - `test/db.test.ts` — SQLite schema bootstrap, sequential `db/migration/NNNN-*.sql` upgrades,
    project/Smogon sync, ladder lifecycle & rotation, and match aggregation (`db/`).
  - `test/auth.test.ts`, `test/account.test.ts`, `test/wiki.test.ts`, `test/discord.test.ts`,
    `test/api.test.ts`, `test/render.test.ts`, `test/projects.test.ts` — OAuth cookies, submission
    gating & 1-NN team uniqueness, Git-backed wiki revisions & visibility tiers, Discord role/DM
    sync, `/api/arena/*` control-plane endpoints, and static HTML/`.json` rendering.
  - `test/e2e.test.ts` — Executes [`tools/scenarios/e2e.mock`](../tools/scenarios/e2e.mock) in Live
    HTTP Server Mode against a real in-process server and verifies interactive browser flows in
    headless Chromium (`playwright-core`).

> [!NOTE]
> If Playwright has not downloaded its headless Chromium shell yet, install it once with:
> ```sh
> npx playwright-core install chromium
> ```

### Testing Candidate Team Uniqueness (`teams/`)

To test a candidate team paste against reference blocklist directories using the exact $1\text{-NN}$
distance threshold ($d_{\text{1-NN}} \ge 1.30$) enforced by `POST /api/submissions`:

```sh
node build/teams/index.js <candidate-team.txt> \
  teams/teams/gen9championsvgc2026regmc \
  teams/pkmn_stuff/teams/Teams_real \
  teams/vgc.bot/gen9championsvgc2026regmc \
  --format=gen9championsvgc2026regmc
```

---

## 2. Visual Regression & Layout Verification (`npm run shots`)

Whenever modifying HTML templates (`static/*.html`), stylesheets (`static/*.css`), Djot layouts, or
client scripts, run [`tools/shots.ts`](../tools/shots.ts):

```sh
# Render all scenarios across 4 viewports x 2 color schemes into .shots/
npm run build
npm run shots

# Record a baseline in .shots/baseline/ before modifying templates or CSS
npm run shots -- --baseline

# Re-run after changes to compare against .shots/baseline/ and generate .shots/diff/index.html
npm run shots
npm run shots -- --tolerance 20

# Filter to a specific scenario substring while iterating on a single page
npm run shots -- --only arena-ladder
npm run shots -- --only account
```

`npm run shots` boots an isolated in-memory fixture seeded with
[`tools/scenarios/seed.mock`](../tools/scenarios/seed.mock) and captures full-page screenshots across:
- **4 viewports:** `small` (`375×667`), `phone` (`390×844`), `tablet` (`744×1133`), `desktop`
  (`1280×900`)
- **2 color schemes:** `light` and `dark`

Every `(scenario, viewport, theme)` combination asserts **zero console/page errors** and **zero
horizontal overflow** (`document.documentElement.scrollWidth <= window.innerWidth`), writing PNGs to
`.shots/<viewport>/<theme>/<scenario>.png` for direct inspection.

After inspecting `.shots/` (or running local `mock` commands), clean build/public artifacts and
re-run `npm run test` so `public/` contains no mock state:

```sh
npm run clean && npm run test
```

---

## 3. Interactive Manual Testing & Persona Walkthrough

### Step 1: Seed the Local Dataset & Start `dev`

```sh
npm run build
npm run mock -- seed
MOCK=1 npm run dev
```

- `npm run mock -- seed` runs [`tools/scenarios/seed.mock`](../tools/scenarios/seed.mock), resetting
  `db/data/arena.sqlite`, populating `.mock/` overlays (`.mock/ladders.yml`, `.mock/static/projects.yml`
  + generated 32×32 avatars, `.mock/wiki/` with public and `{% visibility: developers %}` pages,
  `.mock/vgc-teams.txt` with 20 legal Regulation M-C teams, and Championship Tournaments `#1`
  completed, `#2` running, and `#3` scheduled), and rendering `public/`.
- `MOCK=1 npm run dev` starts the server on `http://localhost:1234` with `DEV_AUTH=1`.
- Visit `http://localhost:1234/` or `http://localhost:1234/arena/` to verify the site-wide `#topbar`
  `[LIVE] Tournament #2: VGC 2026 Reg M-C OTS BO3` banner (while `http://localhost:1234/background/`
  retains its permanent `Under Construction` `#topbar`).
- Optionally run organic background activity in a second terminal so submitted versions automatically
  smoke-test and live matches tick across turns:

```sh
MOCK=1 npm run mock -- simulate --server http://localhost:1234 --secret "${ARENA_SECRET:-dev-secret}"
```

To wipe all seeded state and return to clean unseeded configs (`config/ladders.yml` +
`static/projects.yml`):

```sh
rm -rf .mock db/data/arena.sqlite* && npm run build
```

### Step 2: Switch Auth Personas via `GET /auth/dev`

When `DEV_AUTH=1` is set on loopback (`localhost` / `127.0.0.1`), `GET /auth/dev` mints real
HMAC-signed `pkmn_session` cookies so every route (`/account`, `/api/submissions`, `/wiki/*`,
`/auth/discord/validate`) exercises the production session and authorization codepath. Visiting
`http://localhost:1234/auth/dev` directly opens an interactive persona picker, or you can open a
normal window and an Incognito window side-by-side at any onboarding stage:

- **Unauthenticated visitor** (public spectator views; `/account` and developer wiki pages redirect
  to login):
  `http://localhost:1234/auth/dev?clear=1&return_to=/arena`
- **Unregistered GitHub user** (`403` registration prompt on `/account`; blocked from developer wiki
  pages and editing):
  `http://localhost:1234/auth/dev?github=stranger&return_to=/account`
- **Stage 1 — `Pending` (`qualified: false`, Discord unlinked) — `AsterAI`:**
  `http://localhost:1234/auth/dev?github=asterdev&return_to=/account`
  *(Account page accessible with "Link Discord" CTA and disabled submission form; can view
  `/wiki/0_ERROR` and edit `/wiki/AsterAI`.)*
- **Stage 2 — `Qualified` (qualified project before ladders open):**
  Start plain `npm run dev` (without `MOCK=1`, or set ladders to `upcoming` via
  `MOCK=1 npm run pkmn -- set-ladder-status <id> upcoming`) to inspect the pre-launch `Qualified`
  state while ladders are `upcoming`.
- **Stage 3 — `Eligible` (brand-new `qualified: true` project, 0 submissions yet) — `CynthiAI`:**
  `http://localhost:1234/auth/dev?github=sisyphus25&return_to=/account`
  *(Empty Active/History tables; checking `VGC` reveals the 20-team paste box — run
  `pbcopy < .mock/vgc-teams.txt` on macOS to paste 20 legal Regulation M-C teams and submit
  `1.0.0`.)*
- **Stage 4 — `Eligible` (settled multi-ladder competitor, VGC teams already locked) — `Foul Play`:**
  `http://localhost:1234/auth/dev?github=pmariglia&return_to=/account`
  *(Submit `1.5.0` to watch `/account` transition immediately to **Ineligible — awaiting Arena smoke
  testing**, then run `MOCK=1 npm run mock -- smoke all && MOCK=1 npm run mock -- play 1 && MOCK=1 npm run mock -- render`
  — or let `mock -- simulate` pick it up — to smoke-test it, promote it to Challenger, and play a
  match.)*
- **Stage 5 — `Ineligible` (14-day ladder cooldown + Tournament open + Wiki Admin) — `0 ERROR`:**
  `http://localhost:1234/auth/dev?github=scheibo&discord=513513270670262284&return_to=/account`
  *(Shows `1.2.0` + `1.1.0` active side-by-side, `1.0.0` retired, `0.9.0-rc1` failed smoke-test
  trace, full wiki admin access, active 14d ladder cooldown while `Tournament #3` remains open for
  OCI submission — waive the ladder cooldown live with `MOCK=1 npm run pkmn -- refund-cooldown 0-error`
  and refresh `/account`.)*
- **Stage 6 — `Ineligible` (unsettled provisional active version: `< 25` matches) — `pokerus`:**
  `http://localhost:1234/auth/dev?github=pokerusdev&return_to=/account`
  *(Past the 14-day window, but blocked until `1.0.2` finishes settling on RBY & SV.)*

### Step 3: CLI Cookie Minting & Live OAuth Redirect Testing

- **Minting session cookies for `curl`:** When testing authenticated routes from the terminal against
  an explicit `SESSION_SECRET`, mint a `pkmn_session` cookie with `pkmn session`:

```sh
COOKIE=$(SESSION_SECRET=test-secret npm run --silent pkmn -- session \
  --github pmariglia --discord 283674461268344832:pmariglia)
curl -fsS -H "Cookie: $COOKIE" http://localhost:1234/account.json
```

- **Testing `/api/arena/*` control-plane endpoints with `curl`:**

```sh
curl -fsS -H "Authorization: Bearer $ARENA_SECRET" \
  http://localhost:1234/api/arena/pending-submissions
```

- **Testing live GitHub/Discord OAuth redirects locally:** Create a separate `pkmn.ai (dev)` OAuth
  App with callback `http://localhost:1234/auth/github/callback` (and/or Discord redirect
  `http://localhost:1234/auth/discord/callback`) and start without `DEV_AUTH=1`:

```sh
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... PUBLIC_URL=http://localhost:1234 npm start
```

---

## 4. Developer & Operator Tools (`tools/`)

| Tool | Script | Purpose |
| :--- | :--- | :--- |
| [`pkmn.ts`](../tools/pkmn.ts) | `npm run pkmn -- <cmd>` | Operator CLI: quarantine/unquarantine versions, refund cooldowns, reassign developers, set 1500-Elo anchors, rotate ladders, manage tournaments, lookup Smogon IDs, and mint cookies (see [ADMIN.md](ADMIN.md)). |
| [`mock.ts`](../tools/mock.ts) | `npm run mock -- ...` | Declarative `.mock` scenario engine, probabilistic Davidson match simulator, and organic site-activity generator (`simulate`). |
| [`simulate.ts`](../tools/simulate.ts) | `npm run simulate -- ...` | Multi-seed Monte Carlo parameter-sweep simulator for active-learning matchmaking (`selectNextArenaMatch`) and Generalized Davidson ratings (`computeDavidsonRatings`). |
| [`shots.ts`](../tools/shots.ts) | `npm run shots` | Headless Chromium visual-regression & layout verifier across 4 viewports × 2 color schemes. |
| [`scenarios/`](../tools/scenarios/) | — | Checked-in `.mock` scenario scripts ([`seed.mock`](../tools/scenarios/seed.mock) for local dev & `shots`, [`e2e.mock`](../tools/scenarios/e2e.mock) for HTTP + Playwright integration tests). |

### Invoking `mock`

Compile TypeScript first (`npm run compile` or `npm run build`), then invoke `npm run mock`:

```sh
# 1. Run the default local seed scenario (tools/scenarios/seed.mock)
npm run mock -- seed

# 2. Execute any checked-in or custom .mock script file
MOCK=1 npm run mock -- -f tools/scenarios/seed.mock

# 3. Pipe declarative commands line-by-line over stdin
MOCK=1 npm run mock < tools/scenarios/seed.mock
printf 'play 5 --ladder rby\nrender\n' | MOCK=1 npm run mock

# 4. Run individual commands sequentially (persisting state in .mock/state.json)
MOCK=1 npm run mock -- register "BoltBeam" --logo auto
MOCK=1 npm run mock -- submit boltbeam 1.0.0 rby=1620 sv=1580
MOCK=1 npm run mock -- play 20 --ladder rby,sv
MOCK=1 npm run mock -- render

# 5. Keep a local dev server feeling live with organic background activity
MOCK=1 npm run mock -- simulate --server http://localhost:1234 --secret "$ARENA_SECRET"
```

### Global `mock` CLI Flags

| Flag | Description |
| :--- | :--- |
| `-f <path>`, `--file <path>` | Execute a `.mock` script file from top to bottom. |
| `--db <path>` | Override the SQLite database path (defaults to `db/data/arena.sqlite`, or `:memory:`). When omitted, `mock` manages overlay files inside `.mock/`. |
| `--public-dir <dir>` | Override output directory for static HTML/JSON renders (defaults to `public/`). |
| `--server <url>` | Run in **Live HTTP Server Mode** against a running `pkmn.ai` server instead of mutating submission/runner tables directly. |
| `--secret <token>` | Bearer `$ARENA_SECRET` for `/api/arena/*` requests when `--server` is set (falls back to `process.env.ARENA_SECRET`). |
| `--now <spec>` | Pin the initial simulated clock (`anchorNow`) across `mock seed`, `-f <scenario>`, stdin, or commands (Unix seconds, ISO-8601, or relative spec). |
| `-h`, `--help` | Print CLI usage summary. |

### Dual Transport Modes

Every `.mock` scenario runs unchanged in two modes:

1. **Direct DB/FS Mode** *(default when `--server` is omitted)*:
   Writes directly to SQLite (`db/data/arena.sqlite`), `.mock/static/projects.yml`, `.mock/ladders.yml`,
   and `.mock/wiki/`, and renders static views via `render`. Optimized for fast seeding
   (`npm run mock -- seed`) and screenshot fixtures (`npm run shots`).
2. **Live HTTP Server Mode** *(`--server http://localhost:1234`)*:
   Exercises the real HTTP endpoints on a running server:
   - Developer sessions are minted via `SESSION_SECRET` (if configured) or
     `GET /auth/dev?github=<login>` (`DEV_AUTH=1`).
   - `submit` posts JSON payloads (including encrypted `authToken` headers and 20-team VGC pools) to
     `POST /api/submissions`.
   - `smoke` and `quarantine` pull `GET /api/arena/pending-submissions` and report telemetry to
     `POST /api/arena/submission-status` (triggering real server re-renders and Discord DMs).
   - `play`, `settle`, `match`, and `live` emit `POST /api/arena/heartbeat` and
     `POST /api/arena/match-complete`.
   - `wiki --via http` submits form edits to `POST /wiki/:slug/edit`.

### Overlay Files & Persistent State (`.mock/`)

To avoid dirtying tracked `config/ladders.yml` or `static/projects.yml`, running `mock` without
`--db` stores all mutable filesystem state under `.mock/` (read automatically when the server starts
with `MOCK=1`):

- `.mock/state.json` — Persists PRNG state (`rngState`), simulated clock (`now` and `anchorNow`),
  match & heartbeat sequence counters, per-version/per-agent expected ratings, H2H matchup biases,
  pending smoke-test metadata, active live telemetry, and tournament broadcast state across CLI calls.
- `.mock/ladders.yml` — Active/upcoming/settling/archived ladder configuration overlay.
- `.mock/static/projects.yml` & `.mock/static/avatars/` — Registered project catalog and
  generated/copied 32×32 PNG avatars.
- `.mock/wiki/` — Git-backed Djot wiki repository with commit history and author timestamps.
- `.mock/vgc-teams.txt` — Ready-to-paste sheet of 20 legal Regulation M-C teams
  ($d_{\text{1-NN}} \ge 1.30$) for interactive `/account/` testing.

---

## 5. `.mock` Language, Rating Simulation & Command Reference

### Lexical Rules & Argument Formats

- **Comments & Blank Lines:** Empty lines and lines whose first non-whitespace character is `#` are
  ignored. Inline `# comments` preceded by whitespace outside quotes are stripped to end-of-line.
- **Line Continuations:** A trailing backslash (`\`) joins the next line into the same command.
- **Quoting & Escapes:** Single quotes (`'...'`) are literal; double quotes (`"..."`) interpret
  `\n`, `\r`, `\t`, `\"`, and `\\`.
- **Flags:** Long (`--flag value`, `--flag=value`) and short (`-f value`) flags may appear in any
  order alongside positional arguments. Boolean flags without a value default to `true`. Repeatable
  flags (`--owner`, `--discord`, `--vs`) accumulate all occurrences.
- **`<agent>`:** Matches by URL slug (`0-error`), case-insensitive display name (`"0 ERROR"`), or
  Showdown ID (`0error`).
- **`<agent>[@<ver>]`:** Targets an explicit version (`0-error@1.2.0`) or, when `@<ver>` is omitted,
  resolves the agent's active entry on the target ladder (falling back to its most recent `passed`
  or submitted version).
- **`<ladders>`:** Accepts a ladder slot (`rby`, `adv`, `sv`, `rand`, `vgc`), an exact `ladder_id`
  (`gen9championsvgc2026regmc`), a comma-separated list (`rby,sv`), or `all` (every non-archived
  ladder).
- **Durations (`<dur>`):** Compact human units — `s` (seconds), `m` (minutes), `h` (hours), `d`
  (days), `w` (weeks), e.g. `45m`, `12d`, `2w`.
- **Timestamps (`<ts>`):**
  - `now`, `now-<dur>`, `now+<dur>` — relative to the scenario's initial anchor timestamp
    (`anchorNow`).
  - `+<dur>` / `-<dur>` — relative step from the current simulated clock (`state.now`).
  - Unix epoch seconds (`1762776000`) or ISO-8601 (`2026-10-20T12:00:00Z`).
- **Byte Sizes (`<bytes>`):** Accepts plain integers or `b`, `kb`, `mb`, `gb` suffixes (e.g.
  `184mb`, `512kb`).

### Probabilistic Expected Ratings

When an agent version is submitted (`submit 0-error 1.0.0 rby=1660 adv=1630`) or entered into a
tournament (`tournament enter 1 mews-truck@1.0.0=1820`), those numbers define the version's **latent
expected Elo** on each format — *not* a hardcoded leaderboard rating.

Whenever two versions $i$ and $j$ play a simulated game with expected ratings $E_i$, $E_j$, optional
H2H bias $B_{ij}$, and per-game tie rate $\tau$, `mock` samples `'W'`, `'T'`, or `'L'` from the exact
single-game Generalized Davidson likelihood with log-skill difference
$\Delta = (E_i - E_j + B_{ij}) / (400 / \ln 10)$ and tie parameter $\nu = 2\tau / (1 - \tau)$:

$$P(\text{W}) = \frac{e^{\Delta/2}}{e^{\Delta/2} + e^{-\Delta/2} + \nu}, \qquad P(\text{T}) = \frac{\nu}{e^{\Delta/2} + e^{-\Delta/2} + \nu}, \qquad P(\text{L}) = \frac{e^{-\Delta/2}}{e^{\Delta/2} + e^{-\Delta/2} + \nu}$$

Each ladder match samples Game 1 and Game 2 independently (`WW`, `WT`, `TW`, `WL`, `LW`, `TT`, `TL`,
`LT`, `LL`) and feeds the resulting counts into the production whole-history Generalized Davidson
MAP solver (`server/ratings.ts`).

### 5.1 Environment, Clock, PRNG & Checkpoints

```sh
# Wipe SQLite Arena tables & .mock/ overlays, reset state.json, and write .mock/vgc-teams.txt
reset [--seed <uint32>] [--now <ts>] [--open-ladders]

# Set or advance the simulated clock (state.now)
time <+dur|-dur|now|now-dur|now+dur|iso|unix>

# Re-seed the deterministic Mulberry32 PRNG mid-scenario without resetting DB state
rng <uint32>

# Invoke programmatic onCheckpoint(name, runner) callback (used in test/e2e.test.ts)
checkpoint <name>
```

### 5.2 Projects, Developers & Discord

```sh
# Register or update an Arena project in projects.yml + SQLite
register <name> \
  [--owner <github[:smogon[.id]]> ...] \
  [--discord <id:username|username|none> ...] \
  [--logo <filename|auto>] \
  [--pending] [--disabled] [--banned] [--no-guild]

# Promote a pending project to qualified: true, or remove its arena: block
qualify <agent>
disable <agent>

# Move a developer's GitHub identity to another project (or remove with --none)
reassign <github> <target-agent|--none> [--smogon <username.id>]

# Clear the 14-day submission cooldown on <agent>
refund-cooldown <agent>

# Link/unlink Discord or trigger the onDiscordSync role-sync hook
discord link <github> [<id>:<username>] [--no-guild]
discord unlink <github>
discord sync
```

### 5.3 Ladders

```sh
# Open upcoming ladders to active, or set an explicit lifecycle status
ladder open [<ladders|all>]
ladder status <ladders|all> <upcoming|active|settling|archived>

# Add a new ladder to ladders.yml + SQLite
ladder add <id> --name <title> --format <ps-format> \
  [--team <harvested|pools|random>] [--min <n>] [--teams <n>] \
  [--status <upcoming|active|settling|archived>] [--discord <role-id>]

# Rotate an active seasonal ladder into settling/archived and optionally open its successor
ladder rotate <old-ladder> --archive-name <archived-title> \
  [--new <new-id>] [--new-name <title>] [--format <ps-format>] \
  [--team <harvested|pools|random>] [--min <n>] [--teams <n>] [--discord <role-id>]

# Pin <agent>[@<ver>] as the 1500-Elo gauge anchor and recompute ratings
ladder anchor <ladders|all> <agent>[@<ver>]

# Publish <ladder_id>-logs.7z to public/arena/ladders/<ladder_id>/
ladder archive <ladder> [--file <path>]
```

### 5.4 Submissions, Smoke Testing & Quarantine

```sh
# Submit a new agent version (defaults to --smoke pass; use --smoke pending or --smoke fail to test queues)
submit <agent> [<version>] [<target>[=<rating>] ...] \
  [--rating <elo>] \
  [--tournament <id[,id...]>] \
  [--vs <opp[@ver]:delta[,...]>] \
  [--pkg <bundle|oci>] [--url <artifact-url>] [--sha256 <hex>] [--auth-token <header>] \
  [--by <github>] \
  [--teams <auto|new|none|path>] \
  [--smoke <pass|pending|fail>] [--error <msg>] [--notified] \
  [--bytes <size>] [--duration-millis <n>] [--turn-millis <n>] [--ram <mib>]

# Process pending submissions in the Arena pull queue
smoke [<agent>[@<ver>]|all] [--pass|--fail] [--error <msg>] [--notified] \
  [--bytes <size>] [--duration-millis <n>] [--turn-millis <n>] [--ram <mib>]

# Quarantine or restore a version
quarantine <agent>[@<ver>] [--reason <msg>] [--via <runner|admin>]
unquarantine <agent>[@<ver>]
```

### 5.5 Matchmaking, Settlement & Direct Matches

```sh
# Schedule and simulate <count> 2-game Arena matches via selectNextArenaMatch (or --balanced)
play [<count>] [--ladder <ladders>] [--over <dur>] \
  [--exploit <0..1>] [--balanced] \
  [--tie-rate <0..0.8>] [--fault-rate <0..1>] [--heartbeats]

# Schedule targeted matches until every active version settles (matches >= 25 and SE <= 30.0)
settle [<ladders|all>] [--over <dur>] [--max <steps>] [--tie-rate <p>] [--heartbeats]

# Play explicit 2-game matches between <p1> and <p2>
match <ladder> <p1>[@<ver>] <p2>[@<ver>] [--count <n>] [--over <dur>] \
  [--outcome <WW|WT|TW|WL|LW|TT|TL|LT|LL|auto>] \
  [--reason <str>] [--g1-reason <str>] [--g2-reason <str>] \
  [--p1-team <hash:agent|P1:agent|P2:agent|raw>] \
  [--p2-team <hash:agent|P1:agent|P2:agent|raw>] \
  [--tie-rate <p>] [--heartbeats]
```

### 5.6 Live Battle Telemetry

```sh
live match <ladder> <p1>[@<ver>] <p2>[@<ver>] \
  [--id <match-id>] [--game <1|2>] [--turn <n>] [--active <p1|p2>] \
  [--g1-winner <p1|p2|tie>] [--g1-turns <n>] \
  [--p1-bank <sec>] [--p2-bank <sec>] [--budget <sec>] \
  [--p1-team <spec>] [--p2-team <spec>]

live idle
live stale
```

### 5.7 Championship Tournaments

```sh
tournament create <id> --name <title> --format <ps-format> \
  [--games <even-int>] [--batch <n>] [--tables <n>] \
  [--hardware <desc>] [--rules <json-array>] \
  [--starts <ts>] [--status <scheduled|running|completed>]

tournament enter <id> <agent>[@<ver>][=<rating>] ... [--pkg <oci|bundle>] [--by <github>]
tournament seed <id>
tournament start <id>

tournament play <id> [--cycles <n> | --games <n> | --all] \
  [--superfinal [<games>]] [--over <dur>] [--id-prefix <slug>] [--tie-rate <p>]

tournament broadcast <id> [<mainP1> <mainP2> [<sideP1> <sideP2>]] [--cycle <n>] [--game <n>]
tournament broadcast off

tournament complete <id> [--archive]
```

### 5.8 Wiki, Static Rendering & Organic Simulation (`simulate`)

```sh
# Commit a Djot page revision into .mock/wiki/ (or POST /wiki/:slug/edit with --via http)
wiki <slug> (--content <djot> | --file <path>) \
  [--by <github>] [--message <commit-msg>] \
  [--visibility <public|discord|developers|admin>] \
  [--via <git|http>]

# Re-render all static Arena HTML & JSON views into public/ at state.now
render

# Bounded deterministic activity burst (for scripts/tests)
simulate <steps> [--over <dur>]

# Unbounded real-time daemon loop with random +/-40% interval jitter (Ctrl-C to stop)
simulate [--interval <millis>]
```

---

## 6. Matchmaking & Rating Parameter-Sweep Simulator (`npm run simulate`)

### Why It Is Used

Unlike traditional human ladders where players self-queue in parallel, the M6 Mac mini Arena runner
time-slices a single active 2-game match at a time across all playable ladders (`RBY`, `ADV`, `SV`,
`RAND`, `VGC`). Every match scheduled by [`selectNextArenaMatch`](../server/ratings.ts) must balance
three competing goals:

1. **Global uncertainty reduction (exploration):** Quickly shrinking 95% confidence intervals
   ($\text{CI}_{95} < 150\text{ Elo}$) and settling newly submitted Challenger versions across the
   entire roster using expected Shannon/Fisher information gain
   $\frac{1}{2}\ln(1 + 4 \hat{p}(1 - \hat{p})(\sigma_i^2 + \sigma_j^2))$.
2. **Top-of-leaderboard separation (exploitation):** Focusing matches among podium contenders with
   high conservative lower bounds ($\text{LCB} = \text{Elo} - 1.96\,\text{SE}$) so `#1` and top-3
   guaranteed rank bounds ($[\text{rankMin}, \text{rankMax}] = [1, 1]$) resolve cleanly without
   wasting compute on already-separated bottom pairs.
3. **Cross-ladder & per-agent fairness (anti-starvation):** Ensuring quieter ladders with fewer
   recent submissions still receive regular matches via `agingRate` and the hard `maxWaitCycles`
   ceiling (`maxWaitCycles * numPlayableLadders`), and avoiding repeat pairings via the pairwise
   saturation penalty $1 / \sqrt{1 + n_{ij}}$.

Changing `exploit`, `agingRate`, or `maxWaitCycles` in [`server/ratings.ts`](../server/ratings.ts)
shifts the Pareto frontier between these objectives. [`tools/simulate.ts`](../tools/simulate.ts)
runs fast, deterministic multi-seed Monte Carlo trials against the exact production
`selectNextArenaMatch`, `computeDavidsonRatings`, and `computeGuaranteedRankBounds` implementations
so hyperparameter changes can be evaluated quantitatively in milliseconds before deploying.

### How to Run `simulate`

Compile TypeScript (`npm run compile` or `npm run build`), then invoke `npm run simulate`:

```sh
# 1. Run the default parameter sweep (exploit = 0.0, 0.45, 0.80 across 3 ladders x 10 agents, 150 matches, 3 seeds)
npm run simulate

# 2. Sweep a custom grid of exploit weights, aging rates, and max-wait cycles over 10 PRNG seeds
npm run simulate -- \
  --ladders 5 \
  --agents 12 \
  --matches 300 \
  --exploit 0.0,0.30,0.45,0.65 \
  --aging 0.25,0.50,1.0 \
  --max-wait 3,4,6 \
  --seeds 10

# 3. Evaluate matchmaking behavior starting from the actual ladders and ratings in a seeded or production SQLite snapshot
npm run simulate -- \
  --db db/data/arena.sqlite \
  --matches 200 \
  --exploit 0.0,0.45 \
  --seeds 5
```

### CLI Flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--ladders <n>` | `3` | Number of synthetic playable ladders to simulate (ignored when `--db` provides playable ladders). |
| `--agents <n>` | `10` | Active agents per synthetic ladder (index `0` anchored at `1500` Elo; remaining true ratings span `1200..1850` Elo). |
| `--matches <n>` | `150` | Total 2-game Arena matches scheduled across all ladders per trial. |
| `--exploit <list>` | `0.0,0.45,0.80` | Comma-separated `exploit` values ($\ge 0$); `0` is pure active-learning uncertainty reduction, higher values weight top-LCB contenders more heavily. |
| `--aging <list>` | `0.50` | Comma-separated `agingRate` values controlling how quickly a waiting ladder's priority multiplier grows per skipped match. |
| `--max-wait <list>` | `4` | Comma-separated `maxWaitCycles` values (a ladder waiting $\ge \text{maxWaitCycles} \times L$ matches is forced next). |
| `--seeds <n\|list>` | `3` | Number of deterministic Mulberry32 seeds (`1..N`) or an explicit comma-separated seed list (`1,7,42`) to average across. |
| `--db <path>` | unset | Load initial playable ladders and agent true Elo vectors from an existing SQLite database (`champion` and `challenger` entries). |

### Interpreting the Output Metrics

For each `(exploit, agingRate, maxWaitCycles)` point in the sweep grid, `npm run simulate` prints:

- **`info gain` (`nats/match`):** Mean prior-to-posterior information gain per scheduled match. Higher
  values indicate matches are consistently pairing uncertain, closely rated opponents.
- **`top-5 pair share` (`%`):** Percentage of all scheduled matches where both agents belong to the
  ladder's true top 5. Increases with `exploit`, measuring how much compute is concentrated on the
  title/podium race.
- **`rating accuracy` (`mean error`, `Kendall tau`, `Top-3`):**
  - `mean error`: Mean absolute error $|\hat{R}_i - R_i^{\text{true}}|$ in Elo across all agents at
    the end of the run.
  - `Kendall tau`: Rank-order correlation $\tau \in [-1, 1]$ between estimated and true Elo rankings.
  - `Top-3`: Fraction of true top-3 agents recovered by the conservative $\text{LCB}$ leaderboard top 3.
- **`balance` (`agent matches`, `ladder share`):** Min-to-max range of matches played per agent and
  fraction of total matches allocated to each ladder, verifying that no agent or ladder is starved.
- **`convergence` (`all <150 CI95`, `#1 [1,1]`):**
  - `all <150 CI95`: Median total matches (and percentage of seeds) required until every agent on
    every ladder has played at least 1 match and achieved $\text{CI}_{95} < 150\text{ Elo}$.
  - `#1 [1,1]`: Median total matches (and percentage of seeds) required until every ladder's top
    agent has guaranteed conservative rank bounds $[\text{rankMin}, \text{rankMax}] = [1, 1]$ via
    `computeGuaranteedRankBounds`.
