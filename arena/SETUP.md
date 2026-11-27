# Arena Mac mini M6 Setup & Deployment Guide

Step-by-step provisioning, verification, and ops for the dedicated **Apple M6 Mac mini**
(`pkmn@arena`) running continuous **pkmn.ai** ladder matches and smoke tests.

> [!IMPORTANT]
> **Tunnel First:** Run **Phase 1** (first boot + LAN SSH) and **Phase 2** (`ai.pkmn.tunnel`)
> **before** Homebrew, Podman, or `setup-arena.sh`:
> 1. Stock macOS already has `ssh`, `taskpolicy`, `dscl`, and `launchctl`.
> 2. Once Phase 2 passes, `ssh arena` works via `ProxyJump pkmn.ai` so you (or an AI agent) can run
>    **Phases 3–8** remotely.
> 3. `setup-arena.sh` binds `sshd` to `127.0.0.1:22` (disabling LAN SSH), so establishing the reverse
>    tunnel first avoids lockout.

## Topology & Key Paths

`Admin Laptop` --(`ssh arena`, `ProxyJump pkmn.ai:2222`)--> `pkmn.ai` (`sshd Match User tunnel`,
`pkmn.ai-server :1234`) <--(`ai.pkmn.tunnel`: `-L :1234`, `-R :2222`)-- `M6 Mac mini (pkmn@arena)`
(`sshd 127.0.0.1:22`, `ai.pkmn.arena`, `ai.pkmn.pf`, `/Volumes/{P1,P2,Staging,Archive}`).

| Path / Account | Value on `arena` | Purpose |
| :--- | :--- | :--- |
| Coordinator user | `pkmn` (group `agents`, GID `590`) | Owns `/opt/arena`, runs `ai.pkmn.{arena,tunnel}` and Podman VM. |
| Sandbox users | `p1` (UID `591`), `p2` (UID `592`) | Unprivileged accounts (GID `590`, `/usr/bin/false`), blocked by `pf`. |
| Repo & binaries | `/opt/arena/repo`, `/opt/arena/bin/{arena,limit}` | `pkmn/ai` checkout (`build/arena`, `.env`), lifecycle script, 14 GiB C supervisor. |
| Seatbelt & stats | `/opt/arena/etc/sandbox.sb`, `/opt/arena/stats/` | Native MAC profile; RO `data.pkmn.cc` stats (`PKMN_STATS_DIR=/opt/arena/stats`). |
| Agents, DB, logs | `/opt/arena/{agents,cas/sha256,state/arena.sqlite,logs}` | Unpacked bundles (`<= 500 MiB`, CoW CAS), local WAL DB, daemon logs. |
| Scratch / Staging | `/Volumes/P{1,2}` (`4G`), `/Volumes/Staging` (`6G`) | Quota-capped APFS volumes; `P{1,2}/scratch` (`0700` + ACLs) wiped every game. |
| External Archive | `/Volumes/Archive` (`1 TB` APFS) | Cold agents (`cold-agents/`), daily `.7z` logs (`logs/`), DB backups (`db-backups/`). |

---

## Phase 1: First Boot, Setup Assistant & LAN SSH

Connect power, Ethernet (`en0`), and a temporary display/keyboard/mouse:

1. **Setup Assistant:** Skip Accessibility, Migration, Apple ID/iCloud, Analytics, Screen Time, Siri,
   Apple Intelligence, and Location. Create admin account **`pkmn`** with a strong password.
   **Turn OFF FileVault** (otherwise unattended reboots halt at EFI unlock before `launchd` starts).
2. **System Settings:**
   - **Users & Groups -> Automatically log in: Off** (headless boot stops at login window, saving
     ~1.5 GB Unified Memory).
   - **Privacy & Security -> Full Disk Access:** Click `+`, press `Cmd+Shift+G`, and add
     `/usr/sbin/taskpolicy`, `/bin/bash`, and `/usr/bin/tar` *(keep display connected until Step 3.3
     to also add `/opt/homebrew/bin/node` and `gcloud`'s Python — macOS Sequoia+ TCC blocks
     headless `LaunchDaemons` from `/Volumes/Archive` even when SSH works)*.
