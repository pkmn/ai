# Administration

Application-level runbook for **pkmn.ai**: deploys, project onboarding, moderation, `harvested` team
pools, ladder lifecycles/rotations, Discord/wiki admin, and cloud-GPU tournaments. For OS/daemon
setup (`systemd`, `nginx`, `certbot`, backups), see [SETUP.md](SETUP.md).

## 1. Deployments & Operator CLI (`pkmn`)

From your laptop (all web deploy scripts run `./private/sync` if present; see `private/SETUP.md`):

```sh
npm run deploy          # sync .env/private/, pull main on pkmn.ai, rebuild public/, restart pkmn.ai-server
npm run deploy:reload   # same, restarting pkmn.ai-server only if server/db/config/template files changed
npm run deploy:arena    # pull main on Mac mini arena, compile, verify build/arena, drain via SIGUSR1
```

On `pkmn.ai`, `./deploy` pulls `origin/main`, updates sparse submodules (`teams/teams`,
`teams/pkmn_stuff`), runs `npm install --omit=dev` if `package.json` changed, reloads `systemd`/
`nginx` on `config/` changes, builds `public/`, and restarts `pkmn.ai-server` as needed.

### `pkmn` CLI

Run remotely (`ssh pkmn@pkmn.ai 'cd /home/pkmn/ai && npm run pkmn -- <cmd>'`) or locally
(`npm run pkmn -- <cmd>`). Auto-opens `/var/lib/pkmn/arena.sqlite` in prod (or `db/data/arena.sqlite`
locally; pass `MOCK=1` for `.mock/` overlays). SQLite WAL (`busy_timeout = 5000` ms) allows safe
concurrent use alongside `pkmn.ai-server`, which auto-invalidates its ETag cache on WAL advance
(tournament status flips also update the static `#topbar` banner).

| Command | Purpose |
| :--- | :--- |
| `lookup-smogon <user\|slug.id\|id\|url>` | Resolve a Smogon user's immutable XenForo ID and ban status. |
| `sync-projects [--projects <path>] [--offline]` | Sync `arena:` blocks from `static/projects.yml` into `agents`/`developers`. |
| `reassign-developer <github> <slug\|--none> [...]` | Move/remove a GitHub developer in `projects.yml` + SQLite. |
| `quarantine <slug> <ver> [--reason "..."]` | Quarantine an agent version across ladders and recompute ratings. |
| `unquarantine <slug> <ver>` | Restore a quarantined version and recompute ratings. |
| `refund-cooldown <slug>` | Clear the 14-day submission cooldown on `<slug>`. |
| `set-anchor <ladder_id> <slug> <ver>` | Pin `<slug>@<ver>` to `1500` Elo on `<ladder_id>` and recompute ratings. |
| `set-ladder-status <ladder_id> <status>` | Set `<ladder_id>` to `upcoming`, `active`, `settling`, or `archived`. |
| `upload-ladder-teams <ladder_id> <file>` | Validate and atomically replace `harvested` teams in `ladder_teams`. |
| `rotate-ladder <old_id> --name "..." [--new <id> ...]` | Transition `<old_id>` to `settling`/`archived` and optionally stage `<new_id>`. |
| `install-sim <ver> [--sim <spec> ...]` | Install isolated `@pkmn/sim` under `sim/<ver>/` and verify worker boot. |
| `publish-ladder-archive <ladder_id> <file>` | Publish `<ladder_id>-logs.tar` (`random` or `archived` `pools` ladders). |
| `create-tournament <id> --name "..." --format <fmt> --version <ver> ...` | Create/update a tournament (`scheduled`/`running`/`completed`). |
| `seed-tournament <id>` | Lock entrants and assign 1-based Berger seeds by conservative rating. |
| `set-tournament-status <id> <status>` | Set tournament to `scheduled`, `running` (`#topbar` `● LIVE`), or `completed`. |
| `publish-tournament-archive <id> <archive.7z>` | Publish `<id>-replays.7z` for a `completed` tournament. |
| `session [--github <login>] [--discord <id>:<name>]` | Mint a signed `pkmn_session` cookie using `SESSION_SECRET`. |

## 2. Project Onboarding & Ownership (`static/projects.yml`)

Every Arena developer needs a Smogon account in good standing and belongs to at most one project.

1. **Resolve XenForo IDs** (uses XenForo API with `SMOGON_TOKEN`, else public profile lookup):
   ```sh
   npm run pkmn -- lookup-smogon pre   # pre.10544 (id=10544, username="pre", banned=false)
   ```
