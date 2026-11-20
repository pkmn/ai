# Administration

This runbook covers all **application-level** operator workflows for **pkmn.ai**: deploying updates,
onboarding and managing projects, moderating submissions, provisioning `harvested` ladder team
pools on the Mac mini Arena runner, managing ladder lifecycles and seasonal rotations, syncing
Discord roles, and running cloud-GPU Tournaments.

For OS-level provisioning and system daemon maintenance (`systemd`, `journalctl`, `nginx`,
`certbot`, Ubuntu/Node upgrades, and SQLite backups), see [SETUP.md](SETUP.md).

---

## 1. Deployments & Operator CLI (`pkmn`)

### Deploying Changes to `pkmn.ai`

From your local machine:

```sh
# Sync .env + private/, pull main on pkmn.ai, rebuild static pages, and restart pkmn.ai-server
npm run deploy

# Same flow, but only restart pkmn.ai-server if server/db/config/template files changed
npm run deploy:reload

# Pull main on the Mac mini Arena runner, compile, verify build/arena, and drain via SIGUSR1
npm run deploy:arena
```

Both scripts run `./private/sync` (if present; see `private/SETUP.md`) before SSHing to
`pkmn@pkmn.ai` and running `./deploy`. On the server, `./deploy` pulls `origin/main`, updates the
sparse-checked-out `teams/teams` and `teams/pkmn_stuff` submodules, runs `npm install --omit=dev`
when `package.json` changed, reloads `systemd` or `nginx` if `config/` changed, rebuilds `public/`
via `npm run build`, and restarts `pkmn.ai-server` when needed.

### Running the `pkmn` Operator CLI

Compile TypeScript (`npm run build` or `npm run compile`, already done on production by `./deploy`),
then invoke `npm run pkmn -- <command>`:

```sh
# Run on production from your laptop
ssh pkmn@pkmn.ai 'cd /home/pkmn/ai && npm run pkmn -- <command> [args...]'

# Or directly on pkmn.ai as the pkmn user
cd /home/pkmn/ai
npm run pkmn -- <command> [args...]
```

- **Database resolution:** `pkmn` automatically opens `/var/lib/pkmn/arena.sqlite` whenever
  `/var/lib/pkmn` exists or `NODE_ENV=production`, and `db/data/arena.sqlite` locally (pass `MOCK=1`
  locally to read `.mock/` overlays).
- **Live concurrency & SSR cache invalidation:** SQLite runs in WAL mode with `busy_timeout = 5000`
  ms, so `pkmn` commands can run safely alongside the live `pkmn.ai-server` process; `pkmn.ai-server`
  renders Arena and project profile HTML/JSON dynamically and invalidates its ETag cache
  automatically when the SQLite WAL advances (while tournament status changes also sync the static
  `#topbar` live banner in `public/`).

| Command | Purpose |
| :--- | :--- |
| `lookup-smogon <username\|slug.id\|id\|url>` | Resolve a Smogon forum user's immutable numeric XenForo ID and ban status. |
| `sync-projects [--projects <path>] [--offline]` | Sync `arena:` blocks from `static/projects.yml` into SQLite (`agents` & `developers`). |
| `reassign-developer <github> <slug\|--none> [...]` | Move a developer's GitHub login to another project (or remove with `--none`) in `projects.yml` + SQLite. |
| `quarantine <agent-slug> <version> [--reason "..."]` | Quarantine a misbehaving agent version across ladders and recompute ratings. |
| `unquarantine <agent-slug> <version>` | Restore a quarantined version to active competition and recompute ratings. |
| `refund-cooldown <agent-slug>` | Clear the 14-day submission cooldown on `<agent-slug>`. |
| `set-anchor <ladder_id> <agent-slug> <version>` | Pin `<agent-slug>@<version>` to `1500` Elo on `<ladder_id>` and recompute ratings. |
| `set-ladder-status <ladder_id> <status>` | Set `<ladder_id>` to `upcoming`, `active`, `settling`, or `archived`. |
| `upload-ladder-teams <ladder_id> <teams-file>` | Validate and upload canonical `harvested` teams into SQLite (`ladder_teams`). |
| `rotate-ladder <old_id> --name "..." [--new <id> ...]` | Transition `<old_id>` into `settling`/`archived` under its historical name and optionally open `<new_id>`. |
| `install-sim <version> [--sim <spec> ...]` | Install an isolated `@pkmn/sim` version under `sim/<version>/` and verify its worker boots cleanly. |
| `publish-ladder-archive <ladder_id> <file>` | Publish `<ladder_id>-logs.tar` (for `random` ladders or `archived` `pools` ladders). |
| `create-tournament <id> --name "..." --format <fmt> --version <ver> ...` | Create or update a Tournament (`scheduled`, `running`, or `completed`). |
| `seed-tournament <id>` | Lock tournament entrants and assign 1-based Berger seeds by conservative ladder rating. |
| `set-tournament-status <id> <status>` | Flip tournament `<id>` to `scheduled`, `running` (enables `#topbar` `● LIVE` banner), or `completed`. |
| `publish-tournament-archive <id> <archive.7z>` | Publish `<id>-replays.7z` for a `completed` tournament. |
| `session [--github <login>] [--discord <id>:<name>]` | Mint a signed `pkmn_session` cookie header using `SESSION_SECRET` (for `curl` / debugging). |