3. **Terminal.app on Mac mini:**
   ```sh
   sudo scutil --set HostName arena
   sudo scutil --set LocalHostName arena
   sudo scutil --set ComputerName arena
   sudo systemsetup -setremotelogin on
   sudo pmset -a sleep 0 disksleep 0 displaysleep 0 autorestart 1 disablesleep 1
   ipconfig getifaddr en0 || ipconfig getifaddr en1
   ```
4. **From admin laptop** (install key & verify):
   ```sh
   ssh-copy-id pkmn@arena.local
   ssh -o ForwardAgent=no pkmn@arena.local \
     'uname -srm && scutil --get HostName && fdesetup status && sysctl -n hw.ncpu hw.memsize'
   ```
   *Expect:* `Darwin ... arm64`, `arena`, `FileVault is Off.`, `12`, `34359738368`.

---

## Phase 2: Bidirectional SSH Tunnel (`arena` <-> `pkmn.ai`)

`ai.pkmn.tunnel.plist` maintains `-L 127.0.0.1:1234:127.0.0.1:1234` (RPC to `pkmn.ai-server`) and
`-R 127.0.0.1:2222:127.0.0.1:22` (inbound SSH via `ProxyJump pkmn.ai`).

### 2.1 Prepare Mac mini (`ssh pkmn@arena.local`)

Get the droplet IP on your laptop (`ssh -G pkmn.ai | grep '^hostname '`), then run on `arena.local`:

```sh
if ! dscl . -read /Groups/agents >/dev/null 2>&1; then
  sudo dscl . -create /Groups/agents && sudo dscl . -create /Groups/agents PrimaryGroupID 590
fi
sudo dscl . -append /Groups/agents GroupMembership pkmn || true

sudo mkdir -p /opt/arena/logs
sudo chown -R pkmn:agents /opt/arena && sudo chmod 0755 /opt/arena && sudo chmod 0700 /opt/arena/logs

PKMN_AI_IP="<PKMN_AI_DROPLET_IP>"   # bypass Cloudflare proxy on port 22
grep -qw "pkmn.ai" /etc/hosts || printf '%s\tpkmn.ai\n' "$PKMN_AI_IP" | sudo tee -a /etc/hosts

mkdir -p ~/.ssh && chmod 700 ~/.ssh
[[ -f ~/.ssh/id_ed25519_tunnel ]] || ssh-keygen -t ed25519 -N "" -C "arena-tunnel" -f ~/.ssh/id_ed25519_tunnel
chmod 600 ~/.ssh/id_ed25519_tunnel ~/.ssh/authorized_keys 2>/dev/null || true
cat ~/.ssh/id_ed25519_tunnel.pub
```

### 2.2 Authorize Tunnel on `pkmn.ai` (`ssh pkmn@pkmn.ai`)

```sh
id -u tunnel >/dev/null 2>&1 || sudo adduser --system --no-create-home --shell /usr/sbin/nologin tunnel
sudo install -d -m 0755 /etc/ssh/authorized_keys
sudo tee /etc/ssh/authorized_keys/tunnel >/dev/null <<'EOF'
restrict,port-forwarding,permitopen="127.0.0.1:1234",permitlisten="127.0.0.1:2222" ssh-ed25519 <ARENA_TUNNEL_PUBKEY> arena-tunnel
EOF
sudo chmod 0644 /etc/ssh/authorized_keys/tunnel
sudo cp /home/pkmn/ai/arena/config/sshd-tunnel.conf /etc/ssh/sshd_config.d/arena-tunnel.conf
sudo /usr/sbin/sshd -t && sudo service ssh reload
```

### 2.3 Install `ai.pkmn.tunnel.plist` & Configure Laptop SSH

From your **admin laptop** (inside this repo):

```sh
scp arena/config/ai.pkmn.tunnel.plist pkmn@arena.local:/tmp/ai.pkmn.tunnel.plist
ssh -t pkmn@arena.local '
  sudo mv /tmp/ai.pkmn.tunnel.plist /Library/LaunchDaemons/ai.pkmn.tunnel.plist
  sudo chown root:wheel /Library/LaunchDaemons/ai.pkmn.tunnel.plist
  sudo chmod 0644 /Library/LaunchDaemons/ai.pkmn.tunnel.plist
  sudo launchctl bootout system/ai.pkmn.tunnel 2>/dev/null || true
  sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.tunnel.plist
'
```

