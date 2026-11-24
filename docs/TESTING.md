# Testing

Automated test suites, visual-regression verification (`npm run shots`), manual persona testing,
the `.mock` scenario engine, and the matchmaking simulator. See [DEVELOPMENT.md](DEVELOPMENT.md) for
setup and [ADMIN.md](ADMIN.md) for operator commands.

## 1. Automated Build, Lint & Test Suite

```sh
npm test            # tsc -p ., static build, eslint, stylelint, hyperlink --check-anchors, vitest
npm run lint        # eslint, stylelint, hyperlink --check-anchors (requires built public/)
npx vitest run      # run Vitest suites directly (pass a file path to scope)
```

Install headless Chromium once if missing: `npx playwright-core install chromium`.

| Suite | Coverage |
| :--- | :--- |
| `npm run build && npm run lint` | `tsc -p .` -> `build/`; `build/static/build` -> `public/`; `eslint --cache`; `stylelint --cache static/style/*.css tools/*.css`; `hyperlink public --check-anchors`. |
| `test/ratings.test.ts` | Finite-difference gradients/Hessians, KKT optimality, permutation invariance, disconnected graphs, Monte Carlo convergence, active matchmaking (`server/ratings.ts`). |
| `test/protocol.test.ts` | Stdio parsing & chat/covert-channel elision across `@pkmn/sim` (`server/protocol.ts`). |
| `test/db.test.ts` | Schema bootstrap, `db/migration/NNNN-*.sql`, project/Smogon sync, ladder lifecycle/rotation, match aggregation (`db/`). |
| `test/{auth,account,admin,wiki,discord,api,render,projects,system}.test.ts` | OAuth cookies, submission gating & 1-NN uniqueness, `/admin` dashboard & telemetry, Git wiki revisions/visibility, Discord sync & `/watch`, `/api/arena/*`, dynamic SSR HTML/`.json`, VPS/Arena telemetry parsers. |
| `test/{arena-*,sim,setup}.test.ts` | Mac mini & GCP unpacking/sandbox/time-slicing/tournaments/coordinator, multi-version `@pkmn/sim` worker isolation, repo setup/submodules. |
| `test/e2e.test.ts` | Runs [`tools/scenarios/e2e.mock`](../tools/scenarios/e2e.mock) in Live HTTP Server Mode + Playwright live SSE flows (plus 900-match Elo convergence under `CI` / `RUN_SLOW_TESTS=1`). |

**Test a candidate team against 1-NN blocklists ($d_{\text{1-NN}} \ge 1.30$):**

```sh
node build/teams/index.js <candidate-team.txt> \
  teams/teams/gen9championsvgc2026regmc \
  teams/pkmn_stuff/teams/Teams_real \
  teams/vgc.bot/gen9championsvgc2026regmc \
  --format=gen9championsvgc2026regmc
```

## 2. Visual Regression & Visual Atlas (`npm run shots`)

Run [`tools/shots.tsx`](../tools/shots.tsx) whenever editing TSX views, CSS, Djot layouts, or client
scripts:

```sh
npm run shots -- --list                          # list all 7 sections and 106 scenario names
npm run shots -- --baseline --only ladders,battles  # snapshot only affected states before edits
npm run build && npm run shots -- --only ladders,battles # capture & diff targeted states (4 viewports x 2 themes)
npm run shots -- --baseline && npm run shots     # full 106-state capture (for shared layout/global CSS)
open .shots/index.html                           # inspect Visual Atlas
npm run clean && npm test                        # remove mock artifacts from public/ afterward
```

`shots` seeds an in-memory fixture from [`tools/scenarios/seed.mock`](../tools/scenarios/seed.mock),
uses SQLite savepoints + parallel Playwright Chromium workers across **4 viewports** (`small`
`375×667`, `phone` `390×844`, `tablet` `744×1133`, `desktop` `1280×900`) × **2 themes** (`light`,
`dark`), and asserts **zero console/page errors** and **zero horizontal overflow**
(`scrollWidth <= innerWidth`). Pass `--only <q[,q...]>` (repeatable or comma-separated section/name
substrings) to capture only affected states, and `--tolerance <px>` to relax pixel diffs.

- **Atlas controls (`.shots/index.html`):** Hotkeys `←`/`→` (states), `↑`/`↓` (sections), `1`–`4`
  (viewports), `t` (theme), `g` (Carousel/Grid), `c` (`Changed Only`), `d` (`After`/`3-Up Diff`/
  `Diff`/`Before`).