---

## 2. Project Onboarding, Qualification & Ownership (`static/projects.yml`)

### Step 1: Resolve Smogon Forum Member IDs

Every Arena developer must hold a Smogon forum account in good standing and belong to at most one
Arena project. Before editing `static/projects.yml`, resolve each owner's immutable numeric XenForo
ID (`username.id`):

```sh
npm run pkmn -- lookup-smogon pre
# pre.10544 (id=10544, username="pre", banned=false)
```

*(Queries the XenForo REST API when `SMOGON_TOKEN` is set in `.env`, or resolves numeric `slug.id` /
member URLs against the public XenForo profile page when `SMOGON_TOKEN` is unset.)*

### Step 2: Register or Qualify a Project in `static/projects.yml`

Add an `arena:` block to the project's entry in `static/projects.yml` (and optionally commit a PNG
avatar at `static/avatars/<slug>.png`):

```yaml
- name: Foul Play
  active: 2019
  license: GPL-3.0
  source: https://github.com/pmariglia/foul-play
  language: Python
  engine: poke-engine
  platform:
    - name: Pokémon Showdown!
      url: https://github.com/smogon/pokemon-showdown
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.249812
```

- **`qualified: false` (or omitted) -> `Pending`:** Owners can sign in to `/account/` (to link
  Discord or submit 1 OCI entry to a `scheduled` tournament) and read/edit developer `/wiki`
  pages, while **ladder** submissions stay disabled until staff approve qualification.
- **`qualified: true` -> `Qualified` / `Eligible`:** Unlocks ladder submissions on `/account/`
  (marking the project `Eligible` when a ladder is open and cooldown/settlement criteria are met)
  and allows owners to link Discord and join the **pkmn.ai** Discord server.
- **`logo` (optional):** Defaults to `static/avatars/<slug>.png` when that file exists; set
  `arena.logo: custom.png` only if overriding the filename.

Commit and deploy (`npm run deploy:reload`), or sync `static/projects.yml` on the server manually:

```sh
# Online sync (verifies Smogon usernames, IDs, and ban status, then re-renders public/)
npm run pkmn -- sync-projects

# Offline sync (parses YAML without hitting Smogon)
npm run pkmn -- sync-projects --offline
```

### Reassigning or Removing a Developer

To move a GitHub user to another project (or remove them from all projects while keeping historical
versions intact) without disturbing comments/formatting in `static/projects.yml`:

```sh
# Move @pmariglia to project slug "foul-play" (optionally updating their Smogon spec)
npm run pkmn -- reassign-developer pmariglia foul-play --smogon pmariglia.249812

# Remove @formerdev from their project (leaves `owners: {}` if they were the sole owner)
npm run pkmn -- reassign-developer formerdev --none
```

Commit and push the resulting `static/projects.yml` diff so subsequent deploys keep the change.

### Disabling a Project

Remove the `arena:` block from the project's entry in `static/projects.yml` and deploy (or run
`npm run pkmn -- sync-projects`). Existing historical match rows are preserved, while the project's
SQLite status transitions to `disabled`. Additionally, whenever `syncProjectsWithSmogon` detects
that an owner's Smogon account is banned (`smogon_standing = 'bad'`), submission eligibility is
automatically blocked until resolved.

