# Tournament Operations Guide (`pkmn.ai`)

This runbook documents how scheduled Championship Tournaments are created, opened for competitor submissions, baked into isolated cloud GPU machine images, executed on Google Cloud `g2-custom-24-49152` Spot VMs, broadcast live on `pkmn.ai`, and archived.

---

## 1. Architecture & Rules Overview

Unlike the 24/7 continuous ladders on the M6 Mac mini (which time-slice two processes via `SIGSTOP`/`SIGCONT` and suppress battle logs to prevent ladder counter-scouting), Championship Tournaments operate in **TCEC / CCC Live Broadcast Mode**:

- **Naming Convention:** Titles follow `Tournament #<N>: <Format / Ruleset>` (for example, `Tournament #1: Gen 9 OU`, `Tournament #2: VGC 2026 Reg M-C OTS BO3`, `Tournament #3: VGC 2026 Reg M-D OTS BO3`) with sequential numeric IDs (`1`, `2`, `3`, …) served at `/arena/tournaments/<id>/`.
- **Site-Wide `[LIVE]` Banner:** Whenever a tournament is in `status = 'running'`, `pkmn.ai` automatically renders a top-of-page `#topbar` banner (`[LIVE] Tournament #<N>: ...`) linking to `/arena/tournaments/<id>/` across every static and SSR page on the site except pages that already carry the permanent `Under Construction` banner.
- **Submission Gating (Independent of Ladder Cooldowns):**
  - Any `'qualified'` Arena project may submit **at most 1 accepted (or pending) entry** per `'scheduled'` tournament via `/account/`.
  - Tournament submissions **must** be OCI container images (`package: 'oci'`) and bundle their own team(s) inside the container (either statically at `/teams/<format>.txt` or dynamically via `/utm <packed_team>` during the pre-game `|tournament|byot|...` handshake).
  - Tournament submissions are **never** blocked by the 14-day ladder cooldown or unsettled ladder Challenger gates—and submitting to a tournament never triggers a 14-day ladder cooldown or blocks subsequent ladder submissions.
  - If a tournament submission **fails** its smoke test (`smoke_status = 'failed'`), the project may immediately fix and resubmit before registration closes. Once an entry passes (`smoke_status = 'passed'`), it is locked into `tournament_entrants`.
- **Dedicated Cloud GPU Hardware (`1 Agent per VM`, `$1.00/hr` per Match Table):**
  - Each match table pairs **two** dedicated Google Cloud `g2-custom-24-49152` Spot VMs (`1× NVIDIA L4 24 GB GDDR6`, `24 vCPUs` / 12 physical Sapphire Rapids cores, `48 GB DDR5 RAM` per agent; `~$0.50/hr` Spot per VM).
  - Running 1 agent per `g2-custom-24-49152` VM unlocks GCP's custom 24-vCPU G2 shape (multi-GPU G2 shapes hard-cap at 12 vCPUs/GPU), isolates opponents across separate KVM hypervisor guests without cgroup carving, and minimizes Spot preemption blast radius to a single in-flight game.
  - Both agents compute concurrently (`ARENA_PONDER=1`) with intra-turn and mid-turn switch pondering enabled; choice cancelling remains disabled.

---

## 2. Opening a Tournament for Submissions (`status = 'scheduled'`)

Run `pkmn create-tournament` on the `pkmn.ai` host (or locally against `db/data/arena.sqlite` when testing):

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

What this does immediately:
1. Inserts row `id = '3'` into `tournaments` with `status = 'scheduled'` and re-renders `/arena/` (adding the `Scheduled` entry under **Tournaments**) and `/arena/tournaments/3/`.
2. Exposes a `Tournaments` row on `/account/` for every `'qualified'` project. Even if a project's ladder checkboxes are currently disabled by a 14-day cooldown or an unsettled Challenger, the tournament checkbox remains enabled (`OCI` package auto-selected).
3. Queues incoming tournament submissions in `/api/arena/pending-submissions` (`tournaments: ["3"]`). When the smoke-test worker posts `POST /api/arena/submission-status` with `smokeStatus: "passed"`, SQLite atomically registers `(tournament_id = '3', agent_id, version_id)` in `tournament_entrants`.

### Local Development Testing

To inspect the tournament banner and `/account/` tournament submission states locally:

```sh
# Seed db/data/arena.sqlite with Tournament #1 (completed), #2 (running), and #3 (scheduled)
npm run mock -- seed

# Start the local server with multi-persona dev auth (?as=scheibo, ?as=pmariglia, etc.)
DEV_AUTH=1 npm run dev
```

