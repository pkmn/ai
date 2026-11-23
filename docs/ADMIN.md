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
| `refund-cooldown <slug>` | Clear the 14-day submission cooldown and 24h failed smoke-test budget on `<slug>`. |
| `set-smoke-cadence <n> [--every <k>]` | Set max ladder smoke tests per coordinator cycle (`0` pauses) and cycle interval `k` (default `1`). |
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
| `announce [--dry-run] [--channel <id>]` | Validate/resolve `@` mentions and post a stdin announcement to Discord (`--dry-run` DMs `staff:`). |
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
       owners:
         pmariglia: pmariglia.249812
   ```
   - Newly registered projects start `Pending`: unlocks `/account/` (Discord linking + 1 OCI
     entry per `scheduled` tournament) and `/wiki` editing; continuous ladders stay disabled until
     staff grant slots in SQLite.
   - `pkmn set-ladders` grants per-slot eligibility (`rby`, `adv`, `sv`, `rand`, `vgc`, `all`, or
     `none`), preserved across seasonal rotations; revoking a slot only blocks future submissions.
3. **Deploy or sync manually, then grant ladder slots:**
   ```sh
   npm run pkmn -- sync-projects            # verifies Smogon IDs/ban status
   npm run pkmn -- sync-projects --offline  # YAML-only sync
   npm run pkmn -- set-ladders magpie rby adv
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
npm run pkmn -- set-smoke-cadence 1 --every 5   # throttle to 1 smoke test every 5 matches
npm run pkmn -- set-smoke-cadence 3             # burst up to 3 smoke tests per cycle
npm run pkmn -- set-smoke-cadence 0             # pause smoke-test ingestion temporarily
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
  pass/failure or quarantine.
- DM `staff:` (6h per-key dedup) on quarantines, stale Arena heartbeats (`> 15m` + recovery), low
  VPS/Arena disk, backup failures, `/Volumes/Archive` unmounts, `.7z`/archive failures, smoke infra
  errors, repeated sync failures, and unexpected `pkmn.ai-server` exits (`ExecStopPost` ->
  `pkmn notify-staff`). Mac mini relays alerts via `POST /api/arena/alert` (`Bearer $ARENA_SECRET`).

Manual one-shot sync: `node --env-file-if-exists=.env build/server/discord`.

**Announcements (`pkmn announce`):** Reads Markdown from stdin to EOF, validates and resolves
`@member` / `@role` mentions (plus `<@id>`, `<@&id>`, `<#id>`) against the live guild, enforces
Discord's 2000-character limit, and posts to `config.channel` (or DMs `staff:` with `--dry-run`):

```sh
# Preview via staff DM first, then post to the guild channel:
npm run pkmn -- announce --dry-run <<'EOF'
**🏛️ Announcement Title**

Body with @Competitor and @pkmn mentions.
EOF
```

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

## 8. Host Telemetry & System Metrics (`server/system.ts`)

Both hosts collect unprivileged system telemetry (no `sudo`, compatible with `pkmn.ai-server`'s
`ProtectSystem=strict` / `NoNewPrivileges=yes`). On the VPS, local metrics are sampled on demand
when queried (zero idle overhead). On the Arena Mac mini, there are **zero `setInterval` timers**:
sub-millisecond in-process metrics piggyback on paused-turn heartbeats, subprocess probes run
strictly between matches/idle, and heavy daily maintenance (`archive.sh` + `softwareupdate`) runs
under `ai.pkmn.maintenance.plist` (`10:00 UTC`) while matchmaking is paused via `maintenance.lock` /
`match.lock`. Arena heartbeats only attach `system` when telemetry changes (or after a drop), and
`server/arena.ts` never exposes host telemetry on public `/api/live.json` or `/api/battles/stream`.

### `pkmn.ai` VPS (`VpsHostMonitor` & `TrafficTracker`)