- **Viewer diff tolerance:** `regions.json` records `iframe.viewer-frame` bounding boxes. Pixel diff
  is strict `0`-pixel outside viewers (unless `--tolerance` is passed) and tolerates up to `25%`
  sprite/animation variance inside unchanged viewer frames.

**7 Atlas Sections (106 states):**
1. **`static`:** Home (normal, signed-out default profile icon, manual Light/Dark theme overrides,
   and `● LIVE` `#topbar`), Background (`Under Construction`), Concepts + 5 subpages (`baselines`,
   `complexity`, `engines`, `protocol`, `variants`), Glossary, Release, Research, Arena Rules,
   `404`.
2. **`projects`:** Filters (`Active`/`All`/`Inactive`), champion profile (`/projects/0-error/`,
   version & H2H filters, expanded telemetry, empty filter), provisional w/ company
   (`/projects/pokerus/`), qualified w/ 0 entries (`/projects/cynthiai/`), pending
   (`/projects/asterai/`).
3. **`ladders`:** Active hub, expandable past seasons, pre-launch hub, RBY (`Active`/`Best`/`All`,
   secondary `1500 ±0` anchor), VGC `pools`, RAND (`<id>-logs.tar`), `settling` season
   (`#season-select`), `archived` season (`<id>-logs.tar`), `upcoming` ladder.
4. **`battles`:** Live VGC (`Initializing (/ready)`, `Team Preview` 6 HP circles, mid-battle 4
   brought, `Game 2 / 2` w/ Game 1 summary + swapped hashes), live Singles `Game 2 / 2` w/ Game 1
   `[Timeout]`, live `RAND` + Showdown viewer, expanded `RAND` & archived `VGC` replay rows
   (`Game 1`/`2`), expanded `[Timeout]`/`[Crash]`/clean rows, format filter, Page 2, `Idle`, `Stale`,
   empty history.
5. **`tournaments`:** Completed `#1` (`SF` badges, `1-replays.7z`, expanded game replay), live Bo3
   `#2` multi-table (`Table 1` dual-thinking, `Table 2` P1 committed / P2 thinking, idle `● Watch T1`,
   expanded Bo3 `Game 1`/`2`/`3` switcher, offline log fallback), scheduled `#3` (with & without
   entrants).
6. **`account`:** Disabled (`403`), `Pending` (locked & Tournament `#3` open), `Qualified`
   pre-launch, `Eligible` new (`0` entries), `Eligible` partial (`RBY`/`ADV` enabled,
   `SV`/`RAND`/`VGC` disabled), VGC incremental validation (`0/20`, `<1.30`/`<4` moves
   rejections, `10/20`, `20/20`), form error, `Eligible` settled w/ locked VGC pool, `Ineligible`
   (`PENDING` smoke test, `Diagnostic Live` running self-play viewer + `/info`, `Staged Diagnostic`
   awaiting Activate/Discard w/ arrow-expanded replay + `/info` panel + `STDERR`/`log` links, 24h
   failed/discarded smoke-test limit reusing version labels, 14d cooldown w/ Tournament `#3` open,
   unsettled provisional w/ `○` non-`/info` dot, `QUARANTINED (DM sent)`, Smogon-banned
   `smogon_standing = 'bad'`), and `/admin/` dashboard (`403` non-admin, overview, expanded project
   detail panel, and staged diagnostic replay + discard view).
7. **`wiki`:** Index, `/wiki/pages`, `/wiki/projects`, `developers`/`discord` project pages, public & project editors
   (visibility bar, live Djot preview), revision history/snapshot/diff, owner redirect & non-owner
   `404` on uncreated page, `403`s (unregistered, non-owner edit, non-guild Discord), `/auth/dev`.

## 3. Manual Testing & Auth Personas (`GET /auth/dev`)

Seed and run locally (`npm run clean && npm run build` to wipe; see [DEVELOPMENT.md](DEVELOPMENT.md)):

```sh
npm run build && npm run mock -- seed
DEV_AUTH=1 MOCK=1 npm start
# Optional background activity in a 2nd terminal:
MOCK=1 npm run mock -- simulate --server http://localhost:1234 --secret "${ARENA_SECRET:-dev-secret}"
```

Verify `#topbar` shows `● LIVE Tournament #2` on `/` and `/arena/` (while `/background/` keeps
`Under Construction`). With `DEV_AUTH=1` on loopback, `http://localhost:1234/auth/dev` opens a
persona picker minting real HMAC-signed `pkmn_session` cookies:

| Persona / Stage | URL (`http://localhost:1234/auth/dev?...`) | Key Checks |
| :--- | :--- | :--- |
| Unauthenticated | `?clear=1&return_to=/arena` | Public views; `/account` & dev wiki redirect to login. |
| Unregistered | `?github=stranger&return_to=/account` | Redirects `/account` to registration issue; `403` on dev wiki. |
| 1. `Pending` (`AsterAI`) | `?github=asterdev&return_to=/account` | "Link Discord" CTA, ladders disabled, can view `/wiki/projects/0_ERROR` & edit `/wiki/projects/AsterAI`. |
| 2. `Qualified` pre-launch | Plain `DEV_AUTH=1 npm start` (or `set-ladder-status ... upcoming`) | Pre-launch `Qualified` state before ladders open. |
| 3. `Eligible` new (`CynthiAI`) | `?github=sisyphus25&return_to=/account` | Empty tables; check `VGC` & paste `pbcopy < .mock/vgc-teams.txt` to submit `1.0.0`. |
| 4. `Eligible` settled (`Foul Play`) | `?github=pmariglia&return_to=/account` | Submit `1.5.0` -> `PENDING`, then `MOCK=1 npm run mock -- smoke all && ... play 1 && ... render`. |
| 5. `Ineligible` cooldown + Wiki Admin (`0 ERROR`) | `?github=scheibo&discord=513513270670262284&return_to=/account` | `1.2.0`/`1.1.0` active, `0.9.0-rc1` failed stderr, 14d cooldown (waive via `refund-cooldown 0-error`), Tournament `#3` open. |
| 6. `Ineligible` provisional (`pokerus`) | `?github=pokerusdev&return_to=/account` | Past 14d cooldown, blocked until `1.0.2` settles (`>= 25` matches). |

**CLI cookies, control-plane `curl`, and real OAuth:**

```sh
COOKIE=$(SESSION_SECRET=test-secret npm run --silent pkmn -- session --github pmariglia --discord 283674461268344832:pmariglia)
curl -fsS -H "Cookie: $COOKIE" http://localhost:1234/account.json
curl -fsS -H "Authorization: Bearer $ARENA_SECRET" http://localhost:1234/api/arena/pending-submissions

# Live OAuth (set dev app callback to http://localhost:1234/auth/{github,discord}/callback):
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... npm start
```

## 4. Tools (`tools/`) & `.mock` Engine

| Tool | Script | Purpose |
| :--- | :--- | :--- |
| [`pkmn.ts`](../tools/pkmn.ts) | `npm run pkmn -- <cmd>` | Operator CLI ([ADMIN.md](ADMIN.md)). |
| [`mock.ts`](../tools/mock.ts) | `npm run mock -- ...` | `.mock` scenario runner, Davidson simulator, background activity daemon. |
| [`simulate.ts`](../tools/simulate.ts) | `npm run simulate -- ...` | Monte Carlo sweep for `selectNextArenaMatch` / `computeDavidsonRatings`. |
| [`shots.tsx`](../tools/shots.tsx) | `npm run shots` | Headless Chromium visual-regression & layout verifier. |
| [`scenarios/`](../tools/scenarios/) | — | [`seed.mock`](../tools/scenarios/seed.mock) (dev/`shots`) & [`e2e.mock`](../tools/scenarios/e2e.mock) (HTTP + Playwright). |

### Invoking `mock`

```sh
npm run mock -- seed                                     # run tools/scenarios/seed.mock
MOCK=1 npm run mock -- -f tools/scenarios/seed.mock      # run a .mock file
printf 'play 5 --ladder rby\nrender\n' | MOCK=1 npm run mock   # stdin
MOCK=1 npm run mock -- register "BoltBeam" --logo auto   # single command (persists .mock/state.json)
MOCK=1 npm run mock -- simulate --server http://localhost:1234 --secret "$ARENA_SECRET"
```

| Flag | Description |
| :--- | :--- |
| `-f, --file <path>` | Execute a `.mock` script file. |
| `--db <path>` | Override SQLite path (default `db/data/arena.sqlite`; `:memory:` skips `.mock/`). |
| `--public-dir <dir>` | Override static render directory (default `public/`). |
| `--server <url>` | **Live HTTP Server Mode** (exercises `/auth/dev`, `POST /api/submissions`, `/api/arena/*`, `POST /wiki/:slug/edit`) instead of direct SQLite/FS mutations. |
| `--secret <token>` | Bearer `$ARENA_SECRET` for `--server` (falls back to `ARENA_SECRET`). |
| `--now <spec>` | Pin initial `anchorNow` (Unix seconds, ISO-8601, or relative spec). |
| `-h, --help` | Print CLI usage. |