- Visit `http://localhost:1234/` or `http://localhost:1234/arena/` to see `[LIVE] Tournament #2: VGC 2026 Reg M-C OTS BO3` in `#topbar` (while `http://localhost:1234/background/` retains its `Under Construction` `#topbar`).
- Visit `http://localhost:1234/account?as=scheibo` to test submitting to `Tournament #3` while ladder checkboxes are on 14-day cooldown, or `http://localhost:1234/account?as=pmariglia` to test submitting while ladders are also open.

---

## 3. Freezing Entrants & Baking the Custom Machine Image

Once the submission deadline arrives (typically Friday afternoon before a weekend event):

### Step 3.1: Seed Entrants by Pre-Tournament Conservative Rating

Assign 1-based Berger pairing seeds (`1 .. E`) ordered by each project's pre-tournament conservative ladder rating (`Elo - 1.96 * SE` on the matching format ladder):

```sh
npm run pkmn -- seed-tournament 3
```

Verify the locked roster in `public/arena/tournaments/3/index.json` (or `sqlite3 /var/lib/pkmn/arena.sqlite "SELECT seed, agent_id, version_id FROM tournament_entrants WHERE tournament_id = '3' ORDER BY seed"`).

### Step 3.2: Unpack OCI Entrants & Smoke-Test on a Single Staging VM

Provision **one** temporary `g2-custom-24-49152` staging VM with a `pd-ssd` boot disk (`200 GB`), NVIDIA L4 drivers, `bubblewrap` (`bwrap`), `skopeo`, `umoci`, and `/opt/arena/bin/{tourney-bot,tourney-relay}` installed:

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

On `pkmn-tourney-bake`, pull and rootlessly unpack every entrant's pinned `sha256` OCI manifest—no Docker or Podman daemon is installed:

```sh
# For each entrant (<slug>-<version>, <oci_ref>@sha256:<digest>):
skopeo copy "docker://${OCI_REF}@sha256:${SHA256}" "oci:/tmp/oci-${BOT_ID}:latest"
mkdir -p "/opt/arena/bots/${BOT_ID}"
umoci unpack --rootless --image "/tmp/oci-${BOT_ID}:latest" "/opt/arena/bots/${BOT_ID}"
rm -rf "/tmp/oci-${BOT_ID}"
```

Verify each entrant before snapshotting:
1. Uncompressed resident size under `/opt/arena/bots/${BOT_ID}/rootfs` satisfies the packaging cap (`du -sb`).
2. Either `/teams/<format>.txt` inside `rootfs` validates cleanly via `@pkmn/sim`'s `TeamValidator`, or the agent responds to `|tournament|byot|<format>|Smoke Opponent` with a legal `/utm <packed_team>` within `5.0s`.
3. A 5-turn test game inside `/opt/arena/bin/tourney-bot ${BOT_ID}` (`bwrap --unshare-all` with `--unshare-net`, read-only `rootfs`, `/dev/nvidia*` bound, `choom -n 500`, `swapoff -a`) completes cleanly and emits `ARENA_TURN_MS=<ms>` timing lines from `tourney-relay`.

Stop the staging VM and snapshot its disk into an immutable **GCP Custom Machine Image**:

```sh
gcloud compute instances stop pkmn-tourney-bake --zone=us-central1-a
gcloud compute images create pkmn-tourney-3 \
  --source-disk=pkmn-tourney-bake \
  --source-disk-zone=us-central1-a \
  --storage-location=us
gcloud compute instances delete pkmn-tourney-bake --zone=us-central1-a --quiet
```

Because every entrant's unpacked `rootfs` is pre-baked onto `pkmn-tourney-3`, worker VMs boot ready to play in **< 25 seconds** with zero container pulls or registry dependencies during the live broadcast.

---

## 4. Provisioning Spot GPU Tables & Going Live (`status = 'running'`)

### Step 4.1: Provision $2K$ Worker VMs Across G2 Zones

For $K$ parallel match tables (for example, $K = 4$ tables = $8$ VMs at `$4.00/hr` total Spot), provision `pkmn-t3-table-<1..K>-<a|b>` across prioritized NVIDIA L4 zones (`us-central1-a`, `us-central1-b`, `us-central1-c`, `us-east4-a`, `us-east4-c`, `us-west1-b`):

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

Firewall & SSH posture:
- Worker VMs allow inbound TCP `22` **only** from the `pkmn.ai` coordinator IP and have `--unshare-net` inside `bwrap`, so untrusted agent code has zero network interfaces (cannot reach the internet, VPC, or `169.254.169.254` metadata).
- Local turn clocks are measured on the worker VM itself by `/opt/arena/bin/tourney-relay` (`CLOCK_MONOTONIC` from `|inactive|Time left:` write to choice `\n` read), so SSH RTT between `pkmn.ai` and GCP adds **0.0 ms** to agent clocks.