---

## 3. Moderating Submissions: Quarantine & Cooldowns

### Quarantining & Restoring Agent Versions

If an active version exhibits systematic protocol violations, sandbox faults, or rule-breaking
behavior after passing smoke testing:

```sh
# Remove version 1.2.0 from active matchmaking/leaderboards and record an operator reason
npm run pkmn -- quarantine foul-play 1.2.0 --reason "Repeated protocol framing timeouts on SV"

# Restore a previously quarantined version once verified safe
npm run pkmn -- unquarantine foul-play 1.2.0
```

### Refunding the 14-Day Submission Cooldown

When a competitor burns their 14-day submission window on an infrastructure hiccup or packaging
mistake that staff agrees to waive:

```sh
npm run pkmn -- refund-cooldown foul-play
```

---

## 4. Provisioning Teams for `harvested` Ladders

Ladders with `team: harvested` in `config/ladders.yml` (`RBY` / `gen1ou20261109`, `ADV` /
`gen3ou20261109`, `SV` / `gen9ou20261109`) store their private team pools in SQLite (`ladder_teams`)
on the `pkmn.ai` web server so they stay symmetric with `pools` (`agent_ladder_teams`), are
validated and canonicalized once on ingest, and are never leaked to static `public/`.

### Team File Format & Validation

Upload either a Pokémon Showdown Teambuilder paste (`=== [format] Team Name ===` blocks), plain
6-Pokémon sets separated by blank lines, or packed team lines (`]`-delimited, one team per line):

- Every team must contain 6 legal Pokémon in the ladder's `format` (`validateHarvestedTeams` checks
  `@pkmn/sim` `TeamValidator` and canonically sorts sets/moves via `@pkmn/sets`).
- At least 2 non-mirror teams with distinct 6-species sets are required (in practice, hundreds of
  high-ladder teams so 2-game blind-pair matches sample diverse matchups).

### Uploading Harvested Teams (`pkmn` CLI)

Upload or replace a `harvested` ladder's pool locally on `pkmn.ai`:

```sh
# Writes validated canonical packed teams into ladder_teams
npm run pkmn -- upload-ladder-teams gen1ou20261109 /path/to/gen1ou-teams.txt
```

Uploading replaces the entire `ladder_teams` pool for `<ladder_id>` atomically in SQLite.

### How the Mac mini Runner Fetches Harvested Teams

The M6 Mac mini coordinator pulls validated packed teams over authenticated HTTP:

```sh
# Fetch canonical packed teams (supports ETag / If-None-Match -> 304 Not Modified caching)
curl -fsS https://pkmn.ai/api/arena/ladders/gen1ou20261109/teams \
  -H "Authorization: Bearer $ARENA_SECRET"
```

Store cached copies under `0700` `/opt/arena/teams` (`0600` per file) owned by the coordinator user
only (sandboxed `p1`/`p2` agent users must never have read access to harvested pools). Sync
read-only era-matched `data.pkmn.cc` usage
stats into `/opt/arena/stats/` (exposed as `PKMN_STATS_DIR=/opt/arena/stats`): `<format>.json` for
fixed ladders (`gen1ou.json`, `gen3ou.json`, `gen9ou.json`), and `data.pkmn.cc`'s format-scoped
hierarchy for `RAND` (`<format>.json`, `exact/<format>.json`, `full/<format>/*`,
`stats/<format>.json`, `js/<format>.json`; none for `VGC`):

```sh
ssh arena 'mkdir -p /opt/arena/stats'
rsync -avz --delete stats/ arena:/opt/arena/stats/
ssh arena 'chmod -R a+rX,go-w /opt/arena/stats'
```

> [!NOTE]
> **How `pools` ladders (`VGC`) differ:** Ladders with `team: pools` do not use `ladder_teams`.
> Instead, competitors submit their 20-team seasonal roster on `/account/`, which `pkmn.ai`
> validates incrementally against the public blocklist directories configured under `pools:` in
> `config/ladders.yml` (`teams/teams/...`, `teams/pkmn_stuff/...`, `teams/vgc.bot/...`) and stores
> in SQLite (`agent_ladder_teams`) for the Mac mini to pull via `GET /api/arena/pending-submissions`.

