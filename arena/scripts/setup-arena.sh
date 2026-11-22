#!/usr/bin/env bash
# arena/scripts/setup-arena.sh
# One-time provisioning script for the Apple Silicon Mac mini Arena runner.
# Run as `pkmn` (with sudo privileges) after cloning /opt/arena/repo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APFS_CONTAINER="${ARENA_APFS_CONTAINER:-disk3}"

echo "==> Step 1: Creating quota-capped APFS volumes (P1, P2 at 4G; Staging at 6G)"
for VOL in P1 P2; do
  if [[ ! -d "/Volumes/${VOL}" ]]; then
    sudo diskutil apfs addVolume "$APFS_CONTAINER" APFS "$VOL" -quota 4G
  fi
done
if [[ ! -d "/Volumes/Staging" ]]; then
  sudo diskutil apfs addVolume "$APFS_CONTAINER" APFS "Staging" -quota 6G
fi

echo "==> Step 2: Creating unprivileged role accounts p1 (UID/GID 591) and p2 (UID/GID 592)"
create_agent_user() {
  local user="$1"
  local uid="$2"
  local home="$3"
  if ! dscl . -read "/Groups/${user}" >/dev/null 2>&1; then
    sudo dscl . -create "/Groups/${user}"
  fi
  sudo dscl . -create "/Groups/${user}" PrimaryGroupID "$uid"
  if ! dscl . -read "/Users/${user}" >/dev/null 2>&1; then
    sudo dscl . -create "/Users/${user}"
  fi
  sudo dscl . -create "/Users/${user}" UniqueID "$uid"
  sudo dscl . -create "/Users/${user}" PrimaryGroupID "$uid"
  sudo dscl . -create "/Users/${user}" UserShell /usr/bin/false
  sudo dscl . -create "/Users/${user}" NFSHomeDirectory "$home"
  sudo dscl . -create "/Users/${user}" IsHidden 1
  sudo dscl . -delete "/Users/${user}" AuthenticationAuthority 2>/dev/null || true
  sudo dscl . -create "/Users/${user}" Password "*"
}

create_agent_user p1 591 /Volumes/P1/scratch
create_agent_user p2 592 /Volumes/P2/scratch

echo "==> Step 3: Locking down volume and directory ownership and permissions"
# Keep APFS mount roots `/Volumes/P1` and `/Volumes/P2` as `root:wheel` (`0711` + `user:pkmn`
# read/search ACL for `krunkit` `virtiofs`) so macOS SIP/MACF DataVault `.Spotlight-V100` and
# `.fseventsd`/`.Trashes` stay inaccessible to `p1`/`p2`, and isolate per-game writable state to
# `/Volumes/P{1,2}/scratch` (`0700` `root:wheel` + explicit ACLs omitting `writesecurity`, `chown`,
# `writeattr`, and `writeextattr`).
VOL_ACL="allow list,search,readattr,readextattr,readsecurity"
SCRATCH_ACL="allow list,add_file,search,delete,add_subdirectory,delete_child,readattr,readextattr,readsecurity"
sudo mkdir -p /Volumes/P1/scratch /Volumes/P2/scratch
sudo chown root:wheel /Volumes/P1 /Volumes/P2 /Volumes/P1/scratch /Volumes/P2/scratch
sudo chmod -N /Volumes/P1 /Volumes/P2 /Volumes/P1/scratch /Volumes/P2/scratch 2>/dev/null || true
sudo chmod 0711 /Volumes/P1 /Volumes/P2
sudo chmod +a "user:pkmn ${VOL_ACL}" /Volumes/P1 /Volumes/P2
sudo chmod 0700 /Volumes/P1/scratch /Volumes/P2/scratch
sudo chmod +a "user:pkmn ${SCRATCH_ACL}" /Volumes/P1/scratch /Volumes/P2/scratch
sudo chmod +a "user:p1 ${SCRATCH_ACL}" /Volumes/P1/scratch
sudo chmod +a "user:p2 ${SCRATCH_ACL}" /Volumes/P2/scratch
sudo chown pkmn:agents /Volumes/Staging
sudo chmod 0700 /Volumes/Staging

