# Administration

This runbook covers all **application-level** operator workflows for **pkmn.ai**: deploying updates,
onboarding and managing projects, moderating submissions, provisioning `harvested` ladder team
pools on the Mac mini Arena runner, managing ladder lifecycles and seasonal rotations, syncing
Discord roles, and running cloud-GPU Championship Tournaments.

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
  `/var/lib/pkmn` exists or `NODE_ENV=production`, and `db/data/arena.sqlite` locally (override with
  `ARENA_DB_PATH=/path/to/arena.sqlite`, or pass `MOCK=1` locally to read `.mock/` overlays).
- **Live concurrency & static re-renders:** SQLite runs in WAL mode with `busy_timeout = 5000` ms,
  so `pkmn` commands can run safely alongside the live `pkmn.ai-server` process and automatically
  re-render affected static HTML and `.json` pages into `public/`.

| Command | Purpose |
| :--- | :--- |
| `lookup-smogon <username\|slug.id\|id\|url>` | Resolve a Smogon forum user's immutable numeric XenForo ID and ban status. |
| `sync-projects [--projects <path>] [--offline]` | Sync `arena:` blocks from `static/projects.yml` into SQLite (`agents` & `developers`). |
| `reassign-developer <github> <slug\|--none> [...]` | Move a developer's GitHub login to another project (or remove with `--none`) in `projects.yml` + SQLite. |
| `quarantine <agent-slug> <version> [--reason "..."]` | Quarantine a misbehaving agent version across ladders and re-render leaderboards. |
| `unquarantine <agent-slug> <version>` | Restore a quarantined version to active competition and re-render leaderboards. |
| `refund-cooldown <agent-slug>` | Clear the 14-day submission cooldown on `<agent-slug>`. |
| `set-anchor <ladder_id> <agent-slug> <version>` | Pin `<agent-slug>@<version>` to `1500` Elo on `<ladder_id>` and recompute ratings. |
| `set-ladder-status <ladder_id> <status>` | Set `<ladder_id>` to `upcoming`, `active`, `settling`, or `archived`. |
| `rotate-ladder <old_id> --name "..." [--new <id> ...]` | Transition `<old_id>` into `settling`/`archived` under its historical name and optionally open `<new_id>`. |
| `publish-ladder-archive <ladder_id> <archive.7z>` | Publish `<ladder_id>-logs.7z` (and `teams.json`) for an `archived` `pools` ladder. |
| `create-tournament <id> --name "..." --format <fmt> ...` | Create or update a Championship Tournament (`scheduled`, `running`, or `completed`). |
| `seed-tournament <id>` | Lock tournament entrants and assign 1-based Berger seeds by conservative ladder rating. |
| `set-tournament-status <id> <status>` | Flip tournament `<id>` to `scheduled`, `running` (enables `#topbar` `[LIVE]` banner), or `completed`. |
| `publish-tournament-archive <id> <archive.7z>` | Publish `<id>-replays.7z` for a `completed` tournament. |
| `render` | Force a full static HTML/JSON re-render of all Arena and project profile views in `public/`. |
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

*(Uses `SMOGON_TOKEN` from `.env` if set, falling back to public XenForo member profile lookup.)*

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
that an owner's Smogon account is banned (`banned = 1`), submission eligibility is automatically
blocked until resolved.

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
`gen3ou20261109`, `SV` / `gen9ou20261109`) **do not upload teams to the `pkmn.ai` web server**.
Because `pkmn.ai` never executes battles and static harvested pools must remain private to prevent
counter-scouting, harvested team pools live **exclusively on the M6 Mac mini Arena runner** at
`/opt/arena/teams/<ladder_id>.txt`.

### File Format (`/opt/arena/teams/<ladder_id>.txt`)

Each `harvested` ladder uses a **single UTF-8 text file** named after its immutable `ladder_id` from
`config/ladders.yml` (for example, `gen1ou20261109.txt`, `gen3ou20261109.txt`, `gen9ou20261109.txt`),
containing **one packed team per line**:

- Every line must be a single legal 6-Pokémon team in Pokémon Showdown **packed** format
  (`NICKNAME|SPECIES|ITEM|ABILITY|MOVES|NATURE|EVS|GENDER|IVS|SHINY|LEVEL|...` joined by `]`), with
  no blank lines or `===` headers.
