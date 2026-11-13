#!/usr/bin/env bash
# arena/scripts/setup-arena.sh
# One-time provisioning script for the Apple Silicon Mac mini Arena runner.
# Run as `pkmn` (with sudo privileges) after cloning /opt/arena/repo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APFS_CONTAINER="${ARENA_APFS_CONTAINER:-disk3}"

echo "==> Step 1: Creating quota-capped APFS volumes (P1, P2, Staging)"
for VOL in P1 P2 Staging; do
  if [[ ! -d "/Volumes/${VOL}" ]]; then
    sudo diskutil apfs addVolume "$APFS_CONTAINER" APFS "$VOL" -quota 10G
  fi
done

echo "==> Step 2: Creating role accounts p1 (UID 591) and p2 (UID 592) in group agents (GID 590)"
if ! dscl . -read /Groups/agents >/dev/null 2>&1; then
  sudo dscl . -create /Groups/agents
  sudo dscl . -create /Groups/agents PrimaryGroupID 590
fi
sudo dscl . -append /Groups/agents GroupMembership pkmn || true

create_agent_user() {
  local user="$1"
  local uid="$2"
  local home="$3"
  if ! dscl . -read "/Users/${user}" >/dev/null 2>&1; then
    sudo dscl . -create "/Users/${user}"
  fi
  sudo dscl . -create "/Users/${user}" UniqueID "$uid"
  sudo dscl . -create "/Users/${user}" PrimaryGroupID 590
  sudo dscl . -create "/Users/${user}" UserShell /usr/bin/false
  sudo dscl . -create "/Users/${user}" NFSHomeDirectory "$home"
  sudo dscl . -create "/Users/${user}" IsHidden 1
  sudo dscl . -delete "/Users/${user}" AuthenticationAuthority 2>/dev/null || true
  sudo dscl . -create "/Users/${user}" Password "*"
}

create_agent_user p1 591 /Volumes/P1
create_agent_user p2 592 /Volumes/P2

echo "==> Step 3: Locking down volume ownership and permissions"
sudo chown p1:agents /Volumes/P1
sudo chmod 1700 /Volumes/P1
sudo chown p2:agents /Volumes/P2
sudo chmod 1700 /Volumes/P2
sudo chown pkmn:agents /Volumes/Staging
sudo chmod 0700 /Volumes/Staging

sudo mkdir -p /opt/arena/{bin,etc,agents,cas/sha256,teams,state,logs}
sudo chown -R pkmn:agents /opt/arena
sudo chmod 0755 /opt/arena /opt/arena/bin /opt/arena/etc /opt/arena/agents
sudo chmod 0750 /opt/arena/cas /opt/arena/teams /opt/arena/state /opt/arena/logs

if [[ -d /Volumes/Archive ]]; then
  sudo mkdir -p /Volumes/Archive/{logs,db-backups,cold-agents}
  sudo chown -R pkmn:agents /Volumes/Archive
  sudo chmod 0750 /Volumes/Archive/{logs,db-backups,cold-agents}
fi

echo "==> Step 4: Installing system, SSH, PF, Seatbelt, and sudoers configs"
sudo cp "${REPO_DIR}/arena/config/sshd-arena.conf" /etc/ssh/sshd_config.d/100-arena-hardening.conf
sudo chown root:wheel /etc/ssh/sshd_config.d/100-arena-hardening.conf
sudo chmod 0644 /etc/ssh/sshd_config.d/100-arena-hardening.conf

sudo cp "${REPO_DIR}/arena/config/pf.anchor" /etc/pf.anchors/ai.pkmn.arena
sudo chown root:wheel /etc/pf.anchors/ai.pkmn.arena
sudo chmod 0644 /etc/pf.anchors/ai.pkmn.arena
if ! grep -q "ai.pkmn.arena" /etc/pf.conf; then
  printf '\nanchor "ai.pkmn.arena"\nload anchor "ai.pkmn.arena" from "/etc/pf.anchors/ai.pkmn.arena"\n' \
    | sudo tee -a /etc/pf.conf >/dev/null
fi
sudo pfctl -nf /etc/pf.conf

sudo cp "${REPO_DIR}/arena/config/sandbox.sb" /opt/arena/etc/sandbox.sb
sudo chown root:wheel /opt/arena/etc/sandbox.sb
sudo chmod 0644 /opt/arena/etc/sandbox.sb

sudo cp "${REPO_DIR}/arena/config/sudoers" /etc/sudoers.d/arena
sudo chown root:wheel /etc/sudoers.d/arena
sudo chmod 0440 /etc/sudoers.d/arena
sudo visudo -cf /etc/sudoers.d/arena

echo "==> Step 5: Compiling limit.c and installing /opt/arena/bin helpers"
clang -O2 -Wall -Wextra -o /tmp/arena-limit "${REPO_DIR}/arena/bin/limit.c"
sudo mv /tmp/arena-limit /opt/arena/bin/limit
sudo cp "${REPO_DIR}/arena/bin/arena" /opt/arena/bin/arena
sudo cp "${REPO_DIR}/arena/bin/unpack" /opt/arena/bin/unpack
sudo chown root:wheel /opt/arena/bin/limit /opt/arena/bin/arena /opt/arena/bin/unpack
sudo chmod 0755 /opt/arena/bin/limit /opt/arena/bin/arena /opt/arena/bin/unpack

echo "==> Step 6: Configuring headless power management & disabling Spotlight on scratch volumes"
sudo pmset -a sleep 0 disksleep 0 displaysleep 0 autorestart 1 womp 1 powernap 0
sudo mdutil -i off /Volumes/P1 /Volumes/P2 /Volumes/Staging 2>/dev/null || true
if [[ -d /Volumes/Archive ]]; then
  sudo mdutil -i off /Volumes/Archive 2>/dev/null || true
fi
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall -bool false

echo "==> Step 7: Initializing Podman libkrun VM (8 vCPUs, 14 GiB RAM, 64 GB disk)"
if command -v podman >/dev/null 2>&1; then
  if ! podman machine inspect podman-machine-default >/dev/null 2>&1; then
    podman machine init \
      --cpus 8 \
      --memory 14336 \
      --disk-size 64 \
      --volume /Volumes/P1:/Volumes/P1 \
      --volume /Volumes/P2:/Volumes/P2 \
      --volume /Volumes/Staging:/Volumes/Staging \
      podman-machine-default
  fi
fi

echo "==> Step 8: Installing LaunchDaemons (ai.pkmn.pf, ai.pkmn.tunnel, ai.pkmn.arena)"
for PLIST in ai.pkmn.pf.plist ai.pkmn.tunnel.plist ai.pkmn.arena.plist; do
  sudo cp "${REPO_DIR}/arena/config/${PLIST}" "/Library/LaunchDaemons/${PLIST}"
  sudo chown root:wheel "/Library/LaunchDaemons/${PLIST}"
  sudo chmod 0644 "/Library/LaunchDaemons/${PLIST}"
done

echo "==> Setup complete. Load LaunchDaemons with:"
echo "    sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.pf.plist"
echo "    sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.tunnel.plist"
echo "    sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.arena.plist"