# Own `/opt/arena`, `/opt/arena/bin`, and `/opt/arena/etc` as `root:wheel` (`0755`) so the `pkmn`
# daemon account cannot unlink/replace `root`-executed `/opt/arena/bin/limit` or `sandbox.sb`.
sudo mkdir -p /opt/arena/{bin,etc,agents,cas/sha256,teams,stats,state}
sudo chown root:wheel /opt/arena /opt/arena/bin /opt/arena/etc
sudo chmod 0755 /opt/arena /opt/arena/bin /opt/arena/etc
sudo chown -R pkmn:agents /opt/arena/{agents,cas,teams,stats,state}
sudo chmod 0755 /opt/arena/{agents,stats}
sudo chmod 0700 /opt/arena/{cas,teams,state}

echo "==> Step 4: Installing system, SSH, PF, Seatbelt, and sudoers configs"
sudo cp "${REPO_DIR}/arena/config/sshd-arena.conf" /etc/ssh/sshd_config.d/100-arena-hardening.conf
sudo chown root:wheel /etc/ssh/sshd_config.d/100-arena-hardening.conf
sudo chmod 0644 /etc/ssh/sshd_config.d/100-arena-hardening.conf

sudo cp "${REPO_DIR}/arena/config/pf.anchor" /etc/pf.anchors/ai.pkmn.arena
sudo chown root:wheel /etc/pf.anchors/ai.pkmn.arena
sudo chmod 0644 /etc/pf.anchors/ai.pkmn.arena
sudo /sbin/pfctl -n -a com.apple/100.pkmn.arena -f /etc/pf.anchors/ai.pkmn.arena

sudo cp "${REPO_DIR}/arena/config/sandbox.sb" /opt/arena/etc/sandbox.sb
sudo chown root:wheel /opt/arena/etc/sandbox.sb
sudo chmod 0644 /opt/arena/etc/sandbox.sb

sudo cp "${REPO_DIR}/arena/config/sudoers" /etc/sudoers.d/arena
sudo chown root:wheel /etc/sudoers.d/arena
sudo chmod 0440 /etc/sudoers.d/arena
sudo visudo -cf /etc/sudoers.d/arena

echo "==> Step 5: Compiling limit.c and installing /opt/arena/bin helpers and _baseline agent"
BUILD_TMP="$(mktemp -d /tmp/arena-limit-build.XXXXXX)"
chmod 0700 "$BUILD_TMP"
clang -O2 -Wall -Wextra -o "${BUILD_TMP}/limit" "${REPO_DIR}/arena/bin/limit.c"
sudo install -o root -g wheel -m 0755 "${BUILD_TMP}/limit" /opt/arena/bin/limit
rm -rf "$BUILD_TMP"
sudo install -o root -g wheel -m 0755 "${REPO_DIR}/arena/bin/arena" /opt/arena/bin/arena

sudo mkdir -p /opt/arena/agents/_baseline
sudo cp "${REPO_DIR}/arena/bin/baseline" /opt/arena/agents/_baseline/run
sudo chown -R root:wheel /opt/arena/agents/_baseline
sudo chmod 0755 /opt/arena/agents/_baseline /opt/arena/agents/_baseline/run

echo "==> Step 6: Configuring headless power management & disabling Spotlight on scratch volumes"
sudo pmset -a womp 1 powernap 0
sudo defaults write /Library/Preferences/SystemConfiguration/autodiskmount \
  AutomountDisksWithoutUserLogin -bool true