---

## 5. Ladder Lifecycle, Anchors, Rotation & Archives

### Staging `upcoming` Ladders & Pre-Activation Checks

New seasons start with `status: upcoming` in `config/ladders.yml`. While a ladder is `upcoming`:

- Approved (`qualified`) projects see it checked/selectable on `/account/` (`(upcoming)`) and can
  submit entries immediately, allowing the Mac mini runner to complete smoke tests before matches
  begin (the settlement gate does not block re-submissions while a ladder is `upcoming`).
- Matchmaking (`getPlayableLadders()`) ignores `upcoming` ladders until staff flips `status` to
  `active`.

`npm run pkmn -- set-ladder-status <ladder_id> active` enforces **three preconditions** and refuses
activation until all three pass:

1. **Harvested teams uploaded (for `team: harvested`):** At least 2 non-mirror legal teams exist in
   `ladder_teams` (`upload-ladder-teams`).
2. **Minimum active entries:** At least **2** distinct non-disabled projects have active (`champion`
   or `challenger`), smoke-`passed` entries on `harvested`/`random` ladders, or at least **4** with
   active team pools on `pools` ladders.
3. **1500-Elo anchor designated:** One active, smoke-`passed`, non-disabled entry on `<ladder_id>`
   is pinned as the gauge anchor (`is_anchor = 1`).

Typical launch sequence for a staged ladder:

```sh
# 1. Upload harvested team pools for harvested ladders
npm run pkmn -- upload-ladder-teams gen1ou20261109 gen1ou-teams.txt

# 2. Wait for competitors to submit entries and pass Mac mini smoke tests while status=upcoming,
#    then pin the 1500-Elo gauge anchor once its version passes smoke testing
npm run pkmn -- set-anchor gen1ou20261109 metamon 1.0.0

# 3. Flip the ladder to active (verified by set-ladder-status preconditions)
npm run pkmn -- set-ladder-status gen1ou20261109 active
```

Valid statuses are `upcoming` -> `active` -> `settling` -> `archived`. Always commit the matching
`status:` update in `config/ladders.yml` so future server restarts stay consistent (`syncLadders`
refuses to downgrade an already-`active`/`settling`/`archived` SQLite ladder back to `upcoming` or
regress an `archived` settling ladder back to `settling`).

### Setting 1500-Elo Gauge Anchors

Once a ladder's designated anchor version (for example, `Metamon` `1.0.0` on `RBY` or `Foul Play`
`1.0.0` on `ADV`/`SV`/`RAND`/`VGC`) passes smoke testing and enters the ladder, pin its rating to
`1500` Elo before opening the ladder:

```sh
npm run pkmn -- set-anchor gen1ou20261109 metamon 1.0.0
npm run pkmn -- set-anchor gen3ou20261109 foul-play 1.0.0
npm run pkmn -- set-anchor gen9ou20261109 foul-play 1.0.0
npm run pkmn -- set-anchor gen9randombattle20261109 foul-play 1.0.0
```

### Adding a New `@pkmn/sim` Version

Every ladder in `config/ladders.yml` (defaulting to `'0.11.0'` when omitted) and every tournament
in SQLite specifies a `version` string (e.g. `0.11.0`, or a pinned tag/commit key such as `0.12.0`
or `reg-md-202612`).
Each version runs inside its own isolated `worker_threads` worker (`server/sim-worker.ts`) so fixed
ladders (`RBY`, `ADV`, `SV`, `RAND`) remain frozen while seasonal `VGC` ladders or tournaments
advance to newer Pokémon Showdown commits.

To install a new `@pkmn/sim` version on both the web server (`pkmn.ai`) and the Arena coordinator
host (`arena`):

```sh
# Install an npm-published version into sim/0.12.0/ and verify the worker boots:
npm run pkmn -- install-sim 0.12.0 \
  --dex @pkmn/dex@0.12.0 \
  --mods @pkmn/mods@0.12.0 \
  --randoms @pkmn/randoms@0.12.0

# Or install directly from a git commit / tarball under a custom version key:
npm run pkmn -- install-sim vgc-2026-12 \
  --sim https://github.com/pkmn/ps/tarball/<commit-sha>
```