2. **Add an `arena:` block in `static/projects.yml`** (and optional `static/avatars/<slug>.png`; set
   `arena.logo: custom.png` only to override):
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
   - `qualified: false` (or omitted) -> `Pending`: unlocks `/account/` (Discord linking + 1 OCI
     entry per `scheduled` tournament) and `/wiki` editing; continuous ladders stay disabled.
   - `qualified: true` -> `Qualified` / `Eligible`: unlocks continuous ladder submissions.
3. **Deploy or sync manually:**
   ```sh
   npm run pkmn -- sync-projects            # verifies Smogon IDs/ban status
   npm run pkmn -- sync-projects --offline  # YAML-only sync
   ```

- **Reassign / remove developer** (preserves `projects.yml` formatting; commit & push the diff):
  ```sh
  npm run pkmn -- reassign-developer pmariglia foul-play --smogon pmariglia.249812
  npm run pkmn -- reassign-developer formerdev --none
  ```
- **Disable project:** Remove its `arena:` block and sync/deploy (`agents.status = 'disabled'`;
  history is preserved). Banned Smogon owners (`smogon_standing = 'bad'`) are auto-blocked.

## 3. Moderation: Quarantine & Cooldowns

```sh
npm run pkmn -- quarantine foul-play 1.2.0 --reason "Repeated protocol framing timeouts on SV"
npm run pkmn -- unquarantine foul-play 1.2.0
npm run pkmn -- refund-cooldown foul-play
```

## 4. Provisioning `harvested` Ladder Teams & Usage Stats

`team: harvested` ladders (`RBY`/`gen1ou20261109`, `ADV`/`gen3ou20261109`, `SV`/`gen9ou20261109`)
store private pools in SQLite (`ladder_teams`). Accepted inputs: Showdown Teambuilder pastes
(`=== [format] Name ===`), blank-line-separated 6-Pokémon sets, or `]`-packed lines.
`validateHarvestedTeams` enforces 6 legal Pokémon per team (`TeamValidator`), canonical sorting
(`@pkmn/sets`), and $\ge 2$ non-mirror distinct 6-species teams:

```sh
# Atomically replace ladder_teams for <ladder_id>
npm run pkmn -- upload-ladder-teams gen1ou20261109 /path/to/gen1ou-teams.txt

# Mac mini pull (ETag / 304 cached; store under 0700 /opt/arena/teams, 0600 files, coordinator-only)
curl -fsS https://pkmn.ai/api/arena/ladders/gen1ou20261109/teams \
  -H "Authorization: Bearer $ARENA_SECRET"
```

Sync read-only era-matched `data.pkmn.cc` stats to `/opt/arena/stats/` (`PKMN_STATS_DIR=/opt/arena/stats`):
`<format>.json` for fixed ladders (`gen1ou`, `gen3ou`, `gen9ou`), full format-scoped hierarchy for
`RAND` (`<format>.json`, `exact/<format>/*`, `full/<format>.json`, `stats/<format>.json`,
`js/<format>.js`), none for `VGC`:

```sh
ssh arena 'mkdir -p /opt/arena/stats'
rsync -avz --delete stats/ arena:/opt/arena/stats/
ssh arena 'chmod -R a+rX,go-w /opt/arena/stats'
```

> [!NOTE]
> `team: pools` ladders (`VGC`) don't use `ladder_teams`: competitors submit 20-team rosters via
> `/account/`, validated against `pools:` blocklists in `config/ladders.yml`, stored in
> `agent_ladder_teams`, and pulled by the runner via `GET /api/arena/pending-submissions`.

## 5. Ladder Lifecycle, Anchors, `@pkmn/sim` & Rotation

### Staging & Activating Ladders

Ladders start as `status: upcoming` in `config/ladders.yml`: qualified projects can submit and run
smoke tests (settlement gate disabled), while matchmaking (`getPlayableLadders()`) skips them.

`set-ladder-status <id> active` enforces three preconditions:
1. **Harvested teams** (`team: harvested`): $\ge 2$ non-mirror legal teams in `ladder_teams`.
2. **Minimum active smoke-passed entries:** $\ge 2$ distinct projects (`harvested`/`random`), or
   $\ge 4$ with active pools (`pools`).
3. **1500-Elo anchor:** One active, smoke-passed, non-disabled entry pinned (`is_anchor = 1`).

```sh
npm run pkmn -- upload-ladder-teams gen1ou20261109 gen1ou-teams.txt
npm run pkmn -- set-anchor gen1ou20261109 metamon 1.0.0   # e.g. foul-play 1.0.0 on ADV/SV/RAND/VGC
npm run pkmn -- set-ladder-status gen1ou20261109 active
```