sudo mdutil -i off /Volumes/P1 /Volumes/P2 /Volumes/Staging 2>/dev/null || true
sudo touch /Volumes/P1/.metadata_never_index /Volumes/P2/.metadata_never_index \
  /Volumes/Staging/.metadata_never_index
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall -bool false

if [[ -x /opt/homebrew/bin/7zz && ! -e /opt/homebrew/bin/7z ]]; then
  ln -sf /opt/homebrew/bin/7zz /opt/homebrew/bin/7z
fi

echo "==> Step 7: Initializing Podman libkrun VM (10 vCPUs, 30 GiB RAM, 48 GB disk, zero swap)"
if command -v podman >/dev/null 2>&1; then
  if ! podman machine inspect podman-machine-default >/dev/null 2>&1; then
    # Size the VM to cover two 14 GiB containers (`arena-p1` + `arena-p2`, since `podman pause`
    # freezes cgroups in RAM without releasing pages) plus 2 GiB guest VM overhead (30 GiB =
    # 30,720 MiB), with zero swap (`--memory=14g --memory-swap=14g`) to prevent SSD writes.
    # Containers run rootless with `--read-only` + `--tmpfs /tmp:size=500m` + `4G` APFS `/scratch`
    # (note: rootless Podman cannot use `overlay.size` project quotas, which require `CAP_MKNOD`).
    # Share `/opt/arena/stats` read-only for `PKMN_STATS_DIR` (never `/Volumes/Staging` auth files).
    podman machine init \
      --cpus 10 \
      --memory 30720 \
      --disk-size 48 \
      --volume /Volumes/P1:/Volumes/P1 \
      --volume /Volumes/P2:/Volumes/P2 \
      --volume /opt/arena/stats:/opt/arena/stats:ro \
      podman-machine-default
  fi
  WAS_RUNNING="$(podman machine inspect --format '{{.State}}' podman-machine-default 2>/dev/null || true)"
  podman machine start podman-machine-default 2>/dev/null || true
  # Block uncommon Linux socket modules (`sctp`, `dccp`, `rds`, `tipc`) from auto-loading inside
  # the shared Podman VM when untrusted containers invoke `socket(...)` (e.g. CVE-2026-64564).
  podman machine ssh podman-machine-default \
    'printf "install sctp /bin/false\nblacklist sctp\ninstall dccp /bin/false\nblacklist dccp\ninstall rds /bin/false\nblacklist rds\ninstall tipc /bin/false\nblacklist tipc\n" | sudo tee /etc/modprobe.d/arena-blacklist.conf >/dev/null && sudo chmod 0644 /etc/modprobe.d/arena-blacklist.conf && { sudo modprobe -r sctp dccp rds tipc 2>/dev/null || true; }'
  if [[ "$WAS_RUNNING" != "running" ]]; then
    # Stop the interactive VM before bootstrapping `ai.pkmn.podman.plist` (`RunAtLoad=true`) so
    # `launchd` takes sole ownership of `podman-machine-default` without colliding on the disk image.
    podman machine stop podman-machine-default 2>/dev/null || true
  fi
fi

echo "==> Step 8: Installing LaunchDaemons (ai.pkmn.pf, ai.pkmn.podman, ai.pkmn.arena, ai.pkmn.maintenance)"
for PLIST in ai.pkmn.pf.plist ai.pkmn.podman.plist ai.pkmn.arena.plist ai.pkmn.maintenance.plist; do
  sudo cp "${REPO_DIR}/arena/config/${PLIST}" "/Library/LaunchDaemons/${PLIST}"
  sudo chown root:wheel "/Library/LaunchDaemons/${PLIST}"
  sudo chmod 0644 "/Library/LaunchDaemons/${PLIST}"
done

echo "==> Setup complete. Load LaunchDaemons with:"
echo "    sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.pf.plist"
echo "    sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.podman.plist"
echo "    sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.arena.plist"
echo "    sudo launchctl bootstrap system /Library/LaunchDaemons/ai.pkmn.maintenance.plist"