Add to laptop `~/.ssh/config`:

```ssh-config
Host pkmn.ai
  HostName <PKMN_AI_DROPLET_IP>
  User pkmn
  ForwardAgent no

Host arena
  HostName 127.0.0.1
  Port 2222
  User pkmn
  ProxyJump pkmn.ai
  ForwardAgent no
```

### Verify Phase 2 (from Laptop)

```sh
# 1. Daemon running, no errors in tunnel.err
ssh pkmn@arena.local 'launchctl print system/ai.pkmn.tunnel | grep -E "state =|pid =" && cat /opt/arena/logs/tunnel.err'
# 2. Reverse port listening on pkmn.ai (expect 127.0.0.1:2222)
ssh pkmn@pkmn.ai 'ss -tln | grep ":2222"'
# 3. Inbound SSH via ProxyJump (expect arena / pkmn / arm64)
ssh -o StrictHostKeyChecking=accept-new arena 'scutil --get HostName && whoami && uname -m'
# 4. Outbound RPC tunnel (expect HTTP 200; /arena.json returns {"ladders":[...})
ssh arena 'curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:1234/'
# 5. Tunnel lockdown (expect PASS: shell blocked)
ssh arena 'ssh -i ~/.ssh/id_ed25519_tunnel -o BatchMode=yes tunnel@pkmn.ai id 2>&1 || echo "PASS: shell blocked"'
```

> [!TIP]
> Once all 5 checks pass, `ssh arena` is live and **Phases 3–8** can run remotely (or be handed off
> to an AI agent).

---

## Phase 3: External 1 TB Archive SSD & Toolchain

### 3.1 Format & Mount `/Volumes/Archive`

```sh
ssh arena 'diskutil list external physical'   # NEVER erase internal disk0/disk3!
ssh -t arena 'sudo diskutil eraseDisk APFS Archive GPT /dev/diskX'
ssh -t arena '
  sudo diskutil enableOwnership /Volumes/Archive
  sudo mkdir -p /Volumes/Archive/{logs,db-backups,cold-agents}
  sudo chown -R pkmn:agents /Volumes/Archive
  sudo chmod 0700 /Volumes/Archive /Volumes/Archive/{logs,db-backups,cold-agents}
  sudo mdutil -i off /Volumes/Archive
'
ssh arena 'df -h /Volumes/Archive && ls -ld /Volumes/Archive/{logs,db-backups,cold-agents}'
```

### 3.2 Headless Xcode Command Line Tools (`clang`, `codesign`, `git`)

Use `softwareupdate` with the sentinel file (avoids `xcode-select --install` GUI prompt):

```sh
ssh -t arena '
if ! xcode-select -p >/dev/null 2>&1; then
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  PROD=$(softwareupdate -l | grep "\*.*Command Line" | tail -n 1 | sed "s/^[^C]* //")
  sudo softwareupdate -i "$PROD" --verbose
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi
xcode-select -p && clang --version
'
```

### 3.3 Homebrew, Packages & Full Disk Access

```sh
ssh -t arena '
command -v /opt/homebrew/bin/brew >/dev/null 2>&1 || \
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
grep -q "/opt/homebrew/bin/brew" ~/.zprofile 2>/dev/null || echo '\''eval "$(/opt/homebrew/bin/brew shellenv)"'\'' >> ~/.zprofile
'
ssh arena '
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install node git jq zstd xz sevenzip skopeo podman sqlite
brew install --cask gcloud-cli
'
```