Statuses flow `upcoming -> active -> settling -> archived`. Commit the matching `status:` in
`config/ladders.yml` (`syncLadders` never downgrades `active`/`settling`/`archived` -> `upcoming` or
`archived` -> `settling`).

### Installing a New `@pkmn/sim` Version

Ladders default to `version: '0.11.0'` and run in isolated `worker_threads` (`server/sim-worker.ts`).
`sim/` is gitignored, so install on **both** `pkmn.ai` and `arena` before activating a ladder or
tournament referencing it:

```sh
npm run pkmn -- install-sim 0.12.0 \
  --dex @pkmn/dex@0.12.0 --mods @pkmn/mods@0.12.0 --randoms @pkmn/randoms@0.12.0

# Or from a git commit tarball:
npm run pkmn -- install-sim vgc-2026-12 --sim https://github.com/pkmn/ps/tarball/<commit-sha>
```

### Rotating a Ladder

Install any new `@pkmn/sim` version on both hosts, add any new `pools` blocklists under `teams/` and
`config/ladders.yml`, then run:

```sh
npm run pkmn -- rotate-ladder gen9championsvgc2026regmc \
  --name "VGC 2026 Reg M-C" \
  --new gen9championsvgc2026regmd --new-name "VGC" \
  --format gen9championsvgc2026regmd --version 0.12.0 --team pools --teams 20
```

Atomically renames the outgoing ladder, transitions it to `settling` if enough active projects (4 for
`pools`, 2 otherwise) still have unsettled versions (`matches < 25` or `SE > 30`)—auto-archiving once
settled—or directly to `archived` (`retired` entries), and stages the successor as `upcoming` under
the same URL slot. Commit the updated `config/ladders.yml` and deploy.

### Publishing Retired `pools` Archives (`<ladder_id>-logs.tar`)

`harvested` ladders never publish logs/teams; `random` ladders publish live `.log` replays and
`<id>-logs.tar`; `pools` ladders stage `.log` files in `public/arena/ladders/.private/<id>/` and
promote them—alongside `<id>-logs.tar` and dynamic `/arena/ladders/<id>/teams.json`—**strictly
after** `status = 'archived'`:

```sh
# Local on pkmn.ai:
npm run pkmn -- publish-ladder-archive gen9championsvgc2026regmc /tmp/gen9championsvgc2026regmc-logs.tar

# Remote upload from Mac mini:
curl -fsS -X PUT "https://pkmn.ai/api/arena/ladders/gen9championsvgc2026regmc/archive" \
  -H "Authorization: Bearer $ARENA_SECRET" \
  -H "X-Content-SHA256: $(shasum -a 256 gen9championsvgc2026regmc-logs.tar | awk '{print $1}')" \
  --data-binary @gen9championsvgc2026regmc-logs.tar
```

## 6. Discord Sync & Wiki Admin

In production (`NODE_ENV=production`), `server/discord.ts` runs every 60s to:
- Sync `discord_members` (for `/auth/discord/validate` on `/chat/logs` and `/account/` checks).
- Sync native `#1` roles (`config/ladders.yml`), `competitor` role (`config/discord.yml`), and
  partner `vgc.bot`/`pkmn.bot` roles (`VGC_BOT_TOKEN`, resolved by `discordId`, `🤖 <Agent>` role,
  or username).
- Enforce `pins:`, archive `#general` to `chat/logs/YYYY-MM-DD.txt`, and DM developers on smoke-test
  failure or quarantine.
- DM `staff:` (6h per-key dedup) on quarantines, stale Arena heartbeats (`> 15m` + recovery), low
  VPS/Arena disk, backup failures, `/Volumes/Archive` unmounts, `.7z`/archive failures, smoke infra
  errors, repeated sync failures, and unexpected `pkmn.ai-server` exits (`ExecStopPost` ->
  `pkmn notify-staff`). Mac mini relays alerts via `POST /api/arena/alert` (`Bearer $ARENA_SECRET`).

Manual one-shot sync: `node --env-file-if-exists=.env build/server/discord`.

**Wiki (`server/wiki.tsx`):** `ADMINS` (can edit any project page) and `AUTHORS` (GitHub->Smogon
display overrides) live at the top of `server/wiki.tsx`. Project pages support optional first-line
`{% visibility: developers %}` (default), `{% visibility: discord %}`, or `{% visibility: public %}`
(forced for non-project pages).

## 7. Tournament Operations

Tournaments run on ephemeral GCP `g2-custom-24-49152` Spot VMs (`1× L4 24 GB`, `24 vCPUs`,
`48 GB RAM` per agent) with `ARENA_PONDER=1`, public teams, and live `.log` replays.

