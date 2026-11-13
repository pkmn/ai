# Setup

**pkmn.ai** runs on a virtual machine imaged with the current [Ubuntu](#ubuntu) [LTS
release](https://wiki.ubuntu.com/Releases), built on [nginx](#nginx) proxying to [Node](#node)
behind [Cloudflare](#cloudflare).

This document covers one-time server provisioning and OS-level maintenance (system packages, TLS
certificates, `systemd` units, `journalctl` logs, and backups). For application-level operator
commands, see [ADMIN.md](ADMIN.md); for local development and testing, see
[DEVELOPMENT.md](DEVELOPMENT.md) and [TESTING.md](TESTING.md).

## Cloudflare

Set up a `pkmn.ai` website in the [Cloudflare](https://dash.cloudflare.com/) dashboard and configure
your hosting provider's DNS settings to use the custom nameservers Cloudflare provides. The DNS
records should look like:

| Type | Name      | Content          | Proxy status | TTL    |
| ---- | --------- | ---------------- | ------------ | ------ |
| `A`  | `*`       | *`123.45.67.89`* | `Proxied`    | `Auto` |
| `A`  | `pkmn.ai` | *`123.45.67.89`* | `Proxied`    | `Auto` |
| `A`  | `www`     | *`123.45.67.89`* | `Proxied`    | `Auto` |

In the **SSL/TLS** section of the dashboard, set SSL/TLS encryption mode to "Full". If
[`certbot`](#nginx) encounters errors on renewal, follow the [troubleshooting
steps](https://omicx.cc/posts/2020-08-04-enable-certbot-automatic-renewal-for-cloudflare-cdn/).

Cloudflare doesn't proxy SSH connections, so to get `ssh pkmn@pkmn.ai` to work, set up a local DNS
record in `/etc/hosts`:

```diff
+123.45.67.89    pkmn.ai
```

If this doesn't work, update `~/.ssh/config` instead:

```diff
+Host pkmn.ai
+  HostName 123.45.67.89
+  ForwardAgent no
```

## Ubuntu

As `root`, create a `pkmn` user and set up the authorized SSH keys for passwordless remote login:

```sh
adduser pkmn
mkdir ~pkmn/.ssh
chmod 700 ~pkmn/.ssh
cat ~/.ssh/authorized_keys > ~pkmn/.ssh/authorized_keys
chmod 600 ~pkmn/.ssh/authorized_keys
```

If unable to log in as `pkmn` after the preceding steps, edit `/etc/ssh/sshd_config` and restart the
SSH daemon:

```sh
vim /etc/ssh/sshd_config
/usr/sbin/sshd -t
service ssh restart
```

Make sure the following fields are set in `/etc/ssh/sshd_config`:

```diff
+PasswordAuthentication no
+PubkeyAuthentication yes
+AuthorizedKeysFile .ssh/authorized_keys
```

Allow SSH traffic through the firewall and then enable the firewall:

```sh
ufw allow OpenSSH
ufw enable
ufw status
```

Install general packages required to set up and maintain the server:

```sh
apt-get install -y git curl build-essential sqlite3 zstd
```

Create a restricted, shell-less `tunnel` user so the Mac mini Arena runner can open an outbound SSH
tunnel (`-L 127.0.0.1:1234:127.0.0.1:1234` and `-R 127.0.0.1:2222:127.0.0.1:22`; see
[`arena/SETUP.md`](../arena/SETUP.md)) without shell access:

```sh
adduser --system --no-create-home --shell /usr/sbin/nologin tunnel
mkdir -p /etc/ssh/authorized_keys
touch /etc/ssh/authorized_keys/tunnel
chmod 644 /etc/ssh/authorized_keys/tunnel
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

### System Package & Release Maintenance

Periodically upgrade and clean up system packages (and `snap` packages):

```sh
apt-get update
apt-get upgrade -y
apt-get dist-upgrade -y
apt --purge autoremove -y
apt-get autoclean
snap refresh
reboot
```

To upgrade to a new Ubuntu LTS release, verify the current and upgraded versions via
`/etc/lsb-release`:

```sh
cat /etc/lsb-release
apt install update-manager-core -y
do-release-upgrade -d
cat /etc/lsb-release
```

## Node

As `root`, install [`n`](https://github.com/tj/n) to manage Node versions via
[`n-install`](https://github.com/mklement0/n-install):

```sh
curl -sL https://git.io/n-install | N_PREFIX=/opt/n bash -s -- -y
for binary in node npm npx; do ln -s /opt/n/bin/$binary /usr/bin/$binary; done
```

Remove the aliases `n` sets up in the `root` user's `.bashrc`:

```sh
vim ~/.bashrc
```

Periodically update `n`, Node, and `npm`, prune old Node versions, and restart the server:

```sh
N_PREFIX=/opt/n /opt/n/bin/n-update -y
N_PREFIX=/opt/n /opt/n/bin/n lts
N_PREFIX=/opt/n /opt/n/bin/n prune
N_PREFIX=/opt/n npm install -g npm@latest
service pkmn.ai-server restart
```

## Discord

1. In [Discord Developer Portal — General
   Information](https://discord.com/developers/applications/689315793569447954/information), set
   **Interactions Endpoint URL** to `https://pkmn.ai/discord/interactions` (after `pkmn.ai-server`
   is running).
2. Update the Redirect URI in the [Discord Developer Portal —
   OAuth2](https://discord.com/developers/applications/689315793569447954/oauth2) to
   `https://pkmn.ai/auth/discord/callback` and set `DISCORD_CLIENT_ID=689315793569447954` and
   `DISCORD_CLIENT_SECRET=...` in `.env`.
3. In the [Discord Developer Portal —
   Bot](https://discord.com/developers/applications/689315793569447954/bot) settings for `pkmn`:
   - Toggle **OFF** **Public Bot**.
   - Toggle **ON** **Server Members Intent** and **Message Content Intent** under **Privileged
     Gateway Intents**.
   - Copy the **Bot Token** into `DISCORD_BOT_TOKEN=...` in `.env` (alongside `VGC_BOT_TOKEN=...`
     and `SMOGON_TOKEN=...`).
4. In [Discord Developer Portal —
   Installation](https://discord.com/developers/applications/689315793569447954/installation),
   disable **User Install** and set **Install Link** to `None`.
5. Invite the `pkmn` Discord application to the server (`689316505560809576`) with `Manage Roles`,
   `View Channels`, `Send Messages`, `Manage Messages`, `Read Message History`, and `Pin Messages`
   (`2251800082197504`) permissions:

```text
https://discord.com/oauth2/authorize?client_id=689315793569447954&scope=bot+applications.commands&permissions=2251800082197504&guild_id=689316505560809576&disable_guild_select=true
```

6. In [Discord Server Settings -> Roles](https://discord.com/channels/689316505560809576), ensure
   the `pkmn` role is positioned above all leaderboard and competitor roles configured in
   `config/discord.yml` and `config/ladders.yml`.

## Authentication & Wiki

1. Create a [GitHub OAuth App](https://github.com/settings/developers) (under **OAuth Apps** -> **New
   OAuth App**, or under the `pkmn` GitHub organization settings -> **Developer settings** -> **OAuth
   Apps**):
   - **Application name**: `pkmn.ai`
   - **Homepage URL**: `https://pkmn.ai`
   - **Authorization callback URL**: `https://pkmn.ai/auth/github/callback`
   - Leave **Enable Device Flow** unchecked, click **Register application**, then click **Generate a
     new client secret**.
2. Copy the **Client ID** and **Client secret** into `.env` (`GITHUB_CLIENT_ID=...` and
   `GITHUB_CLIENT_SECRET=...`), alongside a 32-byte hex `SESSION_SECRET=...` (`openssl rand -hex 32`)
   and a 32-byte hex `ARENA_SECRET=...`. Run `./private/sync` to sync `.env` to production.
3. Create the SQLite data directory `/var/lib/pkmn` owned by `pkmn:pkmn`:

```sh
mkdir -p /var/lib/pkmn
chown pkmn:pkmn /var/lib/pkmn
```

4. As `pkmn`, clone the private `pkmn/wiki` repository into `/home/pkmn/ai/wiki` using a deploy key
   with write access:

```sh
git clone git@github.com:pkmn/wiki.git /home/pkmn/ai/wiki
```

## pkmn.ai

Switch to the `pkmn` user (`su pkmn`) and set up the repository in `/home/pkmn`:

```sh
cd /home/pkmn
git clone https://github.com/pkmn/ai.git
```

As `root`, select an editor for `visudo` and edit `/etc/sudoers.d/pkmn` to give the `pkmn` user
permission to reload `nginx`, reload `systemd` unit files, and manage any `pkmn.*` service:

```sh
update-alternatives --config editor
visudo -f /etc/sudoers.d/pkmn
```

```diff
+pkmn ALL=(ALL) NOPASSWD: /usr/sbin/service nginx reload,/usr/bin/systemctl daemon-reload,/usr/sbin/service pkmn.* *
```

Configure and enable the `systemd` services and timers (`pkmn.ai-server.service`,
`pkmn.ai-backup.service`, and `pkmn.ai-backup.timer`):

```sh
for config in config/*.{service,timer}; do
  name=$(basename $config)
  systemctl enable /home/pkmn/ai/$config
  if [[ $name == *.timer || $name == "pkmn.ai-server.service" ]]; then
    systemctl start $name
  fi
done
```

Build the initial static site and start the service as `pkmn`:

```sh
cd /home/pkmn/ai
./deploy restart
```

### Service Logs, Troubleshooting & Backups

Inspect unit/timer status or recover failed `systemd` units:

```sh
systemctl status pkmn.ai-server
systemctl list-timers 'pkmn.ai*'
systemctl daemon-reload
systemctl reset-failed
```

Follow live logs or vacuum retained logs for `pkmn.ai` services via `journalctl`:

```sh
journalctl -fu pkmn.ai-server
journalctl -xeu 'pkmn.ai*'
journalctl --vacuum-time=7d
```

`pkmn.ai-backup.timer` runs `pkmn.ai-backup.service` nightly at `03:30 UTC` (with randomized delay),
using SQLite's online `.backup` API to snapshot `/var/lib/pkmn/arena.sqlite` into
`/var/lib/pkmn/backups/arena-<timestamp>.sqlite.zst` and pruning backups older than 30 days. To
trigger an immediate backup or restore a compressed snapshot:

```sh
# Trigger an on-demand online backup
systemctl start pkmn.ai-backup.service
ls -lh /var/lib/pkmn/backups/

# Restore a snapshot (stop pkmn.ai-server first so WAL/SHM files are closed cleanly)
service pkmn.ai-server stop
zstd -d /var/lib/pkmn/backups/arena-YYYYMMDDTHHMMSSZ.sqlite.zst -o /tmp/restore.sqlite
cp /tmp/restore.sqlite /var/lib/pkmn/arena.sqlite
rm -f /var/lib/pkmn/arena.sqlite-wal /var/lib/pkmn/arena.sqlite-shm /tmp/restore.sqlite
chown pkmn:pkmn /var/lib/pkmn/arena.sqlite
service pkmn.ai-server start
```

## nginx

Install `nginx`, add `www-data` to the `pkmn` group so `nginx` can serve the static files in
`/home/pkmn/ai/public` and `/home/pkmn/ai/chat/logs`, and link `config/nginx.conf`:

```sh
apt-get install nginx
usermod -a -G pkmn www-data
ln -s /home/pkmn/ai/config/nginx.conf /etc/nginx/sites-available/pkmn.ai
ln -s /etc/nginx/sites-{available,enabled}/pkmn.ai
```

Allow `nginx` traffic through the firewall:

```sh
ufw allow 'nginx Full'
ufw delete allow 'nginx HTTP'
ufw status
```

Use `snap` to install [`certbot`](https://certbot.eff.org/) and obtain TLS certificates for the
domains (*you may need to temporarily comment out the SSL directives in `nginx.conf` to bootstrap*):

```sh
snap install --classic certbot
ln -s /snap/bin/certbot /usr/bin/certbot
certbot --nginx -d pkmn.ai -d www.pkmn.ai
service nginx restart
```

`certbot` automatically renews certificates via `snap.certbot.renew.timer`, which can be checked or
tested with:

```sh
systemctl list-timers 'snap.certbot.renew*'
certbot renew --dry-run
certbot renew
service nginx reload
```

View `nginx` service logs via `journalctl` and access/error logs in `/var/log/nginx`:

```sh
journalctl -xeu nginx
tail -f /var/log/nginx/access.log
```

By default, client IPs in access logs come from [Cloudflare](#cloudflare). Add the following to the
`http` block of `/etc/nginx/nginx.conf` so `nginx` restores real client IPs from `X-Forwarded-For`
(required for per-IP rate limiting in `config/nginx.conf`):

```nginx
	##
	# Cloudflare IPs
	# https://www.cloudflare.com/ips/
	##

	set_real_ip_from 173.245.48.0/20;
	set_real_ip_from 103.21.244.0/22;
	set_real_ip_from 103.22.200.0/22;
	set_real_ip_from 103.31.4.0/22;
	set_real_ip_from 141.101.64.0/18;
	set_real_ip_from 108.162.192.0/18;
	set_real_ip_from 190.93.240.0/20;
	set_real_ip_from 188.114.96.0/20;
	set_real_ip_from 197.234.240.0/22;
	set_real_ip_from 198.41.128.0/17;
	set_real_ip_from 162.158.0.0/15;
	set_real_ip_from 104.16.0.0/13;
	set_real_ip_from 104.24.0.0/14;
	set_real_ip_from 172.64.0.0/13;
	set_real_ip_from 131.0.72.0/22;

	set_real_ip_from 2400:cb00::/32;
	set_real_ip_from 2606:4700::/32;
	set_real_ip_from 2803:f800::/32;
	set_real_ip_from 2405:b500::/32;
	set_real_ip_from 2405:8100::/32;
	set_real_ip_from 2a06:98c0::/29;
	set_real_ip_from 2c0f:f248::/32;

	real_ip_header X-Forwarded-For;
```

Periodically refresh Cloudflare's IP ranges, validate the configuration, and reload `nginx`:

```sh
curl -sL https://www.cloudflare.com/ips-v4 | sed 's/.*/\tset_real_ip_from &;/'
curl -sL https://www.cloudflare.com/ips-v6 | sed 's/.*/\tset_real_ip_from &;/'
nginx -t
service nginx reload
```