- Before writing `<ladder_id>.txt`, validate each team against `@pkmn/sim`'s
  `new TeamValidator(format).validateTeam(team)` and canonicalize + pack via `@pkmn/sets`
  (`new Team(Team.canonicalize(sets, dex), dex).pack()`).
- Each pool file must contain at least 2 non-mirror teams (in practice, hundreds of high-ladder
  teams so 2-game blind-pair matches sample diverse matchups without 6-species mirrors).

### Uploading via `rsync` to the Mac mini

`rsync` the `<ladder_id>.txt` files (along with any era-matched read-only `@pkmn/stats` /
`randbats` JSON files mounted into agent sandboxes at `$PKMN_STATS_DIR/<ladder_id>/`) directly to
the Mac mini:

```sh
# 1. Ensure destination directories exist on the Mac mini (`arena` SSH host)
ssh arena 'mkdir -p /opt/arena/teams /opt/arena/stats'

# 2. Upload single-file packed team pools (one packed team per line)
rsync -avz \
  gen1ou20261109.txt \
  gen3ou20261109.txt \
  gen9ou20261109.txt \
  arena:/opt/arena/teams/

# 3. Lock permissions so only the coordinator user (`pkmn`) can read `/opt/arena/teams/`
#    (sandboxed `p1`/`p2` agent users must never have read access to harvested pools)
ssh arena 'chmod 750 /opt/arena/teams && chmod 640 /opt/arena/teams/*.txt && wc -l /opt/arena/teams/*.txt'

# 4. (Optional) Upload era-matched read-only usage/randbats stats for agent sandboxes
#    - Constructed ladders (`RBY`, `ADV`, `SV`, `VGC`): stats.json
#    - Random Battle ladders (`RAND`): data.json, full.json, sets.json
rsync -avz stats/ arena:/opt/arena/stats/
ssh arena 'chmod -R a+rX /opt/arena/stats'
```

> [!NOTE]
> **How `pools` ladders (`VGC`) differ:** Ladders with `team: pools` do not use
> `/opt/arena/teams/<ladder_id>.txt`. Instead, competitors submit their 20-team seasonal roster on
> `/account/`, which `pkmn.ai` validates against the public blocklist directories configured under
> `pools:` in `config/ladders.yml` (`teams/teams/...`, `teams/pkmn_stuff/...`, `teams/vgc.bot/...`)
> and stores in SQLite (`agent_ladder_teams`) for the Mac mini to pull via
> `GET /api/arena/pending-submissions`.

---

## 5. Ladder Lifecycle, Anchors, Rotation & Archives

### Opening or Updating Ladder Status

At launch (or when pausing/retiring a ladder manually), update `status:` in `config/ladders.yml`
**and** apply the status transition in SQLite:

```sh
npm run pkmn -- set-ladder-status gen1ou20261109 active
npm run pkmn -- set-ladder-status gen3ou20261109 active
npm run pkmn -- set-ladder-status gen9ou20261109 active
npm run pkmn -- set-ladder-status gen9randombattle20261109 active
npm run pkmn -- set-ladder-status gen9championsvgc2026regmc active
```

Valid statuses are `upcoming` -> `active` -> `settling` -> `archived`. Always commit the matching
`status:` update in `config/ladders.yml` so future server restarts stay consistent (`syncLadders`
automatically avoids regressing a `settling` ladder back from `archived` once it finishes settling).

### Setting 1500-Elo Gauge Anchors

Once a ladder's designated anchor version (for example, `Metamon` `1.0.0` on `RBY` or `Foul Play`
`1.0.0` on `ADV`/`SV`/`RAND`) passes smoke testing and enters the ladder, pin its rating to `1500`
Elo:

```sh
npm run pkmn -- set-anchor gen1ou20261109 metamon 1.0.0
npm run pkmn -- set-anchor gen3ou20261109 foul-play 1.0.0
npm run pkmn -- set-anchor gen9ou20261109 foul-play 1.0.0
npm run pkmn -- set-anchor gen9randombattle20261109 foul-play 1.0.0
```

### Rotating a Seasonal or Epoch Ladder

When a new VGC regulation begins (or a permanent format undergoes a new epoch):