`sim/<version>/` is gitignored (`sim/`), so run `pkmn install-sim <version>` on each host (both
`pkmn.ai` for team validation and the Mac mini `arena` runner for battle simulation) before
activating a ladder or tournament that references `<version>`.

### Rotating a Seasonal or Epoch Ladder

When a new VGC regulation begins (or a permanent format undergoes a new epoch):

1. If the new ladder uses a new `@pkmn/sim` version, install it with `pkmn install-sim <version>`
   on both `pkmn.ai` and `arena`.
2. If the new ladder uses `team: pools`, add the new reference blocklist directories under `teams/`
   and `config/ladders.yml`.
3. Run `rotate-ladder` on `pkmn.ai`:

```sh
npm run pkmn -- rotate-ladder gen9championsvgc2026regmc \
  --name "VGC 2026 Reg M-C" \
  --new gen9championsvgc2026regmd \
  --new-name "VGC" \
  --format gen9championsvgc2026regmd \
  --version 0.12.0 \
  --team pools \
  --teams 20
```

What `rotate-ladder` does atomically:
- Renames the outgoing ladder to `"VGC 2026 Reg M-C"`. If enough distinct active projects (4 for
  `pools`, 2 otherwise) still have unsettled versions (`matches < 25` or `SE > 30`), it enters
  `settling` (closing new submissions while finishing remaining settlement matches before
  automatically transitioning to `archived`); otherwise it transitions immediately to `archived`
  and marks its entries `retired`.
- Stages `gen9championsvgc2026regmd` in `status = 'upcoming'` under the `vgc` URL slot
  (`/arena/ladders/vgc/`) so competitors can upload initial team pools/entries (and staff can upload
  harvested teams + pin an anchor) before running `set-ladder-status gen9championsvgc2026regmd active`.
- Update `config/ladders.yml` to record the archived/settling entry alongside the new `upcoming`
  (and later `active`) entry, then commit and deploy.

### Publishing Retired `pools` Ladder Archives (`<ladder_id>-logs.tar`)

Continuous `harvested` ladders never publish battle logs or team sheets, while `random` ladders
publish public `.log` replays and daily rolled-up `<ladder_id>-logs.tar` archives (an outer `.tar`
wrapping daily solid `.7z` archives and monthly `.tar` rollups). For competitor-submitted `pools`
ladders (`VGC`), per-game `.log` replays are staged privately under
`public/arena/ladders/.private/<ladder_id>/` while live and promoted automatically to
`public/arena/ladders/<ladder_id>/`—alongside `<ladder_id>-logs.tar` and dynamic
`/arena/ladders/<ladder_id>/teams.json`—**strictly after** the ladder reaches `status = 'archived'`:

```sh
# Option A: Local file on pkmn.ai
npm run pkmn -- publish-ladder-archive gen9championsvgc2026regmc /tmp/gen9championsvgc2026regmc-logs.tar

# Option B: Remote upload from the Mac mini over HTTPS / tunnel
curl -fsS -X PUT "https://pkmn.ai/api/arena/ladders/gen9championsvgc2026regmc/archive" \
  -H "Authorization: Bearer $ARENA_SECRET" \
  -H "X-Content-SHA256: $(shasum -a 256 gen9championsvgc2026regmc-logs.tar | awk '{print $1}')" \
  --data-binary @gen9championsvgc2026regmc-logs.tar
```

Both paths atomically write `public/arena/ladders/<ladder_id>/<ladder_id>-logs.tar` (and ensure
staged `.log` replays are promoted into `public/arena/ladders/<ladder_id>/`), while
`pkmn.ai-server` serves `/arena/ladders/<ladder_id>/teams.json` dynamically from SQLite once
`status = 'archived'`.

---

## 6. Discord Sync & Wiki Administration

### Discord Roles, Pins, Alerts & One-Shot Sync

`server/discord.ts` runs inside `pkmn.ai-server` every 60 seconds in production (`NODE_ENV=production`):
- Syncs guild membership into SQLite (`discord_members`) for `/auth/discord/validate` (`/chat/logs`
  access) and `/account/` eligibility checks.
- Syncs native Arena `#1` leaderboard roles (configured via `discord:` role IDs in
  `config/ladders.yml`) and the `competitor` role (`config/discord.yml`), plus external partner
  leaderboard roles (`ladders:` in `config/discord.yml` using `VGC_BOT_TOKEN`, resolving owners via
  linked `discordId`s, `🤖 <Agent>` guild roles, or owner usernames).