Without `--db`, `mock` writes overlays under `.mock/` (`state.json`, `ladders.yml`,
`static/projects.yml`, `static/avatars/`, `wiki/`, `vgc-teams.txt`), read when `MOCK=1`.

## 5. `.mock` Language & Command Reference

- **Syntax:** `#` comments (full-line or whitespace-prefixed inline), `\` line continuations,
  `'literal'` / `"escaped"` quotes, flags (`--flag val`, `--flag=val`, `-f val`, repeatable
  `--owner`/`--discord`/`--vs`, bare booleans default `true`).
- **Targets & units:** `<agent>` (slug, display name, or Showdown ID); `<agent>[@<ver>]` (omitted
  `@<ver>` picks active entry, else latest passed/submitted); `<ladders>` (slot, exact `ladder_id`,
  comma list, or `all`); `<dur>` (`s`/`m`/`h`/`d`/`w`); `<ts>` (`now[±dur]`, `±dur` from `state.now`,
  Unix epoch, ISO-8601); `<bytes>` (`b`/`kb`/`mb`/`gb`).
- **Expected ratings:** `rby=1660` sets *latent* Elo $E_i$ (not hardcoded). Each game samples
  `W`/`T`/`L` from single-game Davidson with $\Delta = (E_i - E_j + B_{ij}) / (400 / \ln 10)$ and
  $\nu = 2\tau / (1 - \tau)$:
  $$P(\text{W}) = \frac{e^{\Delta/2}}{e^{\Delta/2} + e^{-\Delta/2} + \nu}, \qquad P(\text{T}) = \frac{\nu}{e^{\Delta/2} + e^{-\Delta/2} + \nu}, \qquad P(\text{L}) = \frac{e^{-\Delta/2}}{e^{\Delta/2} + e^{-\Delta/2} + \nu}$$
  Two independent games feed into `server/ratings.ts`.

### Commands

```sh
# Environment, Clock, PRNG & Checkpoints
reset [--seed <uint32>] [--now <ts>] [--open-ladders]
time <+dur|-dur|now|now-dur|now+dur|iso|unix>
rng <uint32>
checkpoint <name>                                          # programmatic callback in test/e2e.test.ts

# Projects, Developers & Discord
register <name> [--owner <github[:smogon[.id]]> ...] [--discord <id:user|user|none> ...] \
  [--company <name>] [--company-url <url>] [--logo <file|auto>] [--ladders <slots>] \
  [--pending] [--disabled] [--banned] [--no-guild]
qualify <agent> [<slots|all|none>...] | disable <agent> | refund-cooldown <agent>
reassign <github> <target-agent|--none> [--smogon <username.id>]
discord link <github> [<id>:<user>] [--no-guild] | discord unlink <github> | discord sync

# Ladders
ladder open [<ladders|all>]
ladder status <ladders|all> <upcoming|active|settling|archived>
ladder add <id> --name <title> --format <ps-fmt> [--team <harvested|pools|random>] [--teams <n>] [--status <s>] [--discord <role>]
ladder rotate <old> --archive-name <title> [--new <id>] [--new-name <title>] [--format <fmt>] [--team <mode>] [--teams <n>] [--discord <role>]
ladder anchor <ladders|all> <agent>[@<ver>]
ladder archive <ladder> [--file <path>]

# Submissions, Smoke Testing & Quarantine
submit <agent> [<ver>] [<target>[=<elo>] ...] [--rating <elo>] [--tournament <id[,...]>] \
  [--vs <opp[@ver]:delta[,...]>] [--pkg <bundle|oci>] [--url <url>] [--sha256 <hex>] [--auth-token <hdr>] \
  [--by <github>] [--teams <auto|new|none|path>] [--smoke <pass|staged|pending|fail>] [--error <msg>] [--notified] \
  [--bytes <size>] [--duration-millis <n>] [--turn-millis <n>] [--ram <mib>]
smoke [<agent>[@<ver>]|all] [--pass|--staged|--fail] [--error <msg>] [--notified] [--bytes <sz>] [--duration-millis <n>] [--turn-millis <n>] [--ram <mib>]
quarantine <agent>[@<ver>] [--reason <msg>] [--via <runner|admin>] | unquarantine <agent>[@<ver>]

