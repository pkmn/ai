# Setup

**pkmn.ai** runs on virtual machine imaged with the current [Ubuntu](#Ubuntu) [LTS
release](https://wiki.ubuntu.com/Releases) and the stack is built on [nginx](#nginx) proxying to
[Node](#Node) behind [Cloudflare](#Cloudflare).

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
[`certbot`](#nginx) encounters error on renewal follow the [troubleshooting
steps](https://omicx.cc/posts/2020-08-04-enable-certbot-automatic-renewal-for-cloudflare-cdn/).

Cloudflare doesn't proxy SSH connections so to get `ssh pkmn@pkmn.ai` to work, set up a local DNS
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

If unable to login as `pkmn` after the preceding steps, edit `/etc/ssh/sshd_config` and restart the SSH
daemon:

```sh
vim /etc/ssh/sshd_config
/usr/sbin/sshd –t
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

Upgrade/clean up the system packages (and `snap` packages):

```sh
apt-get update
apt-get upgrade -y
apt-get dist-upgrade -y
apt --purge autoremove -y
apt-get autoclean
snap refresh
reboot
```

If not already, update to the latest LTS release, verifying through inspection of `cat
/etc/lsb-release` that the update was successful:

```sh
cat /etc/lsb-release
apt install update-manager-core -y
do-release-upgrade -d
cat /etc/lsb-release
```

Install general packages required to set up the server:

```sh
apt-get install -y git curl build-essential sqlite3 zstd
```

Create a restricted, shell-less `tunnel` user so the Mac mini Arena runner can open an outbound SSH
port-forward (`127.0.0.1:1234`) without shell access:

```sh
adduser --system --no-create-home --shell /usr/sbin/nologin tunnel
mkdir -p /etc/ssh/authorized_keys
touch /etc/ssh/authorized_keys/tunnel
chmod 644 /etc/ssh/authorized_keys/tunnel
cat <<'EOF' > /etc/ssh/sshd_config.d/arena-tunnel.conf
Match User tunnel
    AuthorizedKeysFile /etc/ssh/authorized_keys/tunnel
    PasswordAuthentication no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:1234
EOF
/usr/sbin/sshd -t && service ssh reload
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

Periodically update `n`, Node, and `npm`, and prune old Node versions:

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
5. Invite the `pkmn` bot to the server (`689316505560809576`) with `Manage Roles`, `View Channels`,
   `Send Messages`, `Manage Messages`, `Read Message History`, and `Pin Messages`
   (`2251800082197504`) permissions:

```text
https://discord.com/oauth2/authorize?client_id=689315793569447954&scope=bot+applications.commands&permissions=2251800082197504&guild_id=689316505560809576&disable_guild_select=true
```

6. In [Discord Server Settings -> Roles](https://discord.com/channels/689316505560809576), ensure
   the `pkmn` role is positioned above all leaderboard roles configured in `config/discord.yml`.

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
3. Create the SQLite directory `/var/lib/pkmn` owned by `pkmn:pkmn`:

```sh
mkdir -p /var/lib/pkmn
chown pkmn:pkmn /var/lib/pkmn
```

4. As `pkmn`, clone the private `pkmn/wiki` repository into `/home/pkmn/ai/wiki` using a deploy key
   with write access:

```sh
git clone git@github.com:pkmn/wiki.git /home/pkmn/ai/wiki
```

## Local Development & Seeding

1. **Seed the screenshot dataset (`db/data/arena.sqlite` + `.mock/`):**

```sh
npm run build
npm run mock -- seed
MOCK=1 npm run dev
```

   - `npm run mock -- seed` resets `db/data/arena.sqlite`, populates `.mock/` (`.mock/ladders.yml`
     with `status: active`, `.mock/static/projects.yml` + mock avatars, a git-initialized `.mock/wiki/`
     repository with public and `{% visibility: developers %}` pages, and `.mock/vgc-teams.txt` with
     20 valid VGC Regulation M-C teams), and renders all static Arena pages + live battle/tournament
     feeds into `public/`.
   - `MOCK=1 npm run dev` starts the server on `http://localhost:1234` with `DEV_AUTH=1` against the
     seeded database and `.mock/` overlay. Live Discord role/pin/DM mutations are disabled whenever
     `NODE_ENV !== 'production'` unless you explicitly pass `DISCORD_SYNC=1` (so `.env`'s
     `DISCORD_BOT_TOKEN` never touches the production guild during local development).
   - To wipe the mock state and return to clean unseeded configs (`config/ladders.yml` +
     `static/projects.yml`), run:

```sh
rm -rf .mock db/data/arena.sqlite* && npm run build
```

2. **Switch auth personas & explore every agent onboarding stage (`GET /auth/dev`):**
   - When `DEV_AUTH=1` is set on loopback (`localhost` / `127.0.0.1`), `GET /auth/dev` mints real
     HMAC-signed `pkmn_session` cookies so every route (`/account`, `/api/submissions`, `/wiki/*`,
     `/auth/discord/validate`) exercises the production session & authorization codepath. Open a
     normal window and an Incognito window side-by-side to compare personas simultaneously:
     - **Unauthenticated visitor** (public spectator views; `/account` and developer wiki pages
       redirect to login):
       `http://localhost:1234/auth/dev?clear=1&return_to=/arena`
     - **Unregistered GitHub user** (`403` registration prompt on `/account`; blocked from developer
       wiki pages and editing):
       `http://localhost:1234/auth/dev?github=stranger&return_to=/account`
     - **Stage 1 — `Pending` (`qualified: false`, Discord unlinked) — `AsterAI`**:
       `http://localhost:1234/auth/dev?github=asterdev&return_to=/account`
       *(Account page accessible with "Link Discord" CTA and disabled submission form; can view
       `/wiki/0_ERROR` and edit `/wiki/AsterAI`.)*
     - **Stage 2 — `Qualified` (qualified project before ladders open)**:
       Start plain `npm run dev` (without `MOCK=1`, or set ladders to `upcoming` via
       `MOCK=1 npm run pkmn -- set-ladder-status <id> upcoming`) to inspect the pre-launch `Qualified`
       state while ladders are `upcoming`.
     - **Stage 3 — `Eligible` (brand-new `qualified: true` project, 0 submissions yet) — `CynthiAI`**:
       `http://localhost:1234/auth/dev?github=sisyphus25&return_to=/account`
       *(Empty Active/History tables; checking `VGC` reveals the 20-team paste box — run
       `pbcopy < .mock/vgc-teams.txt` to paste 20 legal Regulation M-C teams and submit `1.0.0`.)*
     - **Stage 4 — `Eligible` (settled multi-ladder competitor, VGC teams already locked) — `Foul Play`**:
       `http://localhost:1234/auth/dev?github=pmariglia&return_to=/account`
       *(Submit `1.5.0` in the form to watch `/account` transition immediately to **Ineligible —
       awaiting Arena smoke testing**, then run `MOCK=1 npm run mock -- step` in a second terminal to
       smoke-test it, promote it to Challenger, and play a match.)*
     - **Stage 5 — `Ineligible` (14-day cooldown + Champion/Challenger/Retired + Wiki Admin) — `0 ERROR`**:
       `http://localhost:1234/auth/dev?github=scheibo&discord=513513270670262284&return_to=/account`
       *(Shows `1.2.0` + `1.1.0` active side-by-side, `1.0.0` retired, `0.9.0-rc1` failed smoke test
       trace, full wiki admin access, and active 14d cooldown — waive it live with
       `MOCK=1 npm run pkmn -- refund-cooldown 0-error` and refresh `/account`.)*
     - **Stage 6 — `Ineligible` (unsettled provisional active version: `< 25` matches) — `pokerus`**:
       `http://localhost:1234/auth/dev?github=pokerusdev&return_to=/account`
       *(Past the 14-day window, but blocked until `1.0.2` finishes settling on RBY & SV.)*
   - To test the live GitHub OAuth redirect locally as well, create a separate `pkmn.ai (dev)` OAuth
     App with callback `http://localhost:1234/auth/github/callback` and pass
     `GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... PUBLIC_URL=http://localhost:1234 npm start` so
     `.env` keeps production credentials.

## pkmn.ai

Switch to the `pkmn` user (`su pkmn`) and set up the repository in the `/home/pkmn` directory:

```sh
cd /home/pkmn
git clone https://github.com/pkmn/ai.git
```

As the `root` user, select an editor for `visudo` and then edit `/etc/sudoers.d/pkmn` to give the
`pkmn` user the necessary permissions:

```sh
update-alternatives --config editor
visudo -f /etc/sudoers.d/pkmn
```

Allow `pkmn` to reload nginx, reload the systemd unit files and to manager any `pkmn.*` service.

```diff
+pkmn ALL=(ALL) NOPASSWD: /usr/sbin/service nginx reload,/usr/bin/systemctl daemon-reload,/usr/sbin/service pkmn.* *
```

Configure and enable all of the systemd services and timers:

```sh
for config in config/*.{service,timer}; do
  name=$(basename $config)
  if [ $name != "pkmn.ai-controller.service" ]; then
    systemctl enable /home/pkmn/ai/$config
    systemctl start $name
  fi
done
```

The following commands can be used to troubleshoot issues with the units:

```sh
systemctl list-units
systemctl daemon-reload
systemctl reset-failed
```

Logs for the `pkmn.ai` services can be viewed and cleaned up through `journalctl`:

```sh
journalctl -xeu pkmn.ai*
journalctl --vacuum-time=7d
```

To pull the latest changes, update dependencies, rebuild, and restart the server as `pkmn` (or run
`npm run deploy` locally):

```sh
cd /home/pkmn/ai
./deploy restart
```

## nginx

Install nginx, add `www-data` to the `pkmn` group so that nginx can serve the static files in
`/home/pkmn/ai/public`, and then link the `nginx.conf`:

```sh
apt-get install nginx
usermod -a -G pkmn www-data
ln -s /home/pkmn/ai/config/nginx.conf /etc/nginx/sites-available/pkmn.ai
ln -s /etc/nginx/sites-{available,enabled}/pkmn.ai
```

Allow nginx traffic through the firewall:

```sh
ufw allow 'nginx Full'
ufw delete allow 'nginx HTTP'
ufw status
```

Use `snap` to install [`certbot`](https://certbot.eff.org/) and get certificates for the domains
(*you may need to remove the relevant SSL sections from the `nginx.conf` to bootstrap*):

```sh
snap install --classic certbot
ln -s /snap/bin/certbot /usr/bin/certbot
certbot --nginx -d pkmn.ai -d www.pkmn.ai
```

Restart the nginx server:

```sh
service nginx restart
```

`certbot` automatically renews certificates via a systemd timer (`snap.certbot.renew.timer`), which
can be checked or manually triggered with:

```sh
systemctl list-timers snap.certbot.renew*
certbot renew --dry-run
certbot renew
service nginx reload
```

Logs for the nginx service can be viewed via `journalctl`, and the logrotate-d access logs can be
found in `/var/log/nginx`:

```sh
journalctl -xeu nginx
tail -f /var/log/nginx/access.log
```

By default the IPs in these logs are going to be coming from [Cloudflare](#Cloudflare), the
following needs to be added to the `http` block of `/etc/nginx/nginx.conf` and then nginx needs to
be restarted to get the actual client IPs:

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

This list needs to be kept up to date to reflect changes to Cloudflare's service, after which the
configuration should be tested and reloaded:

```sh
curl -sL https://www.cloudflare.com/ips-v4 | sed 's/.*/\tset_real_ip_from &;/'
curl -sL https://www.cloudflare.com/ips-v6 | sed 's/.*/\tset_real_ip_from &;/'
nginx -t
service nginx reload
```