- **Naming & rules:** `Tournament #<N>: <Format>` at `/arena/tournaments/<id>/`. Optional
  `static/tours/<id>.dj` renders beneath the event header in all states (no `.json` endpoint).
- **Submissions:** Both `Pending` and `qualified` projects may submit 1 OCI entry (`package: 'oci'`)
  per `scheduled` tournament, independent of ladder qualification/cooldown/settlement. Failed smoke
  tests may resubmit immediately. Closes automatically at `00:00:00 UTC` strictly before `startsAt`
  (e.g. `2026-12-12T18:00Z` closes `2026-12-12 00:00Z`; `2026-12-12T00:00Z` closes `2026-12-11 00:00Z`).

### 7.1 Schedule (`scheduled`)

```sh
npm run pkmn -- create-tournament 3 \
  --name "Tournament #3: VGC 2026 Reg M-D OTS BO3" \
  --format gen9championsvgc2026regmd --version 0.11.0 \
  --team pools --rules '["Open Team Sheets","Best-of-3"]' \
  --games 50 --batch 10 --tables 4 --starts 2026-12-12T18:00:00Z --status scheduled
```

Pass `--team harvested|pools|random` for a locked Common Random Numbers $2M$-team book, or omit for
BYOT (`/utm <packed_team>` on first `stdout` line).

### 7.2 Seed & Bake Custom Machine Image

Lock entrants and assign 1-based Berger seeds by conservative rating (`Elo - 1.96 * SE`):

```sh
npm run pkmn -- seed-tournament 3
sqlite3 /var/lib/pkmn/arena.sqlite \
  "SELECT seed, agent_id, version_id FROM tournament_entrants WHERE tournament_id = '3' ORDER BY seed"
```

Create a staging VM (`300GB pd-ssd`, L4 drivers, `bwrap`, `skopeo`, `umoci`,
`/usr/local/bin/tourney-{relay,agent}`), bake entrants via `arena/scripts/bake-image.sh` (pulls
pinned `sha256` OCI images, unpacks rootless, verifies 500 MiB cap, `/utm`, and Turn-1
`bwrap --unshare-all` smoke game), then snapshot and delete the staging VM:

```sh
gcloud compute instances create pkmn-tourney-bake --zone=us-central1-a \
  --machine-type=g2-custom-24-49152 --accelerator=type=nvidia-l4,count=1 \
  --maintenance-policy=TERMINATE --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud --boot-disk-type=pd-ssd --boot-disk-size=300GB

# On pkmn-tourney-bake:
./arena/scripts/bake-image.sh /tmp/tournament-3-entrants.tsv

# Snapshot & clean up staging VM:
gcloud compute instances stop pkmn-tourney-bake --zone=us-central1-a
gcloud compute images create pkmn-tourney-3 --source-disk=pkmn-tourney-bake \
  --source-disk-zone=us-central1-a --storage-location=us
gcloud compute instances delete pkmn-tourney-bake --zone=us-central1-a --quiet
```

### 7.3 Provision Spot Tables & Go Live (`running`)

Provision $2K$ Spot VMs (`pkmn-t3-table-<1..K>-<a|b>`, TCP `22` restricted to coordinator IP) across
L4 zones (`us-central1-{a,b,c}`, `us-east4-{a,c}`, `us-west1-b`):

```sh
gcloud compute instances create pkmn-t3-table-1-a --zone=us-central1-a \
  --machine-type=g2-custom-24-49152 --accelerator=type=nvidia-l4,count=1 \
  --maintenance-policy=TERMINATE --provisioning-model=SPOT \
  --instance-termination-action=DELETE --image=pkmn-tourney-3 --boot-disk-type=pd-ssd

npm run pkmn -- set-tournament-status 3 running
```

Going `running` closes registration, activates the `#topbar` `● LIVE` banner, and streams live frames
to `/api/tournaments/3/stream`. Spot preemptions retry only the interrupted match with its original
PRNG `seed` (no forfeit) on a replacement VM.

### 7.4 Complete, Publish Replays & Tear Down (`completed`)

```sh
npm run pkmn -- set-tournament-status 3 completed
npm run pkmn -- publish-tournament-archive 3 /tmp/3-replays.7z

gcloud compute instances list --filter="name~'^pkmn-t3-'" \
  --format="csv[no-heading](name,zone)" | while IFS=, read -r name zone; do
  gcloud compute instances delete "$name" --zone="$zone" --quiet
done
gcloud compute images delete pkmn-tourney-3 --quiet
gcloud compute instances list && gcloud compute disks list   # confirm zero orphans
```