- Enforces channel pinned messages (`pins:` in `config/discord.yml`), archives `#general` chat logs
  into `chat/logs/YYYY-MM-DD.txt`, and DMs developers on smoke-test failure or quarantine (and staff
  in `staff:` of `config/discord.yml` on quarantine or if Mac mini heartbeats go stale `> 15`
  minutes).

To trigger an immediate one-shot Discord sync outside the 60-second loop:

```sh
cd /home/pkmn/ai
node --env-file-if-exists=.env build/server/discord
```

### Wiki Administration (`server/wiki.tsx`)

- Site-wide wiki administrators (`ADMINS`) and GitHub-to-Smogon revision display-name overrides
  (`AUTHORS`) are defined at the top of `server/wiki.tsx`. Wiki admins can edit any registered
  project page (`/wiki/<Project_Name>`) regardless of project ownership.
- Registered project wiki pages support three read-visibility tiers via an optional first-line
  directive: `{% visibility: developers %}` (default for project pages),
  `{% visibility: discord %}`, or `{% visibility: public %}` (always used for non-project pages).

---

## 7. Tournament Operations

Unlike continuous ladders on the Mac mini (which time-slice processes and hide logs), scheduled
Tournaments run on isolated Google Cloud `g2-custom-24-49152` Spot GPU VMs (`1× NVIDIA
L4 24 GB`, `24 vCPUs`, `48 GB RAM` per agent) in **live broadcast mode** (`ARENA_PONDER=1`, public
teams and `.log` replays).

- **Naming & URLs:** Titles follow `Tournament #<N>: <Format / Ruleset>` with sequential numeric IDs
  (`1`, `2`, `3`, …) served at `/arena/tournaments/<id>/`.
- **Tournament-Specific Rules (`static/tours/<id>.dj`):** Each tournament can provide an optional
  Djot file at `static/tours/<id>.dj` supplementing `/rules/` with event-specific format, stage
  structure, and hardware rules. Whenever present, `pkmn.ai` renders it directly under the event's
  metadata header across all tournament states (`scheduled`, `running`, and `completed`), without
  exposing a separate `.json` endpoint.
- **Submission Gating & Cutoff:** Both `Pending` (registered) and `qualified` (Approved)
  projects may submit at most 1 OCI container entry (`package: 'oci'`) per `scheduled` tournament
  on `/account/`, completely independent of ladder qualification, the 14-day ladder cooldown, and
  unsettled Challenger gates. Only Approved (`qualified: true`) projects can become `Eligible` for
  continuous ladders. Failed smoke tests may be resubmitted immediately until registration closes.
  Entries close automatically at **00:00:00 UTC strictly before `startsAt`** (so e.g. a tournament
  starting `2026-12-12T18:00:00Z` closes entries at `2026-12-12 00:00 UTC`, and one starting
  `2026-12-12T00:00:00Z` closes at `2026-12-11 00:00 UTC`).

### Step 7.1: Open a Tournament for Submissions (`scheduled`)

```sh
npm run pkmn -- create-tournament 3 \
  --name "Tournament #3: VGC 2026 Reg M-D OTS BO3" \
  --format gen9championsvgc2026regmd \
  --version 0.11.0 \
  --team pools \
  --rules '["Open Team Sheets","Best-of-3"]' \
  --games 50 \
  --batch 10 \
  --tables 4 \
  --starts 2026-12-12T18:00:00Z \
  --status scheduled
```

Pass `--team harvested`, `--team pools`, or `--team random` when the tournament deals teams from a
pre-assigned pool (using a Common Random Numbers locked $2M$-team book across all Round-Robin
pairings), or omit `--team` when entrants supply their own team via `/utm <packed_team>` on their
first `stdout` line. This creates `/arena/tournaments/3/`, lists the event under **Tournaments** on
`/arena/`, and exposes the tournament checkbox on `/account/` for all registered (`Pending` and
`qualified`) projects.

### Step 7.2: Seed Entrants & Bake the Custom Machine Image

Once the submission deadline arrives, lock entrants and assign 1-based Berger pairing seeds ordered
by pre-tournament conservative ladder rating (`Elo - 1.96 * SE`):

