# Setup

**pkmn.ai** runs on [Ubuntu](#ubuntu) [LTS](https://wiki.ubuntu.com/Releases) with [nginx](#nginx)
proxying to [Node](#node) behind [Cloudflare](#cloudflare). This covers one-time server provisioning
and OS maintenance; see [ADMIN.md](ADMIN.md) for app ops and [DEVELOPMENT.md](DEVELOPMENT.md) /
[TESTING.md](TESTING.md) for local dev.

## Cloudflare

Configure `pkmn.ai` on [Cloudflare](https://dash.cloudflare.com/) using Cloudflare's nameservers and
set **SSL/TLS** to **Full (strict)** (see [certbot renewal troubleshooting](https://omicx.cc/posts/2020-08-04-enable-certbot-automatic-renewal-for-cloudflare-cdn/) if renewal fails):

| Type | Name | Content | Proxy | TTL |
| --- | --- | --- | --- | --- |
| `A` | `*` / `pkmn.ai` / `www` | *`123.45.67.89`* | `Proxied` | `Auto` |

Cloudflare doesn't proxy SSH, so map `pkmn.ai` directly in `/etc/hosts` (`123.45.67.89 pkmn.ai`) or
`~/.ssh/config`:

```ssh-config
Host pkmn.ai
  HostName 123.45.67.89
  ForwardAgent no
```

## Ubuntu

As `root`, create `pkmn`, copy authorized SSH keys, enforce key-only SSH, and enable `ufw`:

```sh
adduser pkmn
mkdir -m 700 ~pkmn/.ssh
cp ~/.ssh/authorized_keys ~pkmn/.ssh/authorized_keys
chmod 600 ~pkmn/.ssh/authorized_keys && chown -R pkmn:pkmn ~pkmn/.ssh
```

Ensure `/etc/ssh/sshd_config` has `PasswordAuthentication no`, `PubkeyAuthentication yes`, and
`AuthorizedKeysFile .ssh/authorized_keys`, then validate/restart (`sshd -t && service ssh restart`):

```sh
ufw allow OpenSSH && ufw enable && ufw status
```

Install base packages and blacklist unused kernel socket modules (`sctp`, `dccp`, `rds`, `tipc`):

```sh
apt-get install -y git curl build-essential sqlite3 zstd
cat <<'EOF' > /etc/modprobe.d/arena-blacklist.conf
install sctp /bin/false
blacklist sctp
install dccp /bin/false
blacklist dccp
install rds /bin/false
blacklist rds
install tipc /bin/false
blacklist tipc
EOF
chmod 0644 /etc/modprobe.d/arena-blacklist.conf
modprobe -r sctp dccp rds tipc 2>/dev/null || true
```

Create the shell-less `tunnel` user for the Mac mini's bidirectional SSH tunnel
(`-L 127.0.0.1:1234:127.0.0.1:1234`, `-R 127.0.0.1:2222:127.0.0.1:22`; see
[`arena/SETUP.md`](../arena/SETUP.md)):

```sh
adduser --system --no-create-home --shell /usr/sbin/nologin tunnel
mkdir -p /etc/ssh/authorized_keys
touch /etc/ssh/authorized_keys/tunnel && chmod 644 /etc/ssh/authorized_keys/tunnel
cat <<'EOF' > /etc/ssh/sshd_config.d/arena-tunnel.conf
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
/usr/sbin/sshd -t && service ssh reload
```

### Package & LTS Maintenance

```sh
# Regular updates
apt-get update && apt-get upgrade -y && apt-get dist-upgrade -y
apt --purge autoremove -y && apt-get autoclean && snap refresh && reboot

# Ubuntu LTS upgrade
cat /etc/lsb-release && apt install -y update-manager-core && do-release-upgrade -d && cat /etc/lsb-release
```

## Node

As `root`, install [`n`](https://github.com/tj/n) via [`n-install`](https://github.com/mklement0/n-install),
symlink into `/usr/bin`, and remove the aliases `n-install` adds to `~root/.bashrc`:

```sh
curl -sL https://git.io/n-install | N_PREFIX=/opt/n bash -s -- -y
for bin in node npm npx; do ln -s /opt/n/bin/$bin /usr/bin/$bin; done
vim ~/.bashrc
```

Periodic Node/`npm` updates:

```sh
N_PREFIX=/opt/n /opt/n/bin/n-update -y
N_PREFIX=/opt/n /opt/n/bin/n lts
N_PREFIX=/opt/n /opt/n/bin/n prune
N_PREFIX=/opt/n npm install -g npm@latest
service pkmn.ai-server restart
```

## Discord

In the [Discord Developer Portal](https://discord.com/developers/applications/689315793569447954/information)
(app `689315793569447954`, guild `689316505560809576`):

1. **General Information:** Set **Interactions Endpoint URL** to
   `https://pkmn.ai/discord/interactions` (after `pkmn.ai-server` is running).
2. **OAuth2:** Add redirect `https://pkmn.ai/auth/discord/callback`; set
   `DISCORD_CLIENT_ID=689315793569447954` and `DISCORD_CLIENT_SECRET` in `.env`.
3. **Bot:** Disable **Public Bot**; enable **Server Members Intent** and **Message Content Intent**;
   set `DISCORD_BOT_TOKEN` (plus `VGC_BOT_TOKEN`, `SMOGON_TOKEN`) in `.env`.
4. **Installation:** Disable **User Install** and set **Install Link** to `None`.
5. **Invite** with `Manage Roles`, `View Channels`, `Send Messages`, `Manage Messages`,
   `Read Message History`, `Pin Messages` (`2251800082197504`):
   ```text
   https://discord.com/oauth2/authorize?client_id=689315793569447954&scope=bot+applications.commands&permissions=2251800082197504&guild_id=689316505560809576&disable_guild_select=true
   ```
6. **Roles:** In [Server Settings -> Roles](https://discord.com/channels/689316505560809576), place
   the `pkmn` role above all roles configured in `config/discord.yml` and `config/ladders.yml`.

## Authentication & Wiki

1. Create a [GitHub OAuth App](https://github.com/settings/developers) (personal or `pkmn` org):
   name `pkmn.ai`, homepage `https://pkmn.ai`, callback `https://pkmn.ai/auth/github/callback`,
   **Enable Device Flow** unchecked.
2. Put `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and 32-byte hex `SESSION_SECRET` / `ARENA_SECRET`
   (`openssl rand -hex 32`) in `.env`, then sync with `./private/sync`.
3. Provision SQLite dir (as `root`) and clone `pkmn/wiki` with a write deploy key (as `pkmn`):

```sh
install -d -o pkmn -g pkmn -m 0700 /var/lib/pkmn
su - pkmn -c 'git clone git@github.com:pkmn/wiki.git /home/pkmn/ai/wiki'
```

## pkmn.ai

Clone `/home/pkmn/ai` as `pkmn`:

```sh
su - pkmn -c 'git clone https://github.com/pkmn/ai.git /home/pkmn/ai'
```

As `root`, grant `pkmn` scoped `sudo` in `/etc/sudoers.d/pkmn` (`visudo -f /etc/sudoers.d/pkmn`;
`pkmn.ai-server.service` runs with `NoNewPrivileges=yes` and `ProtectHome=read-only` so the web
process itself cannot invoke `sudo` or edit `config/*`):

```sudoers
pkmn ALL=(root) NOPASSWD: /usr/sbin/nginx -t,/usr/sbin/service nginx reload,/usr/bin/systemctl daemon-reload,/usr/sbin/service pkmn.* *
```

Enable `systemd` units (`pkmn.ai-server.service`, `pkmn.ai-backup.service`, `pkmn.ai-backup.timer`)
and run the initial deploy:

```sh
for f in /home/pkmn/ai/config/*.{service,timer}; do
  name=$(basename "$f")
  systemctl enable "$f"
  [[ $name == *.timer || $name == pkmn.ai-server.service ]] && systemctl start "$name"
done
su - pkmn -c 'cd /home/pkmn/ai && ./deploy restart'
```

### Logs & SQLite Backups

```sh
systemctl status pkmn.ai-server
systemctl list-timers 'pkmn.ai*'
systemctl daemon-reload && systemctl reset-failed
journalctl -fu pkmn.ai-server             # or: journalctl -xeu 'pkmn.ai*' / --vacuum-time=7d
```

`pkmn.ai-backup.timer` runs daily at `10:00 UTC` (randomized delay), backing up
`/var/lib/pkmn/arena.sqlite` via SQLite `.backup` to `/var/lib/pkmn/backups/arena-<ts>.sqlite.zst`
(30-day retention). On-demand backup and restore:

```sh
# Backup
systemctl start pkmn.ai-backup.service && ls -lh /var/lib/pkmn/backups/

# Restore (stop server first so WAL/SHM close cleanly)
service pkmn.ai-server stop
zstd -d -f /var/lib/pkmn/backups/arena-YYYYMMDDTHHMMSSZ.sqlite.zst -o /var/lib/pkmn/arena.sqlite.restore
chown pkmn:pkmn /var/lib/pkmn/arena.sqlite.restore && chmod 0600 /var/lib/pkmn/arena.sqlite.restore
mv -f /var/lib/pkmn/arena.sqlite.restore /var/lib/pkmn/arena.sqlite
rm -f /var/lib/pkmn/arena.sqlite-wal /var/lib/pkmn/arena.sqlite-shm
service pkmn.ai-server start
```

## nginx

Install `nginx`, grant `www-data` group access to `/home/pkmn/ai/{public,chat/logs}`, link
`config/nginx.conf`, and open HTTPS in `ufw`:

```sh
apt-get install -y nginx
usermod -a -G pkmn www-data
ln -s /home/pkmn/ai/config/nginx.conf /etc/nginx/sites-available/pkmn.ai
ln -s /etc/nginx/sites-{available,enabled}/pkmn.ai
ufw allow 'nginx Full' && ufw delete allow 'nginx HTTP' && ufw status
```

Bootstrap TLS via `certbot` (*comment out SSL directives in `nginx.conf` temporarily if needed*):

```sh
snap install --classic certbot && ln -s /snap/bin/certbot /usr/bin/certbot
certbot --nginx -d pkmn.ai -d www.pkmn.ai && service nginx restart
```

Check renewals (`snap.certbot.renew.timer`) and logs:

```sh
systemctl list-timers 'snap.certbot.renew*'
certbot renew --dry-run                   # manual: certbot renew && service nginx reload
journalctl -xeu nginx                     # access log: tail -f /var/log/nginx/access.log
```

Restore real client IPs from Cloudflare's `X-Forwarded-For` (required for per-IP rate limiting in
`config/nginx.conf`) by generating `/etc/nginx/conf.d/cloudflare.conf` (refresh periodically):

```sh
{
  curl -sL https://www.cloudflare.com/ips-v4 | sed 's/.*/set_real_ip_from &;/'
  curl -sL https://www.cloudflare.com/ips-v6 | sed 's/.*/set_real_ip_from &;/'
  echo 'real_ip_header X-Forwarded-For;'
} > /etc/nginx/conf.d/cloudflare.conf
nginx -t && service nginx reload
```