### Step 4.2: Flip Tournament Status to `'running'`

Once the pre-generated Berger round-robin `tournament_games` schedule (with deterministic PRNG seeds) is loaded and SSH `ControlMaster` sockets to the $2K$ VMs are healthy, flip the tournament live:

```sh
npm run pkmn -- set-tournament-status 3 running
```

What happens automatically:
1. Registration for `Tournament #3` closes on `/account/`.
2. `renderArenaPages` + `syncStaticLiveBanner` inject the `[LIVE] Tournament #3: VGC 2026 Reg M-D OTS BO3` `#topbar` banner across all static `.dj` pages (`public/index.html`, `/rules/`, `/glossary/`, etc.) and Arena/Project pages, while dynamic `/account/` and `/wiki/` routes pick up `db.getRunningTournament()` immediately.
3. Table 1 streams live omniscient Showdown protocol frames + remaining clocks to `/arena/tournaments/3/` (`public/api/tournament-live.json`).

---

## 5. Handling Spot VM Preemptions Mid-Tournament

GCP Spot VMs can be reclaimed at any time with a 30-second notice. Preemptions **never** cause forfeits:

1. **Detection:** `/opt/arena/bin/tourney-bot` polls `http://metadata.google.internal/computeMetadata/v1/instance/preempted` every second and prints `ARENA_SPOT_PREEMPTED` to `stderr` before exiting (supplemented by checking GCE instance status if `ssh` exits with transport code `255`).
2. **Zero-Penalty Game Reset:** The coordinator leaves all previously completed games untouched, resets the single interrupted `in_progress` game back to `pending` (preserving its pre-committed PRNG `seed`), and terminates the opponent's sandboxed process on the sibling VM so both sides restart that game cleanly.
3. **Multi-Zone Replacement:** The healer immediately spawns a replacement `g2-custom-24-49152` Spot VM from `pkmn-tourney-3` in the next available zone from `[us-central1-a, us-central1-b, us-central1-c, us-east4-a, us-east4-c, us-west1-b]`, falling back to `--provisioning-model=STANDARD` (On-Demand) only if all six Spot pools are simultaneously exhausted.

---

## 6. Completing the Event & Tearing Down Cloud Resources (`status = 'completed'`)

After the Round-Robin (and optional 100-game Superfinal between `#1` and `#2`) finishes:

1. **Finalize Standings & Remove the `[LIVE]` Banner:**
   ```sh
   npm run pkmn -- set-tournament-status 3 completed
   ```
   This sets `status = 'completed'` and `completed_at`, strips the `[LIVE]` `#topbar` banner across `public/`, moves `Tournament #3` into the completed **Tournaments** table on `/arena/`, and writes the final `/arena/tournaments/3/index.html` and `/arena/tournaments/3/index.json` artifacts.
2. **Publish Replay Archive:** Compress all omniscient `.log` files (including full team sheets and per-turn `|c|` policy distributions) into a `.7z` archive (`@pkmn/stats/tools/compress` layout), back up to `gs://pkmn-arena/tournaments/3/`, and publish it via the operator CLI or authenticated `PUT /api/arena/tournaments/3/archive` endpoint so `/arena/tournaments/3/` and `/arena/tournaments/3.json` surface `3-replays.7z`:
   ```sh
   npm run pkmn -- publish-tournament-archive 3 /tmp/3-replays.7z
   # or remotely from the coordinator:
   curl -fsS -X PUT https://pkmn.ai/api/arena/tournaments/3/archive \
     -H "Authorization: Bearer $ARENA_SECRET" \
     -H "X-Content-SHA256: $(shasum -a 256 /tmp/3-replays.7z | awk '{print $1}')" \
     --data-binary @/tmp/3-replays.7z
   ```
3. **Delete All Worker VMs & Staging Image (Drop Cloud Spend to `$0.00/hr`):**
   ```sh
   # Delete all pkmn-t3-* worker instances across zones
   gcloud compute instances list --filter="name~'^pkmn-t3-'" \
     --format="csv[no-heading](name,zone)" | while IFS=, read -r name zone; do
     gcloud compute instances delete "$name" --zone="$zone" --quiet
   done

   # Optionally delete the custom machine image once archived
   gcloud compute images delete pkmn-tourney-3 --quiet
   ```
   Verify zero lingering GPU instances or orphaned `pd-ssd` disks remain with `gcloud compute instances list` and `gcloud compute disks list`.