```sh
npm run pkmn -- seed-tournament 3
sqlite3 /var/lib/pkmn/arena.sqlite \
  "SELECT seed, agent_id, version_id FROM tournament_entrants WHERE tournament_id = '3' ORDER BY seed"
```

Provision one staging `g2-custom-24-49152` VM (`300 GB` `pd-ssd`, NVIDIA L4 drivers, `bwrap`,
`skopeo`, `umoci`, and `/usr/local/bin/tourney-{relay,agent}` runner binaries):

```sh
gcloud compute instances create pkmn-tourney-bake \
  --zone=us-central1-a \
  --machine-type=g2-custom-24-49152 \
  --accelerator=type=nvidia-l4,count=1 \
  --maintenance-policy=TERMINATE \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-type=pd-ssd \
  --boot-disk-size=300GB
```

On `pkmn-tourney-bake`, run `arena/scripts/bake-image.sh <entrants-manifest.tsv>` to pull each
entrant's pinned `sha256` OCI image via `skopeo`, unpack layers via `umoci unpack --rootless` (or
`unpackOciRootfs` + `finalizeUnpackedOciRootfs` from `arena/tournament.ts`), verify the 500 MB
resident size cap, initial `/utm <packed_team>` response (when `team` is unset), and a Turn-1
isolated `bwrap --unshare-all` smoke game, then snapshot the VM into a custom GCP image:

```sh
./arena/scripts/bake-image.sh /tmp/tournament-3-entrants.tsv

# Snapshot staging disk into custom image pkmn-tourney-3
gcloud compute instances stop pkmn-tourney-bake --zone=us-central1-a
gcloud compute images create pkmn-tourney-3 \
  --source-disk=pkmn-tourney-bake \
  --source-disk-zone=us-central1-a \
  --storage-location=us
gcloud compute instances delete pkmn-tourney-bake --zone=us-central1-a --quiet
```

### Step 7.3: Provision Spot GPU Tables & Go Live (`running`)

Provision $2K$ Spot worker VMs (`pkmn-t3-table-<1..K>-<a|b>`, inbound TCP `22` restricted to the
coordinator IP) across NVIDIA L4 zones (`us-central1-{a,b,c}`, `us-east4-{a,c}`, `us-west1-b`):

```sh
gcloud compute instances create pkmn-t3-table-1-a \
  --zone=us-central1-a \
  --machine-type=g2-custom-24-49152 \
  --accelerator=type=nvidia-l4,count=1 \
  --maintenance-policy=TERMINATE \
  --provisioning-model=SPOT \
  --instance-termination-action=DELETE \
  --image=pkmn-tourney-3 \
  --boot-disk-type=pd-ssd
```

Once SSH `ControlMaster` sockets and the Berger `tournament_matches` schedule are ready, flip the
tournament live:

```sh
npm run pkmn -- set-tournament-status 3 running
```

Registration closes on `/account/`, the site-wide `● LIVE Tournament #3: ...` `#topbar` banner is
injected across `pkmn.ai`, and live Showdown frames stream to `/arena/tournaments/3/`
(`/api/tournaments/3/stream`). Spot preemptions retry only the single interrupted match (preserving
its PRNG `seed`, never recording a `tournament_matches` forfeit) and replace the VM in the next L4
zone with zero penalty.

### Step 7.4: Complete the Event, Publish Replays & Tear Down Cloud VMs (`completed`)

1. **Finalize standings and clear the `● LIVE` banner:**

```sh
npm run pkmn -- set-tournament-status 3 completed
```

2. **Publish the `.7z` replay archive (`3-replays.7z`):**

```sh
npm run pkmn -- publish-tournament-archive 3 /tmp/3-replays.7z
```

3. **Delete all worker VMs and staging images:**

```sh
gcloud compute instances list --filter="name~'^pkmn-t3-'" \
  --format="csv[no-heading](name,zone)" | while IFS=, read -r name zone; do
  gcloud compute instances delete "$name" --zone="$zone" --quiet
done
gcloud compute images delete pkmn-tourney-3 --quiet
```

Verify zero lingering GPU instances or orphaned `pd-ssd` disks remain with
`gcloud compute instances list` and `gcloud compute disks list`.
