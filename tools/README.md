# Developer & Operator Tools (`tools/`)

Command-line utilities for administering the **pkmn.ai** Arena database, seeding deterministic or organic development environments, running declarative end-to-end lifecycle scenarios, and verifying responsive visual layouts.

| Tool | Script | Purpose |
|---|---|---|
| [`pkmn.ts`](pkmn.ts) | `npm run pkmn -- <cmd>` | Production & local operator CLI: inspect DB status, quarantine/unquarantine versions, refund cooldowns, reassign developers, set 1500-Elo anchors, rotate seasonal ladders, manage tournaments, lookup Smogon IDs, and mint test cookies. |
| [`mock.ts`](mock.ts) | `npm run mock -- ...` | Declarative `.mock` scenario engine, probabilistic Davidson match simulator, and organic site-activity generator (`simulate`). |
| [`shots.ts`](shots.ts) | `npm run shots` | Headless Chromium visual-regression & layout verifier across 4 viewports (`small`, `phone`, `tablet`, `desktop`) × 2 color schemes (`light`, `dark`). |
| [`scenarios/`](scenarios/) | — | Checked-in `.mock` scenario scripts ([`seed.mock`](scenarios/seed.mock) for local dev & `shots`, [`e2e.mock`](scenarios/e2e.mock) for HTTP + Playwright integration tests). |

---

## Invoking `mock`

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

### Global CLI Flags

| Flag | Description |
|---|---|
| `-f <path>`, `--file <path>` | Execute a `.mock` script file from top to bottom. |
| `--db <path>` | Override the SQLite database path (defaults to `db/data/arena.sqlite`, or `:memory:`). When omitted, `mock` manages overlay files inside `.mock/`. |
| `--public-dir <dir>` | Override output directory for static HTML/JSON renders (defaults to `public/`). |
| `--server <url>` | Run in **Live HTTP Server Mode** against a running `pkmn.ai` server instead of mutating submission/runner tables directly. |
| `--secret <token>` | Bearer `$ARENA_SECRET` for `/api/arena/*` requests when `--server` is set (falls back to `process.env.ARENA_SECRET`). |
| `--now <spec>` | Pin the initial simulated clock when running `mock seed` (Unix seconds, ISO-8601, or relative spec). |
| `-h`, `--help` | Print CLI usage summary. |

### Dual Transport Modes

Every `.mock` scenario can run unchanged in two modes:

1. **Direct DB/FS Mode** *(default when `--server` is omitted)*:
   Writes directly to SQLite (`db/data/arena.sqlite`), `.mock/static/projects.yml`, `.mock/ladders.yml`, and `.mock/wiki/`, and renders static views via `render`. Optimized for fast seeding (`npm run mock -- seed`) and screenshot fixtures (`npm run shots`).
2. **Live HTTP Server Mode** *(`--server http://localhost:1234`)*:
   Exercises the real HTTP endpoints on a running server:
   - Developer sessions are minted via `SESSION_SECRET` (if configured) or `GET /auth/dev?github=<login>` (`DEV_AUTH=1`).
   - `submit` posts JSON payloads (including encrypted `authToken` headers and 20-team VGC pools) to `POST /api/submissions`.
   - `smoke` and `quarantine` pull `GET /api/arena/pending-submissions` and report telemetry to `POST /api/arena/submission-status` (triggering real server re-renders and Discord DMs).
   - `play`, `settle`, `match`, and `live` emit `POST /api/arena/heartbeat` and `POST /api/arena/match-complete`.
   - `wiki --via http` submits form edits to `POST /wiki/:slug/edit`.

### Overlay Files & Persistent State (`.mock/`)

To avoid dirtying tracked `config/ladders.yml` or `static/projects.yml`, running `mock` without `--db` stores all mutable filesystem state under `.mock/` (read automatically when the server starts with `MOCK=1`):

- `.mock/state.json` — Persists the PRNG state (`rngState`), simulated clock (`now` and `anchorNow`), match & heartbeat sequence counters, per-version/per-agent expected ratings, H2H matchup biases, pending smoke-test metadata, active live telemetry, and tournament broadcast state across sequential CLI calls.
- `.mock/ladders.yml` — Active/upcoming/settling/archived ladder configuration overlay.
- `.mock/static/projects.yml` & `.mock/static/avatars/` — Registered project catalog and generated/copied 32×32 PNG avatars.
- `.mock/wiki/` — Git-backed Djot wiki repository with commit history and author timestamps.
- `.mock/vgc-teams.txt` — Ready-to-paste sheet of 20 legal Regulation M-C teams (`d_1NN >= 1.30`) for interactive `/account/` testing.