> [!IMPORTANT]
> In **System Settings -> Privacy & Security -> Full Disk Access** (and again after any future
> `brew upgrade node` or `python@*`, which changes ad-hoc Mach-O CDHashes), add:
> - `/opt/homebrew/bin/node` (for `ai.pkmn.arena` writing to `/Volumes/Archive`)
> - `gcloud`'s resolved Homebrew Python (`python3 -c 'import os,sys; print(os.path.realpath(sys.executable))'`
>   on `gcloud info --format='value(basic.python_location)'`, so `ai.pkmn.maintenance` `gcloud storage rsync`
>   doesn't silently skip `/Volumes/Archive` on TCC `EPERM`)
>
> alongside `/usr/sbin/taskpolicy`, `/bin/bash`, and `/usr/bin/tar`. (`zstd`/`7z` stage through
> `/Volumes/Staging` and `/bin/bash`, so they don't need FDA. You can unplug the display afterward.)

**Verify Phase 3:**

```sh
ssh arena '
export PATH="/opt/homebrew/bin:$PATH"
for b in clang codesign git node npm jq zstd 7z skopeo podman sqlite3 gcloud; do printf "%-10s -> %s\n" "$b" "$(command -v "$b")"; done
/opt/homebrew/bin/node -v
/opt/homebrew/bin/node -e "const {DatabaseSync} = require(\"node:sqlite\"); console.log(\"node:sqlite OK\", new DatabaseSync(\":memory:\").prepare(\"SELECT 1 AS ok\").get());"
'
```

---

## Phase 4: Clone `/opt/arena/repo`, Build & Configure `.env`

```sh
ssh -t arena '
export PATH="/opt/homebrew/bin:$PATH"
sudo mkdir -p /opt/arena && sudo chown -R pkmn:agents /opt/arena
[[ -d /opt/arena/repo/.git ]] || git clone https://github.com/pkmn/ai.git /opt/arena/repo
cd /opt/arena/repo && git pull origin main && npm install && npm run compile
'
```

Copy `ARENA_SECRET` from `pkmn.ai` into `/opt/arena/repo/.env` (`0600`; Mac mini needs only
`ARENA_SECRET` and `ARENA_SERVER_URL=http://127.0.0.1:1234`, never OAuth/Discord tokens):

```sh
ARENA_SECRET_VAL="$(ssh pkmn@pkmn.ai "grep '^ARENA_SECRET=' /home/pkmn/ai/.env | cut -d= -f2-")"
ssh arena "umask 077 && printf 'ARENA_SECRET=%s\nARENA_SERVER_URL=http://127.0.0.1:1234\n' '${ARENA_SECRET_VAL}' > /opt/arena/repo/.env && chmod 0600 /opt/arena/repo/.env && chown pkmn:agents /opt/arena/repo/.env"
```

**Verify Phase 4:**

```sh
ssh arena '
cd /opt/arena/repo && ls -l .env build/arena/index.js
/opt/homebrew/bin/node --env-file-if-exists=.env -e "
  const {Client} = require(\"./build/server/arena\");
  new Client({serverUrl: process.env.ARENA_SERVER_URL || \"http://127.0.0.1:1234\", arenaSecret: process.env.ARENA_SECRET})
    .getPendingSubmissions().then(r => console.log(\"RPC OK:\", {ladders: r.ladders.length, pending: r.submissions.length}));
"
'
```

---

## Phase 5: `setup-arena.sh`, `pf`, Podman VM & Sandbox Verification

```sh
ssh -t arena '
export PATH="/opt/homebrew/bin:$PATH"
APFS_CONTAINER="$(diskutil info -plist / | plutil -extract APFSContainerReference raw -)"
cd /opt/arena/repo && ARENA_APFS_CONTAINER="${APFS_CONTAINER}" ./arena/scripts/setup-arena.sh
'
```

`setup-arena.sh` provisions: (1) APFS quota volumes `/Volumes/P{1,2}` (`4G`) & `/Volumes/Staging`
(`6G`); (2) hidden role accounts `p1`/`p2` (`UID 591`/`592`, `GID 590`, `/usr/bin/false`); (3) `0711`
mount roots + `0700` `P{1,2}/scratch` with `p1`/`p2` & `pkmn` ACLs; (4) `100-arena-hardening.conf`
(`ListenAddress 127.0.0.1:22`), `pf.anchor`, `sandbox.sb`, `sudoers.d/arena`; (5) compiled
`/opt/arena/bin/limit`, `/opt/arena/bin/arena`, and `_baseline/run`; (6) `pmset` (`womp 1 powernap 0`), Spotlight disabled on scratch/staging, auto-updates off, and
`BluetoothFeatures/SmartRoutingMacOS` disabled in
`/Library/Preferences/FeatureFlags/Domain/BluetoothFeatures.plist` (prevents headless `audiomxd`
from spin-looping on `TargetUserSession NULL` / `audioaccessoryd died` and hammering `configd` +
`logd` at `loginwindow`; takes effect on reboot, and `SIGSTOP`s `audiomxd` immediately when
`/dev/console` is `root`); (7) rootless `podman-machine-default`
(`10` vCPUs, `30 GiB` RAM, `48 GB` disk, 0 swap, `arena-blacklist.conf` for `sctp`/`dccp`/`rds`/`tipc`)
and `/Library/LaunchDaemons/ai.pkmn.{pf,podman,arena,maintenance}.plist`.

Bootstrap `ai.pkmn.pf` and `ai.pkmn.podman`:

```sh
ssh arena '
for svc in ai.pkmn.pf ai.pkmn.podman; do
  sudo launchctl bootout system/$svc 2>/dev/null || true
  sudo launchctl bootstrap system /Library/LaunchDaemons/$svc.plist
done
sudo /usr/sbin/sshd -t
'
```

### Verify Phase 5 (Tests 5A–5F)

```sh
# 5A: APFS volumes, ACLs, role users & passwordless sudo
ssh arena '
df -h /Volumes/P1 /Volumes/P2 /Volumes/Staging
ls -lde /Volumes/P1 /Volumes/P2 /Volumes/P1/scratch /Volumes/P2/scratch /Volumes/Staging
id p1 && id p2
sudo -n -u p1 /usr/bin/env -i HOME=/Volumes/P1/scratch TMPDIR=/Volumes/P1/scratch PATH=/usr/bin:/bin /usr/bin/id -un
sudo -n -u p2 /usr/bin/env -i HOME=/Volumes/P2/scratch TMPDIR=/Volumes/P2/scratch PATH=/usr/bin:/bin /usr/bin/id -un
'

# 5B: pf anchor & loopback airgap for p1/p2
ssh arena '
sudo -n /sbin/pfctl -a com.apple/100.pkmn.arena -sr
if sudo -n -u p1 /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/curl -m 2 -fsS http://127.0.0.1:1234/arena.json >/dev/null 2>&1; then
  echo "FAIL: p1 reached loopback!" && exit 1
else echo "PASS: pf blocked p1"; fi
'

# 5C: Native Seatbelt + limit + _baseline + scratch cleanup
ssh arena '
set -euo pipefail
TEST_DIR="/opt/arena/agents/_verify_native"; rm -rf "$TEST_DIR"; mkdir -p "$TEST_DIR"
cat > "${TEST_DIR}/run" <<\EOF
#!/bin/sh
echo "scratch-ok" > "${TMPDIR}/marker.txt"
if ls /opt/arena/state >/dev/null 2>&1 || cat /Users/pkmn/.ssh/id_ed25519_tunnel >/dev/null 2>&1; then echo "SANDBOX_BREACH"; exit 1; fi
while IFS= read -r line; do case "$line" in \|request\|*) echo "default"; exit 0 ;; esac; done
EOF
chmod 0755 "${TEST_DIR}/run"
OUT="$(printf "|request|{\"active\":[{\"moves\":[{\"id\":\"tackle\"}]}]}\n" | /opt/arena/bin/arena run p1 native _verify_native)"
PEAK_MIB="$(cat /opt/arena/state/peak_ram_p1)"
sudo -n /opt/arena/bin/arena cleanup p1 native
REMAINING="$(sudo find /Volumes/P1/scratch -mindepth 1 | wc -l | tr -d " ")"
rm -rf "$TEST_DIR"
BASE_OUT="$(printf "|request|{\"teamPreview\":true,\"maxChosenTeamSize\":4}\n|request|{\"active\":[{\"moves\":[{\"id\":\"tackle\"}]}]}\n" | /opt/arena/bin/arena run p2 native _baseline | tr "\n" " ")"
sudo -n /opt/arena/bin/arena cleanup p2 native
echo "Out: ${OUT} | Base: ${BASE_OUT}| Peak MiB: ${PEAK_MIB} | Remaining: ${REMAINING}"
[[ "$OUT" == "default" && "$BASE_OUT" == "/ready /team 1234 default " && "$REMAINING" == "0" ]] && echo "PASS: 5C"
'

# 5D: unpack.ts + APFS CoW CAS deduplication
ssh arena '
set -euo pipefail; export PATH="/opt/homebrew/bin:$PATH"
SRC="$(mktemp -d /Volumes/Staging/verify-src-XXXXXX)"; ARCH="/Volumes/Staging/verify-bundle.tar.zst"
printf "#!/bin/sh\necho default\n" > "$SRC/run"; chmod 0755 "$SRC/run"
dd if=/dev/urandom of="$SRC/weights.bin" bs=1024 count=128 status=none
tar --zstd -cf "$ARCH" -C "$SRC" .
/opt/homebrew/bin/node -e "const u = require(\"/opt/arena/repo/build/arena/unpack\"); console.log(u.bundle(\"$ARCH\",\"/opt/arena/agents/_v1\",\"/opt/arena/cas/_vcas\"), u.bundle(\"$ARCH\",\"/opt/arena/agents/_v2\",\"/opt/arena/cas/_vcas\"));"
rm -rf "$SRC" "$ARCH" /opt/arena/agents/_v1 /opt/arena/agents/_v2 /opt/arena/cas/_vcas
echo "PASS: 5D"
'

# 5E: Podman VM (30 GiB, 0B swap, blacklist) + container sandbox
ssh arena '
set -euo pipefail; export PATH="/opt/homebrew/bin:$PATH"
podman machine ssh podman-machine-default "free -h && test -f /etc/modprobe.d/arena-blacklist.conf"
CTX="$(mktemp -d /Volumes/Staging/podman-verify-XXXXXX)"
printf "FROM docker.io/library/alpine:latest\nENTRYPOINT [\"/bin/sh\",\"-c\",\"echo ok > /scratch/m && read -r l && echo default\"]\n" > "$CTX/Containerfile"
podman build --platform linux/arm64 -t arena-verify-oci:latest "$CTX" >/dev/null; rm -rf "$CTX"
OUT="$(printf "|request|{\"active\":[{\"moves\":[{\"id\":\"tackle\"}]}]}\n" | /opt/arena/bin/arena run p1 container arena-verify-oci:latest)"
sudo -n /opt/arena/bin/arena cleanup p1 container; podman rmi -f arena-verify-oci:latest >/dev/null
REMAINING="$(sudo find /Volumes/P1/scratch -mindepth 1 | wc -l | tr -d " ")"
[[ "$OUT" == "default" && "$REMAINING" == "0" ]] && echo "PASS: 5E"
'

# 5F: Arena test suite
ssh arena 'export PATH="/opt/homebrew/bin:$PATH" && cd /opt/arena/repo && npx vitest run test/arena.test.ts'
```

---

## Phase 6: Start Coordinator (`ai.pkmn.arena`) & Verify Heartbeats

```sh
# 1. Foreground single-pass check
ssh arena '
export PATH="/opt/arena/bin:/opt/homebrew/bin:$PATH"; cd /opt/arena/repo
/opt/homebrew/bin/node --env-file-if-exists=.env -e "require(\"./build/arena\").runDaemon({once:true}).then(() => console.log(\"PASS: single pass\"))"
'

# 2. Bootstrap persistent LaunchDaemon (runs on M6 Efficiency cores via taskpolicy -b)
ssh arena '
sudo launchctl bootout system/ai.pkmn.arena 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.arena.plist
'

# 3. Verify daemons, pf, WAL DB, and live heartbeat (wait ~6s)
ssh arena '
sudo launchctl print system/ai.pkmn.tunnel | grep -E "state =|pid ="
sudo launchctl print system/ai.pkmn.arena  | grep -E "state =|pid ="
sudo pfctl -s info | head -n 1
ls -lh /opt/arena/state/arena.sqlite* && cat /opt/arena/logs/arena.err
'
curl -fsS https://pkmn.ai/api/live.json | jq '{updatedAt, stale, live}'   # expect stale: false
```

---

## Phase 7: GCS (`gs://pkmn-arena`), Nightly Archival & Backups

- `arena/coordinator.ts`: compresses completed past-day `.log` dirs into
  `/Volumes/Archive/logs/<ladder_id>/<YYYY-MM>/<YYYY-MM-DD>.7z` on UTC rollover and builds/uploads
  `<ladder_id>-logs.tar` for `random` and retired `pools` ladders.
- `arena/scripts/maintenance.sh` (`ai.pkmn.maintenance.plist`, daily `10:00 UTC`): acquires
  `/opt/arena/state/maintenance.lock` so `ai.pkmn.arena` pauses new matches (waiting for any
  in-flight `match.lock` to clear), invokes `arena/scripts/archive.sh` (verifies `/Volumes/Archive`
  mount, runs online SQLite `.backup` -> `/Volumes/Archive/db-backups/arena-state-YYYY-MM-DD.sqlite.zst`
  with 30d retention, 1st-of-month `.tar` rollups, and `gs://pkmn-arena` rsync when
  `ARENA_GCS_SYNC=1`), then runs a non-fatal `softwareupdate --list` check into
  `/opt/arena/state/updates-status.json`.

### 7.1 Least-Privilege GCS Service Account & Bootstrap

```sh
# On admin laptop: create SA scoped to gs://pkmn-arena (incl. Requester Pays consumer role)
GCP_PROJECT="$(gcloud config get-value project)"
SA_EMAIL="arena-archiver@${GCP_PROJECT}.iam.gserviceaccount.com"
gcloud iam service-accounts create arena-archiver --display-name="pkmn.ai Mac mini Archiver" --project="$GCP_PROJECT" || true
gcloud storage buckets add-iam-policy-binding gs://pkmn-arena --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin"
gcloud services enable cloudresourcemanager.googleapis.com --project="$GCP_PROJECT"
gcloud projects add-iam-policy-binding "$GCP_PROJECT" --member="serviceAccount:${SA_EMAIL}" --role="roles/serviceusage.serviceUsageConsumer"
umask 077 && gcloud iam service-accounts keys create /tmp/arena-gcs-key.json --iam-account="$SA_EMAIL"
scp /tmp/arena-gcs-key.json arena:/opt/arena/state/gcs-key.json && rm -f /tmp/arena-gcs-key.json

# On arena: activate SA, enable ARENA_GCS_SYNC, bootstrap ai.pkmn.maintenance
ssh arena "
export PATH=\"/opt/homebrew/bin:\$PATH\"
chmod 0600 /opt/arena/state/gcs-key.json && chown pkmn:agents /opt/arena/state/gcs-key.json
gcloud auth activate-service-account --key-file=/opt/arena/state/gcs-key.json
gcloud config set project ${GCP_PROJECT} && gcloud config set billing/quota_project ${GCP_PROJECT}
for kv in ARENA_GCS_SYNC=1 CLOUDSDK_CONFIG=/Users/pkmn/.config/gcloud CLOUDSDK_CORE_PROJECT=${GCP_PROJECT} CLOUDSDK_BILLING_QUOTA_PROJECT=${GCP_PROJECT}; do
  grep -q \"^\${kv%%=*}=\" /opt/arena/repo/.env || printf '%s\n' \"\$kv\" >> /opt/arena/repo/.env
done
sudo -n /bin/launchctl kill SIGUSR1 system/ai.pkmn.arena
sudo launchctl bootout system/ai.pkmn.maintenance 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.maintenance.plist
"
```

**Verify Phase 7** *(trigger via `launchd`, not SSH, to prove macOS Full Disk Access)*:

```sh
ssh -t arena '
export PATH="/opt/homebrew/bin:$PATH"
sudo launchctl kickstart -k system/ai.pkmn.maintenance && sleep 5
sudo launchctl print system/ai.pkmn.maintenance | grep -E "state =|last exit code ="
ls -lh /Volumes/Archive/db-backups/
zstd -t /Volumes/Archive/db-backups/arena-state-*.sqlite.zst && echo "PASS: SQLite backup"
gcloud storage ls gs://pkmn-arena/db-backups/ && echo "PASS: GCS sync"
'
```

---

## Phase 8: Ongoing Ops, Stats Sync & Reboot Test

### 8.1 Deploying Updates

```sh
npm run deploy:arena
```

Runs [`arena/scripts/deploy.sh`](scripts/deploy.sh) on `arena`: verifies `--ff-only` pull from
`origin/main`, acquires `/opt/arena/state/deploy.lock` and waits for any in-flight `match.lock` to
clear before mutating the checkout/`node_modules`/`build/`, installs deps if `package.json` changed,
compiles, smoke-tests `build/arena` (auto-rollback on failure), and sends `SIGUSR1` to flush
`outbox` and exit before `launchd` respawns (`KeepAlive = true`; `SIGUSR1` drains with no kill
timer, whereas `SIGTERM` / `kickstart -k` enforces `ExitTimeOut = 900`). Mid-match crashes or
reboots resume via `coord.recoverIncompleteMatches()` using persisted `seed` and packed teams.

If a commit touches native/system files (`limit.c`, `bin/{arena,baseline}`, `config/*`,
`setup-arena.sh`), `deploy.sh` refuses to restart until you re-run idempotent `setup-arena.sh`:

```sh
ssh -t arena 'export PATH="/opt/homebrew/bin:$PATH" && cd /opt/arena/repo && git pull --ff-only origin main && ./arena/scripts/setup-arena.sh && ./arena/scripts/deploy.sh restart'
```

### 8.2 Syncing Usage Stats (`/opt/arena/stats/`)

Mounted RO as `PKMN_STATS_DIR=/opt/arena/stats` (`data.pkmn.cc` layout): `<format>.json` for fixed
ladders (`gen1ou`, `gen3ou`, `gen9ou`); `<format>.json`, `exact/<format>/*`, `full/<format>.json`,
`stats/<format>.json`, `js/<format>.js` for `RAND`; none for `VGC`:

```sh
ssh arena 'sudo mkdir -p /opt/arena/stats && sudo chown -R pkmn:agents /opt/arena/stats'
rsync -avz --delete stats/ arena:/opt/arena/stats/
ssh arena 'sudo chmod -R a+rX,go-w /opt/arena/stats'
```

### 8.3 Operator Diagnostics

| Task | Command |
| :--- | :--- |
| Tail coordinator logs | `ssh arena 'tail -f /opt/arena/logs/arena.log /opt/arena/logs/arena.err'` |
| Tail tunnel logs | `ssh arena 'tail -f /opt/arena/logs/tunnel.log /opt/arena/logs/tunnel.err'` |
| Graceful restart coordinator | `ssh arena 'sudo launchctl kill SIGUSR1 system/ai.pkmn.arena'` |
| Force-restart coordinator / tunnel | `ssh arena 'sudo launchctl kickstart -k system/ai.pkmn.{arena\|tunnel}'` |
| Local agent cache | `ssh arena 'sqlite3 -header -column /opt/arena/state/arena.sqlite "SELECT version_id, slug, version, mode, residency, total_games, total_faults, consecutive_faults FROM local_agents;"'` |
| Recent matches | `ssh arena 'sqlite3 -header -column /opt/arena/state/arena.sqlite "SELECT id, ladder_id, p1_slug, p2_slug, status, g1_outcome, started_at, completed_at FROM local_matches ORDER BY started_at DESC LIMIT 10;"'` |
| Pending RPC outbox | `ssh arena 'sqlite3 -header -column /opt/arena/state/arena.sqlite "SELECT id, endpoint, created_at FROM outbox;"'` |
| Emergency slot cleanup | `ssh arena 'for s in p1 p2; do for m in native container; do sudo -n /opt/arena/bin/arena cleanup $s $m; done; done'` |
| Podman VM health | `ssh arena '/opt/homebrew/bin/podman machine list && /opt/homebrew/bin/podman ps -a'` |
| Pause headless `audiomxd` spin | `ssh -t arena 'sudo killall -STOP audiomxd'` *(if spinning before next reboot)* |

### 8.4 Unattended Reboot Test

```sh
ssh arena 'sudo reboot'
# Wait ~60-90s, then verify:
ssh arena '
uptime; sudo pfctl -s info | head -n 1
for s in tunnel arena maintenance; do sudo launchctl print system/ai.pkmn.$s | grep -E "state =|pid ="; done
ps -Ao pid,user,%cpu,state,comm | grep -E "PID|audiomxd|configd"
/opt/homebrew/bin/podman machine list
'
curl -fsS https://pkmn.ai/api/live.json | jq '{updatedAt, stale}'   # expect stale: false
```