# Matchmaking, Settlement, Direct Matches & Live Telemetry
play [<count>] [--ladder <ladders>] [--over <dur>] [--exploit <0..1>] [--balanced] [--tie-rate <0..0.8>] [--fault-rate <0..1>] [--heartbeats]
settle [<ladders|all>] [--over <dur>] [--max <steps>] [--tie-rate <p>] [--heartbeats]
match <ladder> <p1>[@<ver>] <p2>[@<ver>] [--count <n>] [--over <dur>] [--outcome <WW|WT|TW|WL|LW|TT|TL|LT|LL|auto>] \
  [--reason <s>] [--g1-reason <s>] [--g2-reason <s>] [--p1-team <spec>] [--p2-team <spec>] [--tie-rate <p>] [--heartbeats]
live match <ladder> <p1>[@<ver>] <p2>[@<ver>] [--id <id>] [--game <1|2>] [--turn <n>] [--active <p1|p2>] \
  [--g1-winner <p1|p2|tie>] [--g1-turns <n>] [--p1-bank <s>] [--p2-bank <s>] [--budget <s>] [--p1-team <spec>] [--p2-team <spec>]
live idle | live stale

# Tournaments
tournament create <id> --name <title> --format <fmt> [--games <even>] [--batch <n>] [--tables <n>] [--hardware <desc>] [--rules <json>] [--starts <ts>] [--status <s>]
tournament enter <id> <agent>[@<ver>][=<elo>] ... [--pkg <oci|bundle>] [--by <github>]
tournament seed <id> | tournament start <id> | tournament complete <id> [--archive]
tournament play <id> [--cycles <n> | --games <n> | --all] [--superfinal [<games>]] [--over <dur>] [--id-prefix <slug>] [--tie-rate <p>]
tournament broadcast <id> [<mainP1> <mainP2> [<sideP1> <sideP2>]] [--cycle <n>] [--game <n>] | tournament broadcast off

# Wiki, Rendering & Organic Simulation
wiki <slug> (--content <djot> | --file <path>) [--by <github>] [--message <msg>] [--visibility <public|discord|developers|admin>] [--via <git|http>]
render
simulate <steps> [--over <dur>]    # bounded burst
simulate [--interval <millis>]     # real-time daemon (+/-40% jitter)
```

## 6. Matchmaking Parameter-Sweep Simulator (`npm run simulate`)

[`tools/simulate.ts`](../tools/simulate.ts) runs multi-seed Monte Carlo trials against production
`selectNextArenaMatch`, `computeDavidsonRatings`, and `computeGuaranteedRankBounds`
([`server/ratings.ts`](../server/ratings.ts)) to tune the tradeoff between **exploration**
(Fisher IG $\frac{1}{2}\ln(1 + 4\hat{p}(1-\hat{p})(\sigma_i^2 + \sigma_j^2))$), **exploitation**
(top-LCB podium separation via `exploit`), and **anti-starvation** (`agingRate`, `maxWaitCycles`,
and pairwise repeat penalty $1/(1 + 0.25\,m_{ij})$):

```sh
npm run simulate
npm run simulate -- --ladders 5 --agents 12 --matches 300 --exploit 0.0,0.30,0.45,0.65 --aging 0.25,0.50,1.0 --max-wait 3,4,6 --seeds 10
npm run simulate -- --db db/data/arena.sqlite --matches 200 --exploit 0.0,0.45 --seeds 5
```

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--ladders <n>` | `3` | Synthetic playable ladders (ignored if `--db` is set). |
| `--agents <n>` | `10` | Active agents/ladder (index `0` anchored at `1500`; others `1200..1850`). |
| `--matches <n>` | `150` | Total 2-game matches per trial. |
| `--exploit <list>` | `0.0,0.45,0.80` | Comma-separated exploitation weights (`0` = pure uncertainty reduction). |
| `--aging <list>` | `0.50` | Per-skipped-match priority growth for waiting ladders. |
| `--max-wait <list>` | `4` | Force a ladder after `maxWaitCycles * L` skipped matches. |
| `--seeds <n\|list>` | `3` | Count (`1..N`) or explicit Mulberry32 seed list. |
| `--db <path>` | unset | Initialize ladders and true Elo vectors from an existing SQLite DB. |

**Output metrics:**
- `info gain` (`nats/match`): Mean prior-to-posterior information gain per match.
- `top-5 pair share` (`%`): Share of matches pairing two true top-5 agents.
- `rating accuracy`: Mean absolute Elo error $|\hat{R}_i - R_i^{\text{true}}|$, Kendall $\tau$, and
  LCB top-3 recovery rate.
- `balance`: Min–max matches/agent and per-ladder match share.
- `convergence`: Median matches (and `%` of seeds) until all agents have $\ge 1$ match with
  $\text{CI}_{95} < 150$ Elo (`all <150 CI95`), and until every ladder's `#1` has guaranteed bounds
  `[1, 1]` (`#1 [1,1]`).