1. If the new ladder uses `team: harvested`, first `rsync` `/opt/arena/teams/<new_ladder_id>.txt`
   (and `/opt/arena/stats/<new_ladder_id>/`) to the Mac mini. If it uses `team: pools`, add the new
   reference blocklist directories under `teams/` and `config/ladders.yml`.
2. Run `rotate-ladder` on `pkmn.ai`:

```sh
npm run pkmn -- rotate-ladder gen9championsvgc2026regmc \
  --name "VGC 2026 Reg M-C" \
  --new gen9championsvgc2026regmd \
  --new-name "VGC" \
  --format gen9championsvgc2026regmd \
  --team pools \
  --min 4 \
  --teams 20
```

What `rotate-ladder` does atomically:
- Renames the outgoing ladder to `"VGC 2026 Reg M-C"`. If at least `min` distinct active projects
  still have unsettled versions (`matches < 25` or `SE > 30`), it enters `settling` (closing new
  submissions while finishing remaining settlement matches before automatically transitioning to
  `archived`); otherwise it transitions immediately to `archived` and marks its entries `retired`.
- Creates/activates `gen9championsvgc2026regmd` under the `vgc` URL slot (`/arena/ladders/vgc/`).
- Update `config/ladders.yml` to record the archived/settling entry alongside the new `active`
  entry, then commit and deploy.

### Publishing Retired `pools` Ladder Archives (`<ladder_id>-logs.7z`)

Continuous `harvested` and `random` ladders never publish battle logs or team sheets. For
competitor-submitted `pools` ladders (`VGC`), full battle logs (`<ladder_id>-logs.7z`) and
`teams.json` may be published **strictly after** the ladder reaches `status = 'archived'`:

```sh
# Option A: Local file on pkmn.ai
npm run pkmn -- publish-ladder-archive gen9championsvgc2026regmc /tmp/gen9championsvgc2026regmc-logs.7z

# Option B: Remote upload from the Mac mini over HTTPS / tunnel
curl -fsS -X PUT https://pkmn.ai/api/arena/ladders/gen9championsvgc2026regmc/archive \
  -H "Authorization: Bearer $ARENA_SECRET" \
  -H "X-Content-SHA256: $(shasum -a 256 gen9championsvgc2026regmc-logs.7z | awk '{print $1}')" \
  --data-binary @gen9championsvgc2026regmc-logs.7z
```

Both paths atomically write `public/arena/ladders/<ladder_id>/<ladder_id>-logs.7z`, emit
`public/arena/ladders/<ladder_id>/teams.json`, and re-render the archived ladder and battle history
links.

---

## 6. Discord Sync & Wiki Administration

### Discord Roles, Pins, Alerts & One-Shot Sync

`server/discord.ts` runs inside `pkmn.ai-server` every 60 seconds in production (`NODE_ENV=production`):
- Syncs guild membership into SQLite (`discord_members`) for `/auth/discord/validate` (`/chat/logs`
  access) and `/account/` eligibility checks.
- Syncs native Arena `#1` leaderboard roles (configured via `discord:` role IDs in
  `config/ladders.yml`) and the `competitor` role (`config/discord.yml`), plus external partner
  leaderboard roles (`ladders:`, `agents:`, `authors:` in `config/discord.yml` using
  `VGC_BOT_TOKEN`).
- Enforces channel pinned messages (`pins:` in `config/discord.yml`), archives `#general` chat logs
  into `chat/logs/YYYY-MM-DD.txt`, and DMs developers on smoke-test pass/fail/quarantine and staff
  (`staff:` in `config/discord.yml`) if the Mac mini heartbeats go stale (`> 15` minutes).

To trigger an immediate one-shot Discord sync outside the 60-second loop:

```sh
cd /home/pkmn/ai
node --env-file-if-exists=.env build/server/discord
```

### Wiki Administration (`server/wiki.ts`)

- Site-wide wiki administrators (`ADMINS`) and GitHub-to-Smogon revision display-name overrides
  (`AUTHORS`) are defined at the top of `server/wiki.ts`. Wiki admins can edit any registered
  project page (`/wiki/<Project_Name>`) regardless of project ownership.
- Registered project wiki pages support three read-visibility tiers via an optional first-line
  directive: `{% visibility: developers %}` (default for project pages),
  `{% visibility: discord %}`, or `{% visibility: public %}` (always used for non-project pages).