---

## `.mock` Language & Lexical Rules

- **Comments & Blank Lines**: Empty lines and lines whose first non-whitespace character is `#` are ignored. Inline `# comments` preceded by whitespace outside quotes are stripped to end-of-line.
- **Line Continuations**: A trailing backslash (`\`) joins the next line into the same command.
- **Quoting & Escapes**: Single quotes (`'...'`) are literal; double quotes (`"..."`) interpret `\n`, `\r`, `\t`, `\"`, and `\\`.
- **Flags**: Long (`--flag value`, `--flag=value`) and short (`-f value`) flags may appear in any order alongside positional arguments. Boolean flags without a value default to `true`. Repeatable flags (`--owner`, `--discord`, `--vs`) accumulate all occurrences.

### Common Argument Formats

- **`<agent>`**: Matches by URL slug (`0-error`), case-insensitive display name (`"0 ERROR"`), or Showdown ID (`0error`).
- **`<agent>[@<ver>]`**: Targets an explicit version (`0-error@1.2.0`) or, when `@<ver>` is omitted, resolves the agent's active entry on the target ladder (falling back to its most recent `passed` or submitted version).
- **`<ladders>`**: Accepts a ladder slot (`rby`, `adv`, `sv`, `rand`, `vgc`), an exact `ladder_id` (`gen9championsvgc2026regmc`), a comma-separated list (`rby,sv`), or `all` (every non-archived ladder).
- **Durations (`<dur>`)**: Compact human units—`s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks), e.g. `45m`, `12d`, `2w`.
- **Timestamps (`<ts>`)**:
  - `now`, `now-<dur>`, `now+<dur>` — relative to the scenario's initial anchor timestamp (`anchorNow`), so `time now-14d` followed by `time now-7d` always lands 14 days and 7 days before `anchorNow`.
  - `+<dur>` / `-<dur>` — relative step from the current simulated clock (`state.now`).
  - Unix epoch seconds (`1762776000`) or ISO-8601 (`2026-10-20T12:00:00Z`).
- **Byte Sizes (`<bytes>`)**: Accepts plain integers or `b`, `kb`, `mb`, `gb` suffixes (e.g. `184mb`, `512kb`).

---

## Probabilistic Expected Ratings

When an agent version is submitted (`submit 0-error 1.0.0 rby=1660 adv=1630`) or entered into a tournament (`tournament enter 1 mews-truck@1.0.0=1820`), those numbers define the version's **latent expected Elo** on each format—*not* a hardcoded leaderboard rating.

Whenever two versions $i$ and $j$ play a simulated game with expected ratings $E_i$, $E_j$, optional H2H bias $B_{ij}$, and per-game tie rate $\tau$, `mock` samples `'W'`, `'T'`, or `'L'` from the exact single-game Generalized Davidson likelihood with log-skill difference $\Delta = (E_i - E_j + B_{ij}) / (400 / \ln 10)$ and tie parameter $\nu = 2\tau / (1 - \tau)$:

$$P(\text{W}) = \frac{e^{\Delta/2}}{e^{\Delta/2} + e^{-\Delta/2} + \nu}, \qquad P(\text{T}) = \frac{\nu}{e^{\Delta/2} + e^{-\Delta/2} + \nu}, \qquad P(\text{L}) = \frac{e^{-\Delta/2}}{e^{\Delta/2} + e^{-\Delta/2} + \nu}$$

Each ladder match samples Game 1 and Game 2 independently (`WW`, `WT`, `TW`, `WL`, `LW`, `TT`, `TL`, `LT`, `LL`) and feeds the resulting counts into the production whole-history Generalized Davidson MAP solver (`server/ratings.ts`). Over small sample sizes, weaker agents can upset stronger agents and empirical ratings fluctuate naturally; as match counts grow—especially with a 1500-Elo `ladder anchor` whose expected rating is also `1500`—empirical MAP ratings converge toward the declared expected ratings.

---

## Declarative Command Reference

### 1. Environment, Clock, PRNG & Checkpoints

#### `reset`
Wipes SQLite Arena tables and `.mock/` overlays back to the base `config/ladders.yml` and `static/projects.yml`, resets `state.json`, and writes `.mock/vgc-teams.txt`.
```sh
reset [--seed <uint32>] [--now <ts>] [--open-ladders]
```
- `--seed <n>`: Seed the deterministic Mulberry32 PRNG (default: `20261110`).
- `--now <ts>`: Set both `now` and `anchorNow`.
- `--open-ladders`: Immediately transition all base ladders from `upcoming` to `active`.

#### `time`
Sets or advances the simulated clock (`state.now`).
```sh
time <+dur|-dur|now|now-dur|now+dur|iso|unix>
```

#### `rng`
Re-seeds the deterministic PRNG mid-scenario without resetting database state.
```sh
rng <uint32>
```

#### `checkpoint`
Invokes the programmatic `onCheckpoint(name, runner)` callback registered on `mock.Runner` (a no-op in CLI runs; used in `test/e2e.test.ts` to assert mid-scenario invariants).
```sh
checkpoint <name>
```

---

### 2. Projects, Developers & Discord

#### `register`
Adds or updates an Arena project in `projects.yml`, syncs `agents` and `developers` in SQLite, optionally generates a deterministic 32×32 avatar PNG, and links owner Discord accounts.
```sh
register <name> \
  [--owner <github[:smogon[.id]]> ...] \
  [--discord <id:username|username|none> ...] \
  [--logo <filename|auto>] \
  [--pending] [--disabled] [--banned] [--no-guild]
```
- `--owner`: Repeatable co-owner mapping. If `.id` is omitted on the Smogon handle, a unique numeric Smogon member ID is assigned automatically. If `--owner` is omitted altogether, defaults to `<slug>dev`.
- `--discord`: Repeatable per-owner Discord binding (`513513270670262284:scheibo`, `auto`, or `none`). Qualified projects auto-link Discord by default unless `--discord none` is passed; `--pending` projects leave Discord unlinked unless `--discord` is explicitly provided.
- `--logo auto`: Generates a deterministic geometric 32×32 PNG at `<avatarsDir>/<slug>.png`.
- `--pending`: Sets `qualified: false` (Stage 1 `Pending` persona).
- `--disabled`: Registers the agent row and then removes its `arena:` block so the agent becomes `disabled`.
- `--banned`: Runs `syncProjectsWithSmogon` with a mocked banned Smogon profile (`banned = 1`).
- `--no-guild`: Links Discord OAuth on the developer row without inserting them into `discord_members` (simulates a user who has not joined the Discord server).

#### `qualify` / `disable`
Promotes a `pending` project to `qualified: true`, or removes a project's `arena:` block to mark it `disabled`.
```sh
qualify <agent>
disable <agent>
```

#### `reassign`
Moves a developer's GitHub identity to another project (or removes them from all projects with `--none`), preserving comments in `projects.yml`.
```sh
reassign <github> <target-agent|--none> [--smogon <username.id>]
```

#### `refund-cooldown`
Clears the 14-day submission cooldown on `<agent>`.
```sh
refund-cooldown <agent>
```

#### `discord`
Links/unlinks a developer's Discord account or triggers the `onDiscordSync` role-sync hook.
```sh
discord link <github> [<id>:<username>] [--no-guild]
discord unlink <github>
discord sync
```

---

### 3. Ladders

#### `ladder open` / `ladder status`
Opens `upcoming` ladders to `active`, or sets an explicit lifecycle status (`upcoming`, `active`, `settling`, `archived`).
```sh
ladder open [<ladders|all>]
ladder status <ladders|all> <upcoming|active|settling|archived>
```

#### `ladder add`
Adds a new ladder to `ladders.yml` and syncs it into SQLite.
```sh
ladder add <id> --name <title> --format <ps-format> \
  [--team <harvested|pools|random>] [--min <n>] [--teams <n>] \
  [--status <upcoming|active|settling|archived>] [--discord <role-id>]
```

#### `ladder rotate`
Rotates an active seasonal ladder into `settling` under `--archive-name` and optionally opens its successor in the same URL slot.
```sh
ladder rotate <old-ladder> --archive-name <archived-title> \
  [--new <new-id>] [--new-name <title>] [--format <ps-format>] \
  [--team <harvested|pools|random>] [--min <n>] [--teams <n>] [--discord <role-id>]
```

#### `ladder anchor`
Designates `<agent>[@<ver>]` as the 1500-Elo gauge anchor on one or more ladders and immediately recomputes ratings.
```sh
ladder anchor <ladders|all> <agent>[@<ver>]
```

#### `ladder archive`
Writes a `.7z` battle-log archive to `public/arena/ladders/<ladder_id>/<ladder_id>-logs.7z` (copying `--file` if provided, or writing a valid 7z header stub).
```sh
ladder archive <ladder> [--file <path>]
```

---

### 4. Submissions, Smoke Testing & Quarantine

#### `submit`
Submits a new agent version to one or more ladders and/or scheduled tournaments, records its expected ratings and optional H2H matchup biases, generates or reads 20-team VGC pools when needed, and optionally runs smoke testing immediately.
```sh
submit <agent> [<version>] [<target>[=<rating>] ...] \
  [--rating <elo>] \
  [--tournament <id[,id...]>] \
  [--vs <opp[@ver]:delta[,...]>] \
  [--pkg <bundle|oci>] [--url <artifact-url>] [--sha256 <hex>] [--auth-token <header>] \
  [--by <github>] \
  [--teams <auto|new|none|path>] \
  [--smoke <pass|pending|fail>] [--error <msg>] [--notified] \
  [--bytes <size>] [--duration-millis <n>] [--turn-millis <n>] [--ram <mib>]
```
- `<version>`: Optional semver/label (`1.2.0`); auto-increments (`1.0.0` → `1.0.1` → `1.0.2`) if omitted.
- `<target>[=<rating>]`: Positional ladder specs (`rby=1660`, `sv`, `all=1550`) or tournament specs (`tournament:3=1560`). If no targets are listed, defaults to all currently `active` ladders.
- `--rating <elo>`: Default expected rating for any target without an inline `=<rating>` (fallback: `1500`).
- `--vs <opp:delta>`: Repeatable pairwise Elo bias from this version's perspective (e.g. `--vs jaxcalibur:+180,xatu-zero:-190`), creating rock-paper-scissors non-transitivity in H2H matrices.
- `--teams`: On `pools` ladders (VGC), `auto` generates 20 legal teams the first time an agent enters the ladder and reuses its locked pool on upgrades; `new` forces a fresh 20-team pool; `<path>` loads teams from disk; `none` omits teams.
- `--smoke`: Defaults to `pass` (immediately promoting the version onto its target ladders and auto-retiring the lower-LCB version when 2 active versions already exist). Use `--smoke pending` to leave it in `/api/arena/pending-submissions` or `--smoke fail` to record a failed smoke test.

#### `smoke`
Processes pending submissions in the Arena pull queue (`all` or a specific `<agent>[@<ver>]`).
```sh
smoke [<agent>[@<ver>]|all] [--pass|--fail] [--error <msg>] [--notified] \
  [--bytes <size>] [--duration-millis <n>] [--turn-millis <n>] [--ram <mib>]
```

#### `quarantine` / `unquarantine`
Quarantines a misbehaving version (via `/api/arena/submission-status` when `--server` is set or `--via admin` directly) or restores it.
```sh
quarantine <agent>[@<ver>] [--reason <msg>] [--via <runner|admin>]
unquarantine <agent>[@<ver>]
```

---

### 5. Matchmaking, Settlement & Direct Matches

#### `play`
Schedules and simulates `<count>` 2-game Arena matches using either the production active-learning scheduler (`ratings.selectNextArenaMatch`) or balanced round-robin pair selection, including VGC blind-pool sampling (`teams.samplePoolsPair`, enforcing `min >= 4`, uniform `2/N` per-agent sampling, disjoint owners, and `<= 1` team from the 2 competing agents' 40 teams).
```sh
play [<count>] [--ladder <ladders>] [--over <dur>] \
  [--exploit <0..1>] [--balanced] \
  [--tie-rate <0..0.8>] [--fault-rate <0..1>] [--heartbeats]
```
- `<count>`: Number of 2-game matches to simulate (default: `1`).
- `--over <dur>`: Spreads match completion timestamps evenly across `<dur>` (producing multi-day `rating_snapshots` history for Elo charts).
- `--exploit <0..1>`: Controls top-of-ladder exploitation vs. exploration in `selectNextArenaMatch` (default: `0.45`).
- `--balanced`: Selects under-sampled version pairs evenly across the field for rapid initial calibration.
- `--fault-rate <p>`: Probability that a decisive game ends via `timeout` or `crash` instead of normal `win`.
- `--heartbeats`: Emits live Game 1 and Game 2 `/api/arena/heartbeat` updates before `/api/arena/match-complete` in `--server` mode.

#### `settle`
Repeatedly schedules targeted matches for unsettled active entries (`matches < 25` or `SE > 30.0`) until every active version on `<ladders>` settles (automatically transitioning `settling` ladders to `archived` once their final challenger settles).
```sh
settle [<ladders|all>] [--over <dur>] [--max <steps>] [--tie-rate <p>] [--heartbeats]
```

#### `match`
Plays `<count>` explicit 2-game matches between `<p1>` and `<p2>` on `<ladder>`, either sampled probabilistically from their expected ratings or forced to a specific category.
```sh
match <ladder> <p1>[@<ver>] <p2>[@<ver>] [--count <n>] [--over <dur>] \
  [--outcome <WW|WT|TW|WL|LW|TT|TL|LT|LL|auto>] \
  [--reason <str>] [--g1-reason <str>] [--g2-reason <str>] \
  [--p1-team <hash:agent|P1:agent|P2:agent|raw>] \
  [--p2-team <hash:agent|P1:agent|P2:agent|raw>] \
  [--tie-rate <p>] [--heartbeats]
```

---

### 6. Live Battle Telemetry

Controls `/api/live.json` spectator state (and posts to `/api/arena/heartbeat` in `--server` mode).

```sh
live match <ladder> <p1>[@<ver>] <p2>[@<ver>] \
  [--id <match-id>] [--game <1|2>] [--turn <n>] [--active <p1|p2>] \
  [--g1-winner <p1|p2|tie>] [--g1-turns <n>] \
  [--p1-bank <sec>] [--p2-bank <sec>] [--budget <sec>] \
  [--p1-team <spec>] [--p2-team <spec>]

live idle
live stale
```

---

### 7. Championship Tournaments

Manages cloud-GPU round-robin events, Sonneborn-Berger standings, single-game MAP tournament Elo, Superfinal tiebreakers, public `.log` replays, live Showdown room broadcasts, and `.7z` replay bundles.

```sh
# Create or update a tournament
tournament create <id> --name <title> --format <ps-format> \
  [--games <even-int>] [--batch <n>] [--tables <n>] \
  [--hardware <desc>] [--rules <json-array>] \
  [--starts <ts>] [--status <scheduled|running|completed>]

# Enroll qualified versions (with optional expected tournament Elo)
tournament enter <id> <agent>[@<ver>][=<rating>] ... [--pkg <oci|bundle>] [--by <github>]

# Lock entrants from current database submissions & start
tournament seed <id>
tournament start <id>

# Simulate Berger round-robin cycles/games and optional Superfinal tiebreaker
tournament play <id> [--cycles <n> | --games <n> | --all] \
  [--superfinal [<games>]] [--over <dur>] [--id-prefix <slug>] [--tie-rate <p>]

# Set or clear the live multi-table broadcast widget & #topbar [LIVE] banner
tournament broadcast <id> [<mainP1> <mainP2> [<sideP1> <sideP2>]] [--cycle <n>] [--game <n>]
tournament broadcast off

# Finalize standings (promoting Superfinal winner to #1) and optionally write <id>-replays.7z
tournament complete <id> [--archive]
```

---

### 8. Wiki & Static Rendering

#### `wiki`
Commits a Djot page revision into `.mock/wiki/` with backdated `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` matching `state.now` (or posts via `POST /wiki/:slug/edit` when `--via http` and `--server` are set).
```sh
wiki <slug> (--content <djot> | --file <path>) \
  [--by <github>] [--message <commit-msg>] \
  [--visibility <public|discord|developers|admin>] \
  [--via <git|http>]
```

#### `render`
Re-renders all static Arena HTML & JSON views (`/arena/`, `/arena/ladders/*`, `/arena/tournaments/*`, `/arena/battles/`, `/projects/*`, `#topbar` live banners, and `/api/live.json`) at `state.now`.
```sh
render
```

---

### 9. Organic Live Activity (`simulate`)

Generates realistic ongoing Arena activity by formatting and executing ordinary `.mock` commands (`smoke`, `register`, `submit`, `live match`, `match`, `play`, `tournament play`, `render`) through the same `mock.Runner` pipeline:

```sh
# Bounded deterministic burst (e.g. inside a script or test)
simulate <steps> [--over <dur>]

# Unbounded real-time daemon loop with random ±40% interval jitter (Ctrl-C to stop)
simulate [--interval <millis>]
```
- **Pending submissions first**: Whenever you submit an agent interactively on `/account/`, the next `simulate` tick immediately runs `smoke all --pass` so your submission transitions from `Pending` to `Challenger` within seconds.
- **Multi-stage live battles**: In unbounded mode, `simulate` progresses live matches across multiple turns (`Game 1 Turn 4` → `Game 1 Turn 14` → `Game 2 Turn 8` → `match` completion → `live idle`) so clicking around `/arena/` shows ticking chess clocks, shifting active slots, and fresh battle rows.
- **Organic churn**: Periodically registers new community projects with generated avatars, submits version upgrades for eligible settled competitors, and advances any `running` tournament.
