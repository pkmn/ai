# Arena Mac mini M6 Setup & Deployment Guide

This guide walks step-by-step through unboxing, configuring, verifying, and deploying the dedicated
**Apple M6 Mac mini** (`pkmn@arena`) that runs continuous **pkmn.ai** ladder matches and submission
smoke tests.

> [!IMPORTANT]
> **Execution Order (Tunnel First):**
> **Phase 1** (first boot + LAN SSH) and **Phase 2** (the bidirectional `pkmn.ai` SSH tunnel) are
> intentionally ordered **before** Homebrew, Podman, or `arena/scripts/setup-arena.sh`.
>
> 1. Stock macOS already includes `/usr/bin/ssh`, `/usr/sbin/taskpolicy`, `dscl`, and `launchctl`.
> 2. Once **Phase 2** passes verification, `ssh arena` works from your laptop via `ProxyJump`
>    through `pkmn.ai` — allowing an AI coding agent (or you) to execute and verify **Phases 3–8**
>    remotely.
> 3. `arena/scripts/setup-arena.sh` installs `/etc/ssh/sshd_config.d/100-arena-hardening.conf`,
>    which binds `sshd` strictly to `ListenAddress 127.0.0.1:22` (disabling LAN SSH on `en0`/`en1`).
>    Bringing up and verifying the reverse tunnel **first** guarantees you never lock yourself out of
>    LAN SSH before the tunnel is live.

---

## Architecture & Topology Summary

```
┌──────────────────────┐         SSH (Port 22)          ┌──────────────────────────────────────┐
│     Admin Laptop     │ ─────────────────────────────▶ │       pkmn.ai (Ubuntu Droplet)       │
│   (`ssh arena` via   │                                │  • pkmn.ai-server (:1234 loopback)   │
│  ProxyJump pkmn.ai)  │ ─── ProxyJump 127.0.0.1:2222 ─▶│  • sshd Match User tunnel            │
└──────────────────────┘                                └──────────────────▲───────────────────┘
                                                                           │
                                                   ai.pkmn.tunnel (LaunchDaemon as pkmn:agents)
                                                   • -L 127.0.0.1:1234:127.0.0.1:1234 (RPC out)
                                                   • -R 127.0.0.1:2222:127.0.0.1:22   (SSH in)
                                                                           │
                                                        ┌──────────────────┴───────────────────┐
                                                        │     M6 Mac mini (`pkmn@arena`)       │
                                                        │  • sshd bound to 127.0.0.1:22        │
                                                        │  • ai.pkmn.arena (Node coordinator)  │
                                                        │  • ai.pkmn.pf (blocks UIDs p1 & p2)  │
                                                        │  • /Volumes/{P1,P2,Staging,Archive}  │
                                                        └──────────────────────────────────────┘
```

| Entity / Path | Value on Mac mini (`arena`) | Purpose |
| :--- | :--- | :--- |
| **Admin / Coordinator User** | `pkmn` (in group `agents`, GID `590`) | Owns `/opt/arena`, runs `ai.pkmn.arena`, `ai.pkmn.tunnel`, and Podman VM. |
| **Sandbox Slot Users** | `p1` (UID `591`), `p2` (UID `592`) | Unprivileged role accounts (GID `590`, shell `/usr/bin/false`) blocked by `pf`. |
| **Repository Checkout** | `/opt/arena/repo` | Git checkout of `github.com/pkmn/ai` (`build/arena` entrypoint + `.env`). |
| **Binaries & Helpers** | `/opt/arena/bin/{arena,limit}` | Lifecycle script and C `ri_phys_footprint` 14 GiB supervisor. |
| **Seatbelt Profile** | `/opt/arena/etc/sandbox.sb` | Mandatory Access Control profile for native `darwin/arm64` agent bundles. |
| **Era-Matched Usage Stats** | `/opt/arena/stats/` | Read-only `data.pkmn.cc` stats mount (`PKMN_STATS_DIR=/opt/arena/stats`) shared by bundles & containers. |
| **Hot Agent Storage** | `/opt/arena/agents/<target>/` | Unpacked native bundles (`<= 500 MB`, deduplicated via `/opt/arena/cas/sha256`). |
| **Coordinator State DB** | `/opt/arena/state/arena.sqlite` | Local WAL SQLite DB (`local_agents`, `local_matches`, `outbox`, `ladder_counters`). |
| **Daemon Logs** | `/opt/arena/logs/{arena,tunnel}.{log,err}` | Stdout/stderr logs for `ai.pkmn.arena` and `ai.pkmn.tunnel`. |
| **APFS Scratch Volumes** | `/Volumes/P1`, `/Volumes/P2` (`4G` quota) | Quota-capped APFS volumes (`0711` `root:wheel`) with `/Volumes/P{1,2}/scratch` (`0700` + `p1`/`p2` & `pkmn` ACLs) wiped around every game. |
| **APFS Staging Volume** | `/Volumes/Staging` (`6G` quota) | Ephemeral download & extraction staging area (`0700` `pkmn:agents`). |
| **External Archive SSD** | `/Volumes/Archive` (`1 TB` APFS) | Cold agent `.tar.zst` archive (`cold-agents/`), daily battle logs (`logs/`), DB backups (`db-backups/`). |

---

## Phase 1: First Boot, macOS Setup Assistant & Local LAN SSH

Plug the Mac mini into power, Ethernet (`en0`), and temporarily a monitor, keyboard, and mouse for
the first-boot macOS Setup Assistant.

### Step 1.1: Complete macOS Setup Assistant

Walk through the initial macOS Setup Assistant with these exact choices:

1. **Accessibility / Migration Assistant:** Skip (**Not Now**).
2. **Apple ID / iCloud:** Click **Set Up Later** -> **Skip** (do **not** sign into iCloud).
3. **Computer Account:**
   - **Full Name:** `pkmn`
   - **Account Name:** `pkmn`
   - **Password:** Set a strong local administrator password (needed for initial `sudo`).
4. **FileVault Disk Encryption:** **Disable / Turn Off**.
   - *Why:* If FileVault is enabled, an unattended reboot after a power outage halts at the pre-boot
     EFI unlock screen before macOS or `launchd` starts, preventing `ai.pkmn.tunnel` from coming
     online without a physical keyboard attached.
5. **Analytics, Screen Time, Siri, Apple Intelligence, Location Services:** Disable / Skip all.

### Step 1.2: Disable Auto-Login, Grant Full Disk Access, Set Hostname & Enable SSH

1. Open **System Settings -> Users & Groups** and ensure **Automatically log in** is set to **Off**.
   - *Why:* When the Mac mini boots headless with no display connected, stopping at the login window
     avoids launching an interactive Aqua / `WindowServer` / Finder session, saving ~1.5 GB of
     Unified Memory for agents.