---

## 7. Championship Tournament Operations

Unlike continuous ladders on the Mac mini (which time-slice processes and hide logs), scheduled
Championship Tournaments run on isolated Google Cloud `g2-custom-24-49152` Spot GPU VMs (`1× NVIDIA
L4 24 GB`, `24 vCPUs`, `48 GB RAM` per agent) in **live broadcast mode** (`ARENA_PONDER=1`, public
teams and `.log` replays).

- **Naming & URLs:** Titles follow `Tournament #<N>: <Format / Ruleset>` with sequential numeric IDs
  (`1`, `2`, `3`, …) served at `/arena/tournaments/<id>/`.
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
  --rules '["Open Team Sheets","Best-of-3"]' \
  --games 50 \
  --batch 10 \
  --tables 4 \
  --starts 2026-12-12T18:00:00Z \
  --status scheduled
```

This creates `/arena/tournaments/3/`, lists the event under **Tournaments** on `/arena/`, and
exposes the tournament checkbox on `/account/` for all registered (`Pending` and `qualified`)
projects.

### Step 7.2: Seed Entrants & Bake the Custom Machine Image

Once the submission deadline arrives, lock entrants and assign 1-based Berger pairing seeds ordered
by pre-tournament conservative ladder rating (`Elo - 1.96 * SE`):

```sh
npm run pkmn -- seed-tournament 3
sqlite3 /var/lib/pkmn/arena.sqlite \
  "SELECT seed, agent_id, version_id FROM tournament_entrants WHERE tournament_id = '3' ORDER BY seed"
```

Provision one staging `g2-custom-24-49152` VM (`200 GB` `pd-ssd`, NVIDIA L4 drivers, `bwrap`,
`skopeo`, `umoci`, and `/opt/arena/bin/` tournament runner binaries):

```sh
gcloud compute instances create pkmn-tourney-bake \
  --zone=us-central1-a \
  --machine-type=g2-custom-24-49152 \
  --accelerator=type=nvidia-l4,count=1 \
  --maintenance-policy=TERMINATE \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-type=pd-ssd \
  --boot-disk-size=200GB
```

On `pkmn-tourney-bake`, rootlessly unpack each entrant's pinned `sha256` OCI image, verify its
resident size cap, static `/teams/<format>.txt` or dynamic `|tournament|byot|<format>|...` -> `/utm`
response, and a 5-turn isolated `bwrap --unshare-all` smoke game, then snapshot the VM into a
custom GCP image:

```sh
skopeo copy "docker://${OCI_REF}@sha256:${SHA256}" "oci:/tmp/oci-${AGENT_ID}:latest"
mkdir -p "/opt/arena/agents/${AGENT_ID}"
umoci unpack --rootless --image "/tmp/oci-${AGENT_ID}:latest" "/opt/arena/agents/${AGENT_ID}"
rm -rf "/tmp/oci-${AGENT_ID}"

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

Once SSH `ControlMaster` sockets and the Berger `tournament_games` schedule are ready, flip the
tournament live:

```sh
npm run pkmn -- set-tournament-status 3 running
```

Registration closes on `/account/`, the site-wide `[LIVE] Tournament #3: ...` `#topbar` banner is
injected across `pkmn.ai`, and live Showdown frames stream to `/arena/tournaments/3/`
(`public/api/tournament-live.json`). Spot preemptions reset only the single interrupted
`in_progress` game back to `pending` (preserving its PRNG `seed`) and replace the VM in the next L4
zone with zero forfeit penalty.

### Step 7.4: Complete the Event, Publish Replays & Tear Down Cloud VMs (`completed`)

1. **Finalize standings and clear the `[LIVE]` banner:**

```sh
npm run pkmn -- set-tournament-status 3 completed
```

2. **Publish the `.7z` replay archive (`3-replays.7z`):**

```sh
npm run pkmn -- publish-tournament-archive 3 /tmp/3-replays.7z
# or upload remotely from the tournament coordinator:
curl -fsS -X PUT https://pkmn.ai/api/arena/tournaments/3/archive \
  -H "Authorization: Bearer $ARENA_SECRET" \
  -H "X-Content-SHA256: $(shasum -a 256 /tmp/3-replays.7z | awk '{print $1}')" \
  --data-binary @/tmp/3-replays.7z
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