| Metric | Avg Cost | When Fetched | What It Measures | Concerning Value |
| :--- | :--- | :--- | :--- | :--- |
| **Load & Uptime** | `< 0.1 ms` | On demand (render / SSE ≥ 3s) | `os.loadavg()` (1m/5m/15m), vCPU count, host & Node process uptime. | `load1 > vCPUs` (warn), `> 1.5x vCPUs` (crit), or unexpected process restart. |
| **Memory, Swap & RSS** | `~0.2 ms` | On demand | `/proc/meminfo` (`MemTotal - MemAvailable`), swap used/total, Node RSS. | RAM ≥ 80% (warn) / ≥ 90% (crit), swap ≥ 75%, or steadily climbing RSS. |
| **Disk Usage, I/O & SQLite** | `~0.3 ms` | On demand | `statfsSync('/')`, `/proc/diskstats` R/W MB/s, IOPS & `% busy`, `arena.sqlite` + `-wal` sizes. | `/` ≥ 80% (warn) / ≥ 90% (crit), sustained high `% busy`, or unbounded `-wal` growth. |
| **Internal Network** | `~0.2 ms` | On demand | `/proc/net/tcp` check that Arena reverse SSH tunnel `127.0.0.1:2222` is listening. | Not listening (Mac mini tunnel disconnected). |
| **External Network** | `~0.2 ms` NIC / `~20 ms` probe | NIC on demand; probe every **15m** async | `/proc/net/dev` primary NIC RX/TX rate & error/drop counts; `HEAD https://api.github.com/zen` RTT. | NIC errors `> 0`, probe down/5xx, or RTT `> 500 ms`. |
| **TLS Certificate** | `~1 ms` | On boot + every **6h** | `X509Certificate` expiry on `/etc/letsencrypt/live/pkmn.ai/fullchain.pem`. | `< 14d` remaining (`snap.certbot.renew.timer` failing; renewals normally run at 30d). |
| **Traffic & Concurrent Users** | `< 0.01 ms`/req | Continuous O(1) middleware (excl. `/api/arena/*` & `/admin*`) | Unique visitors (5m), active SSE viewers (battles/tournaments/admin), req/1m & req/1h, mean & p95 non-SSE latency. | Sudden p95 spike (`> 200–500 ms`) or anomalous req/m flood. |
| **Error Rates & 24h Faults** | `~0.3 ms` | On demand (indexed `matches` scan) | 1h HTTP `5xx`, `4xx`, `429` counts + last `5xx` path; 24h Arena match fault rate (`timeout`/`crash`/`oom`/`invalid-choice`). | Any `5xx > 0`, surge in `429`, or 24h fault rate `> 5%`. |
| **Daily SQLite Backup** | `~0.2 ms` | On boot, then stops once today's `10:00 UTC` backup succeeds; retries every **5m** after `10:00 UTC` | Newest `/var/lib/pkmn/backups/arena-*.sqlite.zst` timestamp, size, and retained count (30d). | Age `> 26h` or `none found` (`pkmn.ai-backup.service` failed). |
| **Pending OS Updates** | `~0.1 ms` | On demand | `/var/lib/update-notifier/updates-available` counts + `/var/run/reboot-required`. | Any pending security updates or `Reboot required`. |

### Arena Host — Mac mini (`ArenaHostMonitor` & `maintenance.sh`)

| Metric | Avg Cost | When Fetched | What It Measures | Concerning Value |
| :--- | :--- | :--- | :--- | :--- |
| **Instant Host & Disk Space** | `~0.04 ms` (0 subprocesses) | Between paused turns on heartbeat (≥ **60s**) & between matches | `os.loadavg()`, host/proc uptime, Node RSS, `statfsSync` on `/` & `/Volumes/Archive` mount/space, local state DB + `-wal`, outbox count, daemon cycle errors. | `/Volumes/Archive` `UNMOUNTED`, disk ≥ 80% / ≥ 90%, `load1 > cores`, `outbox > 0`, or `daemonErrors > 0`. |
| **Memory, Pressure, Disk I/O & NIC** | `~55 ms` warm (`Promise.all`, 4 procs) | Between matches / idle only (≥ **60s**); `diskutil`/`route` cached once (`~525 ms`/`~154 ms` cold) | `vm_stat` real macOS RAM, combined `sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level`, `iostat -Id` per-disk MB/s & IOPS (`/` & Archive), `netstat -ibn` RX/TX & errors. | RAM ≥ 80% / ≥ 90%, swap growing, VM pressure `warning`/`critical`, NIC errors `> 0`, or stalled Archive I/O. |
| **Internal Tunnel RTT** | `0 ms` overhead | Inline on every `POST /api/arena/heartbeat` | Round-trip latency and reachability over `127.0.0.1:1234` SSH tunnel to `pkmn.ai`. | Tunnel `down`, RTT `> 250 ms`, or last heartbeat `> 15m` (watchdog stale). |
| **External Net & Podman VM** | `~50–150 ms` | Between matches / idle only (≥ **15m**) | `HEAD https://ghcr.io/v2/` RTT + reachability; `podman machine inspect` state for `podman-machine-default`. | `ghcr.io` unreachable (OCI pulls fail) or Podman state `!= running`. |
| **Daily Backup & GCS Archive** | `~1–10 ms` | On boot, then stops once today's `10:00 UTC` run succeeds; retries every **5m** between matches after `10:00 UTC` | `/opt/arena/state/archive-status.json` (written by `archive.sh`) + `/Volumes/Archive/db-backups/` scan for local DB backup & `gcloud storage rsync` status. | Any `archiveError`, DB backup `> 26h`, or GCS sync `> 36h`. |
| **Pending macOS Updates** | `5–30s` at `10:00 UTC` (`< 0.1 ms` read) | Once daily in `10:00 UTC` `maintenance.sh` while matches are paused | Non-fatal `softwareupdate --list` stashed in `/opt/arena/state/updates-status.json` (pending count, labels, restart flag). | Updates pending or `Reboot required` (schedule a drain window to apply). |