2. Open **System Settings -> Privacy & Security -> Full Disk Access**, click **`+`**, press
   **`Cmd+Shift+G`**, and grant Full Disk Access to `/usr/sbin/taskpolicy`, `/bin/bash`, and
   `/usr/bin/tar` *(keep a display connected until Step 3.3 so you can also add
   `/opt/homebrew/bin/node` after installing Homebrew)*.
   - *Why:* On macOS Sequoia+, headless `LaunchDaemons` (`ai.pkmn.arena` and `ai.pkmn.archive`) are
     blocked by TCC (`kTCCServiceSystemPolicyRemovableVolumes`) from writing to external USB/TB
     APFS drives (`/Volumes/Archive`) unless Full Disk Access is granted in System Settings (`ssh`
     sessions inherit `Remote Login`'s grant, which would otherwise mask missing daemon access).
3. Open **Terminal.app** on the Mac mini and run:

```sh
# 1. Set all three macOS hostnames to 'arena'
sudo scutil --set HostName arena
sudo scutil --set LocalHostName arena
sudo scutil --set ComputerName arena

# 2. Enable Remote Login (sshd) and disable headless idle sleep immediately
sudo systemsetup -setremotelogin on
sudo pmset -a sleep 0 disksleep 0 displaysleep 0 autorestart 1 disablesleep 1

# 3. Print the Mac mini's LAN IP address
ipconfig getifaddr en0 || ipconfig getifaddr en1
```

### Step 1.3: Copy Your Laptop SSH Key & Verify LAN Access

From your **admin laptop**, install your SSH public key onto the Mac mini (using `arena.local` or
the LAN IP printed in Step 1.2):

```sh
ssh-copy-id pkmn@arena.local
```

#### Verify Phase 1

Run this check from your **admin laptop**:

```sh
ssh -o ForwardAgent=no pkmn@arena.local \
  'uname -srm && scutil --get HostName && fdesetup status && sysctl -n hw.ncpu hw.memsize'
```

**Expected Output:**
- `Darwin ... arm64`
- `arena`
- `FileVault is Off.`
- CPU core count (`12`) and Unified Memory in bytes (`34359738368` for 32 GiB).

*(You can now unplug the monitor, keyboard, and mouse from the Mac mini and run all remaining steps
remotely from your laptop.)*

---

## Phase 2: Priority — Set Up the Bidirectional SSH Tunnel (`arena` <-> `pkmn.ai`)

`ai.pkmn.tunnel.plist` maintains a persistent SSH connection from `pkmn@arena` to `tunnel@pkmn.ai`
with two port forwards:

- **`-L 127.0.0.1:1234:127.0.0.1:1234` (Local forward):** Exposes the `pkmn.ai` Node.js server
  (`127.0.0.1:1234` on the Ubuntu droplet) at `http://127.0.0.1:1234` on the Mac mini so the
  coordinator daemon communicates over loopback without traversing public Cloudflare proxies.
- **`-R 127.0.0.1:2222:127.0.0.1:22` (Reverse forward):** Binds `127.0.0.1:2222` on the Ubuntu
  droplet and forwards it to `127.0.0.1:22` on the Mac mini so `ssh arena` works from your laptop
  via `ProxyJump pkmn.ai`.

### Step 2.1: Prepare Tunnel Prerequisites on the Mac mini

Because `ai.pkmn.tunnel.plist` runs as `UserName=pkmn` + `GroupName=agents`, writes logs to
`/opt/arena/logs/tunnel.{log,err}`, and connects to `tunnel@pkmn.ai` (which in public DNS points to
Cloudflare's orange-cloud proxy that drops port 22), create those prerequisites first.

First, check the raw droplet IP configured on your **admin laptop**:

```sh
ssh -G pkmn.ai | grep '^hostname '
```

Then SSH into the Mac mini over LAN (`ssh pkmn@arena.local`) and run (replacing
`<PKMN_AI_DROPLET_IP>` with the droplet IP printed above):

```sh
# 1. Create the 'agents' group (GID 590) and add 'pkmn' (required by ai.pkmn.tunnel.plist)
if ! dscl . -read /Groups/agents >/dev/null 2>&1; then
  sudo dscl . -create /Groups/agents
  sudo dscl . -create /Groups/agents PrimaryGroupID 590
fi
sudo dscl . -append /Groups/agents GroupMembership pkmn || true

# 2. Create /opt/arena/logs owned by pkmn:agents (required by launchd stdout/stderr paths)
sudo mkdir -p /opt/arena/logs
sudo chown -R pkmn:agents /opt/arena
sudo chmod 0755 /opt/arena
sudo chmod 0700 /opt/arena/logs

# 3. Map pkmn.ai to the Ubuntu droplet's real IP in /etc/hosts so SSH port 22 bypasses Cloudflare
PKMN_AI_IP="<PKMN_AI_DROPLET_IP>"
grep -qw "pkmn.ai" /etc/hosts || printf '%s\tpkmn.ai\n' "$PKMN_AI_IP" | sudo tee -a /etc/hosts

# 4. Generate the dedicated Ed25519 tunnel keypair (no passphrase)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if [[ ! -f ~/.ssh/id_ed25519_tunnel ]]; then
  ssh-keygen -t ed25519 -N "" -C "arena-tunnel" -f ~/.ssh/id_ed25519_tunnel
fi
chmod 600 ~/.ssh/id_ed25519_tunnel ~/.ssh/authorized_keys 2>/dev/null || true

# 5. Print the public key to authorize on pkmn.ai in Step 2.2
cat ~/.ssh/id_ed25519_tunnel.pub
```

Copy the single `ssh-ed25519 AAAA... arena-tunnel` line printed at the end.

### Step 2.2: Authorize the Tunnel Key & Forward Rules on `pkmn.ai` (Ubuntu Droplet)

> [!NOTE]
> `docs/SETUP.md` initially set `AllowTcpForwarding local` in `/etc/ssh/sshd_config.d/arena-tunnel.conf`,
> which only permitted `-L 127.0.0.1:1234` and rejected `-R 127.0.0.1:2222`. The config below
> enables **both** `-L 127.0.0.1:1234` (`PermitOpen`) and `-R 127.0.0.1:2222` (`PermitListen`) while
> keeping interactive shells, PTYs, and all other ports locked down, and sets a 45-second keepalive
> timeout so dead NAT connections never wedge port `2222`.

From your **admin laptop**, SSH to `pkmn@pkmn.ai` and run (replacing `<ARENA_TUNNEL_PUBKEY>` with the
`ssh-ed25519 AAAA...` key from Step 2.1):

```sh
# 1. Ensure the shell-less 'tunnel' system user and /etc/ssh/authorized_keys directory exist
id -u tunnel >/dev/null 2>&1 || sudo adduser --system --no-create-home --shell /usr/sbin/nologin tunnel
sudo mkdir -p /etc/ssh/authorized_keys
sudo chmod 0755 /etc/ssh/authorized_keys

# 2. Install the Mac mini tunnel public key locked strictly to :1234 (open) and :2222 (listen)
sudo tee /etc/ssh/authorized_keys/tunnel >/dev/null <<'EOF'
restrict,port-forwarding,permitopen="127.0.0.1:1234",permitlisten="127.0.0.1:2222" ssh-ed25519 <ARENA_TUNNEL_PUBKEY> arena-tunnel
EOF
sudo chmod 0644 /etc/ssh/authorized_keys/tunnel

# 3. Configure sshd Match User tunnel block and fast dead-peer cleanup (15s * 3 = 45s)
sudo tee /etc/ssh/sshd_config.d/arena-tunnel.conf >/dev/null <<'EOF'
ClientAliveInterval 15
ClientAliveCountMax 3

Match User tunnel
    AuthorizedKeysFile /etc/ssh/authorized_keys/tunnel
    PasswordAuthentication no
    PubkeyAuthentication yes
    ForceCommand /bin/false
    AllowTcpForwarding yes
    PermitOpen 127.0.0.1:1234
    PermitListen 127.0.0.1:2222
    GatewayPorts no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
EOF

# 4. Validate sshd syntax and reload ssh
sudo /usr/sbin/sshd -t && sudo service ssh reload
```

### Step 2.3: Install & Bootstrap `ai.pkmn.tunnel.plist` on the Mac mini

On the Mac mini (`ssh pkmn@arena.local`), install `/Library/LaunchDaemons/ai.pkmn.tunnel.plist` and
bootstrap it into `launchd`:

```sh
sudo tee /Library/LaunchDaemons/ai.pkmn.tunnel.plist >/dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.pkmn.tunnel</string>
  <key>UserName</key>
  <string>pkmn</string>
  <key>GroupName</key>
  <string>agents</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/taskpolicy</string>
    <string>-b</string>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-T</string>
    <string>-o</string>
    <string>ServerAliveInterval=15</string>
    <string>-o</string>
    <string>ServerAliveCountMax=3</string>
    <string>-o</string>
    <string>ExitOnForwardFailure=yes</string>
    <string>-o</string>
    <string>StrictHostKeyChecking=accept-new</string>
    <string>-i</string>
    <string>/Users/pkmn/.ssh/id_ed25519_tunnel</string>
    <string>-L</string>
    <string>127.0.0.1:1234:127.0.0.1:1234</string>
    <string>-R</string>
    <string>127.0.0.1:2222:127.0.0.1:22</string>
    <string>tunnel@pkmn.ai</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/opt/arena/logs/tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>/opt/arena/logs/tunnel.err</string>
</dict>
</plist>
EOF

sudo chown root:wheel /Library/LaunchDaemons/ai.pkmn.tunnel.plist
sudo chmod 0644 /Library/LaunchDaemons/ai.pkmn.tunnel.plist

sudo launchctl bootout system/ai.pkmn.tunnel 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.tunnel.plist
```

### Step 2.4: Add `Host arena` to Your Laptop `~/.ssh/config`

On your **admin laptop**, add the `arena` host entry to `~/.ssh/config` so `ssh arena` hops through
`pkmn.ai` with agent forwarding disabled:

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

#### Verify Phase 2 (Run All 5 Checks from Your Laptop)

1. **Verify `ai.pkmn.tunnel` is running on the Mac mini:**
   ```sh
   ssh pkmn@arena.local 'launchctl print system/ai.pkmn.tunnel | grep -E "state =|pid =" && cat /opt/arena/logs/tunnel.err'
   ```
   *Expected:* `state = running`, a live `pid = ...`, and no errors in `tunnel.err` (only the
   initial `Permanently added 'pkmn.ai' (ED25519) to the list of known hosts` notice).

2. **Verify `127.0.0.1:2222` is listening on `pkmn.ai`:**
   ```sh
   ssh pkmn@pkmn.ai 'ss -tln | grep ":2222"'
   ```
   *Expected:* `LISTEN 0 128 127.0.0.1:2222 0.0.0.0:*`

3. **Verify inbound reverse SSH tunnel (`laptop -> pkmn.ai:2222 -> arena:22`):**
   ```sh
   ssh -o StrictHostKeyChecking=accept-new arena 'scutil --get HostName && whoami && uname -m'
   ```
   *Expected:* `arena`, `pkmn`, `arm64`.

4. **Verify outbound local port forward (`arena:1234 -> pkmn.ai:1234`):**
   ```sh
   ssh arena 'curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:1234/'
   ```
   *Expected:* `HTTP 200` from `pkmn.ai-server` (and once `pkmn.ai` is deployed with the Arena
   routes via `npm run deploy`, `ssh arena 'curl -fsS http://127.0.0.1:1234/arena.json | head -c 160 && echo'`
   returns `{"ladders":[...`).

5. **Verify tunnel lockdown (shell and unauthorized port forwarding rejected):**
   ```sh
   ssh arena 'ssh -i ~/.ssh/id_ed25519_tunnel -o BatchMode=yes tunnel@pkmn.ai id 2>&1 || echo "PASS: shell blocked"'
   ```
   *Expected:* `PASS: shell blocked` (connection closes immediately due to `ForceCommand /bin/false`
   and `restrict`).

> [!TIP]
> **Agent Hand-Off Point:**
> Once all 5 Phase 2 checks pass, `ssh arena` works directly from this laptop! If you want the AI
> agent to execute and verify **Phases 3–8** for you, simply wake up the agent and tell it `ssh arena`
> is live. Otherwise, continue below.

---

## Phase 3: External 1 TB Archive SSD & System Toolchain (Xcode CLT, Homebrew, CLI Tools)

All remaining commands can be run over `ssh arena`.

### Step 3.1: Format & Mount the External 1 TB Archive SSD (`/Volumes/Archive`)

If the external 1 TB SSD is plugged into the Mac mini, format it as a dedicated APFS volume named
`Archive` so macOS mounts it automatically at `/Volumes/Archive`:

```sh
# 1. List external physical disks ONLY (never format internal disk0 / disk3!)
ssh arena 'diskutil list external physical'

# 2. Format the external disk as APFS named "Archive" (replace diskX with the external disk identifier, e.g. disk4)
ssh -t arena 'sudo diskutil eraseDisk APFS Archive GPT /dev/diskX'

# 3. Enable POSIX ownership (disabled by default on external drives), create archive subdirectories (0700 so GID 590 cannot read private archives), and disable Spotlight indexing
ssh -t arena 'sudo diskutil enableOwnership /Volumes/Archive && sudo mkdir -p /Volumes/Archive/{logs,db-backups,cold-agents} && sudo chown -R pkmn:agents /Volumes/Archive && sudo chmod 0700 /Volumes/Archive /Volumes/Archive/{logs,db-backups,cold-agents} && sudo mdutil -i off /Volumes/Archive'
```

#### Verify Step 3.1

```sh
ssh arena 'df -h /Volumes/Archive && ls -ld /Volumes/Archive/{logs,db-backups,cold-agents}'
```

*Expected:* `/Volumes/Archive` mounted with ~1 TB free and `drwx------` (`0700`) directories owned
by `pkmn:agents`.

### Step 3.2: Install Xcode Command Line Tools (`clang`, `codesign`, `git`)

`arena/bin/limit.c` requires `clang` and macOS SDK headers, while `arena/unpack.ts` uses
`codesign` and `xattr` to strip extended attributes and ad-hoc sign unpacked Mach-O binaries.

> [!NOTE]
> On headless macOS, `xcode-select --install` opens a GUI dialog if called directly. Instead, use
> `softwareupdate` with the `/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress`
> sentinel file to install the Command Line Tools completely headlessly over SSH:

```sh
ssh -t arena '
if ! xcode-select -p >/dev/null 2>&1; then
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  PROD=$(softwareupdate -l | grep "\*.*Command Line" | tail -n 1 | sed "s/^[^C]* //")
  echo "Installing: $PROD"
  sudo softwareupdate -i "$PROD" --verbose
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi
xcode-select -p && clang --version
'
```

### Step 3.3: Install Homebrew & Required Packages

Install Homebrew under `/opt/homebrew` and install the runtime packages used by the coordinator,
package manager, and nightly archival scripts (`node`, `git`, `jq`, `zstd`, `sevenzip`, `skopeo`,
`podman`, `sqlite`):

```sh
# 1. Install Homebrew non-interactively (prompts once for pkmn's sudo password if needed)
ssh -t arena '
if ! command -v /opt/homebrew/bin/brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
grep -q "/opt/homebrew/bin/brew" ~/.zprofile 2>/dev/null || echo '\''eval "$(/opt/homebrew/bin/brew shellenv)"'\'' >> ~/.zprofile
'

# 2. Install CLI tools and Google Cloud SDK (`gcloud`) required by arena/
ssh arena '
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install node git jq zstd xz sevenzip skopeo podman sqlite
brew install --cask gcloud-cli
'
```

> [!IMPORTANT]
> After `brew install node` completes (and after any future `brew upgrade node`, which changes the
> ad-hoc Mach-O CDHash), open **System Settings -> Privacy & Security -> Full Disk Access** on the
> Mac mini and ensure `/opt/homebrew/bin/node` (alongside `/usr/sbin/taskpolicy`, `/bin/bash`, and
> `/usr/bin/tar`) is enabled so `ai.pkmn.arena` can write cold archives and battle logs to
> `/Volumes/Archive`.

#### Verify Phase 3

```sh
ssh arena '
export PATH="/opt/homebrew/bin:$PATH"
for bin in clang codesign git node npm jq zstd 7z skopeo podman sqlite3 gcloud; do
  printf "%-10s -> %s\n" "$bin" "$(command -v "$bin")"
done
/opt/homebrew/bin/node -v
/opt/homebrew/bin/node -e "const {DatabaseSync} = require(\"node:sqlite\"); const db = new DatabaseSync(\":memory:\"); console.log(\"node:sqlite OK\", db.prepare(\"SELECT 1 AS ok\").get());"
'
```

**Expected Output:**
- Every binary resolves to `/opt/homebrew/bin/...` or `/usr/bin/...`.
- `/opt/homebrew/bin/node -v` prints `v22.x` or newer.
- `node:sqlite OK { ok: 1 }`.

---

## Phase 4: Clone `/opt/arena/repo`, Build the Coordinator & Configure `.env`

`ai.pkmn.arena.plist` runs `/opt/homebrew/bin/node --env-file-if-exists=/opt/arena/repo/.env /opt/arena/repo/build/arena`
with `WorkingDirectory=/opt/arena/repo`.

### Step 4.1: Clone `pkmn/ai` into `/opt/arena/repo` and Compile

```sh
ssh -t arena '
export PATH="/opt/homebrew/bin:$PATH"
sudo mkdir -p /opt/arena
sudo chown -R pkmn:agents /opt/arena
if [[ ! -d /opt/arena/repo/.git ]]; then
  git clone https://github.com/pkmn/ai.git /opt/arena/repo
fi
cd /opt/arena/repo
git pull origin main
npm install
npm run compile
'
```

### Step 4.2: Create `/opt/arena/repo/.env` (`0600`)

The Mac mini coordinator only needs `ARENA_SECRET` (matching `ARENA_SECRET` in `/home/pkmn/ai/.env`
on `pkmn.ai`) and `ARENA_SERVER_URL=http://127.0.0.1:1234` (which routes over the `ai.pkmn.tunnel`
local forward). It does **not** need `SESSION_SECRET`, OAuth client secrets, or Discord tokens.

Copy `ARENA_SECRET` from `pkmn.ai` to `/opt/arena/repo/.env` on the Mac mini directly from your
**admin laptop**:

```sh
ARENA_SECRET_VAL="$(ssh pkmn@pkmn.ai "grep '^ARENA_SECRET=' /home/pkmn/ai/.env | cut -d= -f2-")"
ssh arena "umask 077 && cat > /opt/arena/repo/.env <<EOF
ARENA_SECRET=${ARENA_SECRET_VAL}
ARENA_SERVER_URL=http://127.0.0.1:1234
EOF
chmod 0600 /opt/arena/repo/.env && chown pkmn:agents /opt/arena/repo/.env"
```

#### Verify Phase 4

Test that the compiled `build/arena` binary loads `.env` and authenticates against `pkmn.ai-server`
over the tunnel (`http://127.0.0.1:1234/api/arena/pending-submissions`):

```sh
ssh arena '
cd /opt/arena/repo
ls -l /opt/arena/repo/.env /opt/arena/repo/build/arena/index.js
/opt/homebrew/bin/node --env-file-if-exists=/opt/arena/repo/.env -e "
  const {Client} = require(\"./build/server/arena\");
  const client = new Client({
    serverUrl: process.env.ARENA_SERVER_URL || \"http://127.0.0.1:1234\",
    arenaSecret: process.env.ARENA_SECRET,
  });
  client.getPendingSubmissions().then(res => {
    console.log(\"Authenticated RPC OK:\", {
      ladders: res.ladders.length,
      pendingSubmissions: res.submissions.length,
    });
  });
"
'
```

**Expected Output:**
- `.env` has permissions `-rw-------` (`0600`) owned by `pkmn:agents`.
- `Authenticated RPC OK: { ladders: 5, pendingSubmissions: ... }`.

---

## Phase 5: Run `setup-arena.sh` & Provision Sandboxes, `pf` Firewall, and Podman VM

### Step 5.1: Verify Root APFS Container & Run `arena/scripts/setup-arena.sh`

`arena/scripts/setup-arena.sh` defaults `ARENA_APFS_CONTAINER` to `disk3` (standard on Apple Silicon
Macs). Query the root `/` APFS container reference dynamically and run `setup-arena.sh`:

```sh
ssh -t arena '
export PATH="/opt/homebrew/bin:$PATH"
APFS_CONTAINER="$(diskutil info -plist / | plutil -extract APFSContainerReference raw -)"
echo "Root APFS container: ${APFS_CONTAINER}"
cd /opt/arena/repo
ARENA_APFS_CONTAINER="${APFS_CONTAINER}" ./arena/scripts/setup-arena.sh
'
```

What `setup-arena.sh` provisions:
1. **APFS Quota Volumes:** Creates `/Volumes/P1` and `/Volumes/P2` with hard `4G` kernel APFS
   quotas and `/Volumes/Staging` with a hard `6G` kernel APFS quota.
2. **Role Accounts:** Creates `p1` (`UID 591`) and `p2` (`UID 592`) in group `agents` (`GID 590`)
   with `/usr/bin/false` login shells and hidden login-window flags.
3. **Volume Permissions & ACLs:** Locks the `/Volumes/P1` and `/Volumes/P2` mount roots (`root:wheel`,
   `0711` + `user:pkmn` read/search ACL so `mds`/`.Spotlight-V100` stays inaccessible to `p1`/`p2`)
   and isolates per-game writable state to `/Volumes/P1/scratch` and `/Volumes/P2/scratch` (`0700`
   `root:wheel` with explicit `user:p1`/`user:p2` and `user:pkmn` ACLs for Seatbelt & `virtiofs`).
4. **System Hardening Configs:** Installs `/etc/ssh/sshd_config.d/100-arena-hardening.conf`
   (`ListenAddress 127.0.0.1:22`), `/etc/pf.anchors/ai.pkmn.arena`, `/opt/arena/etc/sandbox.sb`,
   and `/etc/sudoers.d/arena`.
5. **Compiled Supervisor & Binaries:** Compiles `arena/bin/limit.c` -> `/opt/arena/bin/limit`,
   installs `/opt/arena/bin/arena` (`root:wheel`, `0755`), and installs the deterministic
   smoke-test baseline agent at `/opt/arena/agents/_baseline/run`.
6. **Headless Power & Spotlight:** Sets `pmset` (`womp 1 powernap 0`), disables Spotlight on
   `/Volumes/{P1,P2,Staging}`, and disables automatic macOS updates.
7. **Podman VM & LaunchDaemons:** Initializes rootless `podman-machine-default` (`10` vCPUs,
   `30 GiB` / `30,720 MiB` RAM, `48 GB` disk, zero swap; containers run `--read-only` with
   `--tmpfs /tmp:size=500m`), disables uncommon Linux socket modules (`sctp`, `dccp`, `rds`, `tipc`)
   via `/etc/modprobe.d/arena-blacklist.conf`, stops the interactive VM cleanly for `launchd`
   ownership, and copies `ai.pkmn.{pf,podman,arena,archive}.plist` to `/Library/LaunchDaemons/`.

### Step 5.2: Bootstrap `ai.pkmn.pf` & Reload Hardened `sshd`

Enable the `pf` packet filter LaunchDaemon (which drops all outbound TCP/UDP traffic from UIDs `p1`
and `p2`, including loopback; raw ICMP requires root and native bundles also run under Seatbelt
`(deny network*)`) and reload `sshd` so it binds exclusively to `127.0.0.1:22`:

```sh
ssh arena '
sudo launchctl bootout system/ai.pkmn.pf 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.pf.plist
sudo /usr/sbin/sshd -t
'
```

### Step 5.3: Bootstrap `ai.pkmn.podman` (`podman-machine-default` Boot Autostart)

`setup-arena.sh` already initialized `podman-machine-default` (`10` vCPUs, `30 GiB` RAM so two
concurrent 14 GiB `--memory=14g --memory-swap=14g` `--read-only` containers coexist in physical
memory with zero disk swap). Bootstrap `/Library/LaunchDaemons/ai.pkmn.podman.plist` so
`podman-machine-default` starts automatically across unattended macOS reboots:

```sh
ssh arena '
sudo launchctl bootout system/ai.pkmn.podman 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.podman.plist
'
```

---

#### Verify Phase 5 (Comprehensive Sandbox & Runtime Verification Suite)

Run each of these 6 verification tests over `ssh arena` before starting the coordinator daemon:

##### Test 5A: Verify APFS Volumes, Permissions, Role Users & Passwordless Sudo

```sh
ssh arena '
df -h /Volumes/P1 /Volumes/P2 /Volumes/Staging
ls -lde /Volumes/P1 /Volumes/P2 /Volumes/P1/scratch /Volumes/P2/scratch /Volumes/Staging
id p1 && id p2
sudo -n -u p1 /usr/bin/env -i HOME=/Volumes/P1/scratch TMPDIR=/Volumes/P1/scratch PATH=/usr/bin:/bin /usr/bin/id -un
sudo -n -u p2 /usr/bin/env -i HOME=/Volumes/P2/scratch TMPDIR=/Volumes/P2/scratch PATH=/usr/bin:/bin /usr/bin/id -un
'
```

*Expected:*
- `/Volumes/P1` and `/Volumes/P2` mounted (`4Gi` quota each), `/Volumes/Staging` mounted (`6Gi` quota).
- `/Volumes/P1/scratch` (`drwx------+` `0700` `root:wheel` with `user:p1` and `user:pkmn` ACLs) and `/Volumes/P2/scratch` (`drwx------+` `0700` `root:wheel` with `user:p2` and `user:pkmn` ACLs).
- `sudo -n -u p1 ...` prints `p1` and `sudo -n -u p2 ...` prints `p2` with no password prompt.

##### Test 5B: Verify `sshd` Loopback Binding & `pf` Kernel Firewall Airgap

```sh
ssh arena '
# 1. Verify pf anchor rule is loaded under Apple's pre-loaded com.apple/* wildcard anchor
sudo -n /sbin/pfctl -a com.apple/100.pkmn.arena -sr

# 2. Verify UID p1 is blocked by kernel pf from reaching loopback 127.0.0.1:1234
if sudo -n -u p1 /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/curl -m 2 -fsS http://127.0.0.1:1234/arena.json >/dev/null 2>&1; then
  echo "FAIL: p1 reached loopback network!" && exit 1
else
  echo "PASS: pf blocked outbound/loopback network from p1"
fi
'
```

*Expected:*
- `block return out quick proto tcp from any to any user = 591` (and `592` / `udp`).
- `PASS: pf blocked outbound/loopback network from p1`.

##### Test 5C: Verify Native Seatbelt Sandbox (`sandbox.sb`), `limit` Supervisor & `arena` Lifecycle

```sh
ssh arena '
set -euo pipefail
TEST_DIR="/opt/arena/agents/_verify_native"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

cat > "${TEST_DIR}/run" <<\EOF
#!/bin/sh
# 1. Verify we can write to our own scratch volume ($TMPDIR)
echo "scratch-ok" > "${TMPDIR}/marker.txt"
# 2. Verify Seatbelt denies reading /opt/arena/state or pkmn SSH keys
if ls /opt/arena/state >/dev/null 2>&1 || cat /Users/pkmn/.ssh/id_ed25519_tunnel >/dev/null 2>&1; then
  echo "SANDBOX_BREACH"
  exit 1
fi
# 3. Respond to a Showdown |request| line
while IFS= read -r line; do
  case "$line" in
    \|request\|*) echo "default"; exit 0 ;;
  esac
done
EOF
chmod 0755 "${TEST_DIR}/run"

OUT="$(printf "|request|{\"active\":[{\"moves\":[{\"id\":\"tackle\"}]}]}\n" | /opt/arena/bin/arena run p1 native _verify_native)"
PEAK_MIB="$(cat /opt/arena/state/peak_ram_p1)"
sudo -n /opt/arena/bin/arena cleanup p1 native
REMAINING="$(sudo find /Volumes/P1/scratch -mindepth 1 | wc -l | tr -d " ")"
rm -rf "$TEST_DIR"

# Also verify the installed smoke-test _baseline agent inside the Seatbelt p2 slot
BASE_OUT="$(printf "|request|{\"teamPreview\":true,\"maxChosenTeamSize\":4}\n|request|{\"active\":[{\"moves\":[{\"id\":\"tackle\"}]}]}\n" | /opt/arena/bin/arena run p2 native _baseline | tr "\n" " ")"
sudo -n /opt/arena/bin/arena cleanup p2 native

echo "Agent stdout: ${OUT} | Baseline: ${BASE_OUT}| Peak RAM MiB: ${PEAK_MIB} | Remaining files in /Volumes/P1/scratch: ${REMAINING}"
[[ "$OUT" == "default" && "$BASE_OUT" == "/team 1234 default " && "$REMAINING" == "0" ]] && echo "PASS: Native Seatbelt + limit + _baseline + cleanup verified"
'
```

*Expected:*
- `Agent stdout: default | Baseline: /team 1234 default | Peak RAM MiB: <N> | Remaining files in /Volumes/P1/scratch: 0`
- `PASS: Native Seatbelt + limit + _baseline + cleanup verified`

##### Test 5D: Verify `arena/unpack.ts` & APFS Copy-on-Write CAS Deduplication

```sh
ssh arena '
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
SRC_DIR="$(mktemp -d /Volumes/Staging/verify-src-XXXXXX)"
ARCHIVE="/Volumes/Staging/verify-bundle.tar.zst"
DEST_1="/opt/arena/agents/_verify_unpack_1"
DEST_2="/opt/arena/agents/_verify_unpack_2"
CAS_DIR="/opt/arena/cas/_verify_cas"

cat > "${SRC_DIR}/run" <<\EOF
#!/bin/sh
echo "default"
EOF
chmod 0755 "${SRC_DIR}/run"
dd if=/dev/urandom of="${SRC_DIR}/weights.bin" bs=1024 count=128 status=none
tar --zstd -cf "$ARCHIVE" -C "$SRC_DIR" .

/opt/homebrew/bin/node -e "
  const {unpackBundle} = require(\"/opt/arena/repo/build/arena/unpack\");
  console.log(\"UNPACK_OK:\", unpackBundle(\"$ARCHIVE\", \"$DEST_1\", \"$CAS_DIR\"), \"bytes\");
  console.log(\"UNPACK_OK:\", unpackBundle(\"$ARCHIVE\", \"$DEST_2\", \"$CAS_DIR\"), \"bytes\");
"

rm -rf "$SRC_DIR" "$ARCHIVE" "$DEST_1" "$DEST_2" "$CAS_DIR"
echo "PASS: unpack + APFS CoW CAS deduplication verified"
'
```

*Expected:* Two `UNPACK_OK: ... bytes` lines followed by
`PASS: unpack + APFS CoW CAS deduplication verified`.

##### Test 5E: Verify Podman VM Memory (`30 GiB`, Zero Swap), Storage Cap & Container Sandbox Execution

```sh
ssh arena '
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

# 1. Verify ~30 GiB RAM, 0B swap, and kernel socket module blacklist inside the rootless VM
podman machine ssh podman-machine-default "free -h && test -f /etc/modprobe.d/arena-blacklist.conf"

# 2. Build a tiny local OCI test image and run it through /opt/arena/bin/arena
CTX_DIR="$(mktemp -d /Volumes/Staging/podman-verify-XXXXXX)"
cat > "${CTX_DIR}/Containerfile" <<\EOF
FROM docker.io/library/alpine:latest
ENTRYPOINT ["/bin/sh", "-c", "echo scratch-ok > /scratch/marker.txt && read -r line && echo default"]
EOF
podman build --platform linux/arm64 -t arena-verify-oci:latest "$CTX_DIR" >/dev/null
rm -rf "$CTX_DIR"

OUT="$(printf "|request|{\"active\":[{\"moves\":[{\"id\":\"tackle\"}]}]}\n" | /opt/arena/bin/arena run p1 container arena-verify-oci:latest)"
sudo -n /opt/arena/bin/arena cleanup p1 container
podman rmi -f arena-verify-oci:latest >/dev/null
REMAINING="$(sudo find /Volumes/P1/scratch -mindepth 1 | wc -l | tr -d " ")"

echo "Container stdout: ${OUT} | Remaining files in /Volumes/P1/scratch: ${REMAINING}"
[[ "$OUT" == "default" && "$REMAINING" == "0" ]] && echo "PASS: Podman container sandbox + virtiofs /Volumes/P1/scratch mount verified"
'
```

*Expected:*
- `Mem: 29Gi ...` and `Swap: 0B`.
- `Container stdout: default | Remaining files in /Volumes/P1/scratch: 0`
- `PASS: Podman container sandbox + virtiofs /Volumes/P1/scratch mount verified`

##### Test 5F: Run the Repository Unit & Integration Test Suite on the Mac mini

```sh
ssh arena '
export PATH="/opt/homebrew/bin:$PATH"
cd /opt/arena/repo
npx vitest run test/arena.test.ts
'
```

*Expected:* All tests in `test/arena.test.ts` pass (`PASS`).

---

## Phase 6: Start the Arena Coordinator (`ai.pkmn.arena`) & Verify End-to-End Heartbeats

### Step 6.1: Run a Single-Pass Foreground Check (`once: true`)

Before loading the persistent background daemon, run one coordinator cycle in the foreground to
verify SQLite state initialization (`/opt/arena/state/arena.sqlite`), outbox flushing, and ladder
snapshot polling:

```sh
ssh arena '
export PATH="/opt/arena/bin:/opt/homebrew/bin:$PATH"
cd /opt/arena/repo
/opt/homebrew/bin/node --env-file-if-exists=/opt/arena/repo/.env -e "
  require(\"./build/arena\").runDaemon({once: true}).then(() => console.log(\"PASS: Coordinator single pass OK\"));
"
'
```

### Step 6.2: Bootstrap the `ai.pkmn.arena` LaunchDaemon

Load `ai.pkmn.arena.plist` so `launchd` starts the coordinator automatically at boot on the M6's
Efficiency cores (`/usr/sbin/taskpolicy -b`) and keeps it alive:

```sh
ssh arena '
sudo launchctl bootout system/ai.pkmn.arena 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.arena.plist
'
```

#### Verify Phase 6

1. **Verify all three `ai.pkmn.*` LaunchDaemons are loaded on the Mac mini:**
   ```sh
   ssh arena '
   sudo launchctl print system/ai.pkmn.tunnel | grep -E "state =|pid ="
   sudo launchctl print system/ai.pkmn.arena  | grep -E "state =|pid ="
   sudo pfctl -s info | head -n 1
   ls -lh /opt/arena/state/arena.sqlite*
   cat /opt/arena/logs/arena.err
   '
   ```
   *Expected:* Both `ai.pkmn.tunnel` and `ai.pkmn.arena` report `state = running`, `pf` reports
   `Status: Enabled`, `/opt/arena/state/arena.sqlite` exists in WAL mode, and `/opt/arena/logs/arena.err`
   is empty.

2. **Verify `pkmn.ai` is receiving live heartbeats from the Mac mini:**
   Wait ~6 seconds (one idle poll interval), then run from your **admin laptop**:
   ```sh
   curl -fsS https://pkmn.ai/api/live.json | jq '{updatedAt, stale, live}'
   ```
   *Expected:* `"stale": false` and `"updatedAt"` within the last few seconds.

---

## Phase 7: Google Cloud Storage (`gs://pkmn-arena`), Nightly Archival & SQLite Backup (`arena/scripts/archive.sh`)

`arena/coordinator.ts` and `arena/scripts/archive.sh` manage local `/Volumes/Archive` storage and
off-site mirroring to Google Cloud Storage (`gs://pkmn-arena`):
1. Online SQLite `.backup` of `/opt/arena/state/arena.sqlite` ->
   `/Volumes/Archive/db-backups/arena-state-YYYY-MM-DD.sqlite.zst` (retaining 30 days locally, run by
   `archive.sh`).
2. Daily solid LZMA2 `.7z` compression of completed past-day raw `.log` directories per ladder under
   `/Volumes/Archive/logs/<ladder_id>/<YYYY-MM>/<YYYY-MM-DD>.7z` (owned by `arena/coordinator.ts` on
   UTC day rollover, plus `<ladder_id>-logs.tar` rebuild/upload for `random` and retired `pools`
   ladders).
3. Monthly `.tar` rollup of the previous month's `.7z` archives on the 1st of each month (run by
   `archive.sh`).
4. Nightly `gcloud storage rsync` (when `ARENA_GCS_SYNC=1` is set in `/opt/arena/repo/.env`) to
   `gs://pkmn-arena/{archives,agents,db-backups}`.

### Step 7.1: Configure Least-Privilege GCS Service Account & Authenticate `gcloud` on the Mac mini

Because the `gs://pkmn-arena` bucket already exists, create a dedicated service account scoped
**exclusively** to `gs://pkmn-arena` (never install personal owner credentials on the Mac mini) and
activate it under the `pkmn` coordinator user:

1. **On your admin laptop** (authenticated to your GCP project), create the `arena-archiver` service
   account, grant it `roles/storage.objectAdmin` on `gs://pkmn-arena`, and copy its key to the Mac
   mini:
   ```sh
   GCP_PROJECT="$(gcloud config get-value project)"
   SA_EMAIL="arena-archiver@${GCP_PROJECT}.iam.gserviceaccount.com"

   gcloud iam service-accounts create arena-archiver \
     --display-name="pkmn.ai Mac mini Archiver" \
     --project="$GCP_PROJECT" || true

   gcloud storage buckets add-iam-policy-binding gs://pkmn-arena \
     --member="serviceAccount:${SA_EMAIL}" \
     --role="roles/storage.objectAdmin"

   # Required when gs://pkmn-arena has Requester Pays enabled:
   gcloud services enable cloudresourcemanager.googleapis.com --project="$GCP_PROJECT"
   gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
     --member="serviceAccount:${SA_EMAIL}" \
     --role="roles/serviceusage.serviceUsageConsumer"

   umask 077
   gcloud iam service-accounts keys create /tmp/arena-gcs-key.json \
     --iam-account="$SA_EMAIL"
   scp /tmp/arena-gcs-key.json arena:/opt/arena/state/gcs-key.json
   rm -f /tmp/arena-gcs-key.json
   ```

2. **On the Mac mini (`ssh arena`)**, lock down `/opt/arena/state/gcs-key.json`, activate the
   service account for `gcloud`, and enable `ARENA_GCS_SYNC=1` in `/opt/arena/repo/.env`:
   ```sh
   ssh arena "
   export PATH=\"/opt/homebrew/bin:\$PATH\"
   chmod 0600 /opt/arena/state/gcs-key.json
   chown pkmn:agents /opt/arena/state/gcs-key.json
   gcloud auth activate-service-account --key-file=/opt/arena/state/gcs-key.json
   gcloud config set project ${GCP_PROJECT}
   gcloud config set billing/quota_project ${GCP_PROJECT}
   grep -q '^ARENA_GCS_SYNC=' /opt/arena/repo/.env || printf 'ARENA_GCS_SYNC=1\n' >> /opt/arena/repo/.env
   grep -q '^CLOUDSDK_CONFIG=' /opt/arena/repo/.env || printf 'CLOUDSDK_CONFIG=/Users/pkmn/.config/gcloud\n' >> /opt/arena/repo/.env
   grep -q '^CLOUDSDK_CORE_PROJECT=' /opt/arena/repo/.env || printf 'CLOUDSDK_CORE_PROJECT=${GCP_PROJECT}\n' >> /opt/arena/repo/.env
   grep -q '^CLOUDSDK_BILLING_QUOTA_PROJECT=' /opt/arena/repo/.env || printf 'CLOUDSDK_BILLING_QUOTA_PROJECT=${GCP_PROJECT}\n' >> /opt/arena/repo/.env
   sudo -n /bin/launchctl kickstart -k system/ai.pkmn.arena
   "
   ```

### Step 7.2: Bootstrap `ai.pkmn.archive.plist` (Runs Daily at 04:30)

`setup-arena.sh` already installed `/Library/LaunchDaemons/ai.pkmn.archive.plist`. Bootstrap it so
`launchd` runs `/opt/arena/repo/arena/scripts/archive.sh` daily at `04:30`:

```sh
ssh arena '
sudo launchctl bootout system/ai.pkmn.archive 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.archive.plist
'
```

#### Verify Phase 7

Trigger `/opt/arena/repo/arena/scripts/archive.sh` once manually and verify both the local SQLite
backup and the `gs://pkmn-arena` bucket sync succeed:

```sh
ssh arena '
export PATH="/opt/homebrew/bin:$PATH"
/opt/arena/repo/arena/scripts/archive.sh
ls -lh /Volumes/Archive/db-backups/
zstd -t /Volumes/Archive/db-backups/arena-state-*.sqlite.zst && echo "PASS: SQLite backup archive verified"
gcloud storage ls gs://pkmn-arena/db-backups/ && echo "PASS: GCS bucket sync verified"
'
```

---

## Phase 8: Ongoing Deployment, Operations & Troubleshooting Runbook

### 8.1 Deploying Code Updates to the Mac mini (`arena`)

Whenever changes to `arena/`, `server/arena.ts`, `server/protocol.ts`, `server/ratings.ts`,
`server/teams.ts`, or `@pkmn/sim` are pushed to `main`, deploy them to the Mac mini from your
**admin laptop**:

```sh
# Pull main on the Mac mini, compile, verify build/arena, and drain via SIGUSR1:
npm run deploy:arena
```

`npm run deploy:arena` runs [`./arena/scripts/deploy.sh`](scripts/deploy.sh) on the Mac mini, which
verifies a fast-forward merge from `origin/main`, installs `npm` dependencies if `package.json`
changed, compiles TypeScript, smoke-tests `build/arena` (rolling back automatically on failure), and
sends `SIGUSR1` to `ai.pkmn.arena` so the coordinator finishes its in-flight match, flushes the
`outbox`, and exits cleanly for `launchd` (`KeepAlive = true`, `ExitTimeOut = 900`) to respawn on
the new code.

If a commit modifies native helpers or system configs (`arena/bin/limit.c`, `arena/bin/arena`,
`arena/config/sandbox.sb`, `arena/config/sudoers`, `arena/config/pf.anchor`, or
`arena/config/*.plist`), re-run `setup-arena.sh` (which is idempotent) and drain/restart the daemon:

```sh
ssh -t arena '
export PATH="/opt/homebrew/bin:$PATH"
cd /opt/arena/repo
./arena/scripts/deploy.sh
./arena/scripts/setup-arena.sh
sudo launchctl kickstart -k system/ai.pkmn.arena
'
```

*(Note: When `ai.pkmn.arena` restarts mid-match, `coord.recoverIncompleteMatches()` automatically
resumes from `/opt/arena/state/arena.sqlite` at Game 1 or Game 2 using the persisted PRNG `seed`
and packed teams, and flushes any queued `outbox` payloads before starting a new match.)*

### 8.2 Syncing Read-Only Format Stats (`/opt/arena/stats/`)

`/opt/arena/stats/` is mounted read-only as `PKMN_STATS_DIR=/opt/arena/stats` in every agent
sandbox (native bundles and containers). Populate it using the `data.pkmn.cc` layout specified in
`/rules`:

- **Fixed ladders (`gen1ou`, `gen3ou`, `gen9ou`):**
  - `/opt/arena/stats/<format>.json` (`gen1ou.json`, `gen3ou.json`, `gen9ou.json`)
- **Seasonal `RAND` (`gen9randombattle`, or future `gen10randombattle`):** `data.pkmn.cc`'s
  hierarchy scoped to the active format:
  - `/opt/arena/stats/<format>.json`
  - `/opt/arena/stats/exact/<format>.json`
  - `/opt/arena/stats/full/<format>/*`
  - `/opt/arena/stats/stats/<format>.json`
  - `/opt/arena/stats/js/<format>.json`
- **`VGC`:** no usage statistics provided.

```sh
ssh arena 'sudo mkdir -p /opt/arena/stats && sudo chown -R pkmn:agents /opt/arena/stats'
rsync -avz --delete stats/ arena:/opt/arena/stats/
ssh arena 'sudo chmod -R a+rX,go-w /opt/arena/stats'
```

### 8.3 Common Operator Diagnostics & Emergency Recovery

| Task | Command (from Admin Laptop) |
| :--- | :--- |
| **Tail coordinator logs** | `ssh arena 'tail -f /opt/arena/logs/arena.log /opt/arena/logs/arena.err'` |
| **Tail SSH tunnel logs** | `ssh arena 'tail -f /opt/arena/logs/tunnel.log /opt/arena/logs/tunnel.err'` |
| **Restart coordinator** | `ssh arena 'sudo launchctl kickstart -k system/ai.pkmn.arena'` |
| **Restart SSH tunnel** | `ssh arena 'sudo launchctl kickstart -k system/ai.pkmn.tunnel'` |
| **Inspect local agent cache** | `ssh arena 'sqlite3 -header -column /opt/arena/state/arena.sqlite "SELECT version_id, slug, version, mode, residency, total_games, total_faults, consecutive_faults FROM local_agents;"'` |
| **Inspect incomplete / recent matches** | `ssh arena 'sqlite3 -header -column /opt/arena/state/arena.sqlite "SELECT id, ladder_id, p1_slug, p2_slug, status, g1_outcome, updated_at FROM local_matches ORDER BY started_at DESC LIMIT 10;"'` |
| **Inspect pending RPC outbox** | `ssh arena 'sqlite3 -header -column /opt/arena/state/arena.sqlite "SELECT id, endpoint, created_at FROM outbox;"'` |
| **Emergency slot cleanup** | `ssh arena 'sudo -n /opt/arena/bin/arena cleanup p1 native && sudo -n /opt/arena/bin/arena cleanup p2 native && sudo -n /opt/arena/bin/arena cleanup p1 container && sudo -n /opt/arena/bin/arena cleanup p2 container'` |
| **Check Podman VM health** | `ssh arena '/opt/homebrew/bin/podman machine list && /opt/homebrew/bin/podman ps -a'` |

### 8.4 Full Unattended Reboot Persistence Test

Once Phases 1–7 are complete, perform one unattended reboot test to confirm the Mac mini comes back
online headlessly and reconnects `ai.pkmn.tunnel`, `ai.pkmn.pf`, and `ai.pkmn.arena` without a
monitor or keyboard attached:

```sh
ssh arena 'sudo reboot'
```

Wait ~60–90 seconds, then verify from your **admin laptop**:

```sh
ssh arena '
uptime
sudo pfctl -s info | head -n 1
sudo launchctl print system/ai.pkmn.tunnel  | grep -E "state =|pid ="
sudo launchctl print system/ai.pkmn.arena   | grep -E "state =|pid ="
sudo launchctl print system/ai.pkmn.archive | grep -E "state ="
/opt/homebrew/bin/podman machine list
'
curl -fsS https://pkmn.ai/api/live.json | jq '{updatedAt, stale}'
```

**Expected Output:**
- `ssh arena` connects via `ProxyJump pkmn.ai`.
- `pf` is `Enabled`.
- Both `ai.pkmn.tunnel` and `ai.pkmn.arena` are `running`, and `ai.pkmn.archive` is loaded.
- `podman-machine-default` shows `Currently running` (`10` vCPUs, `30GiB` RAM).
- `https://pkmn.ai/api/live.json` reports `"stale": false`.
