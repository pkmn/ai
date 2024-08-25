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
+  ForwardAgent yes
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

Upgrade/clean up the system packages:

```sh
apt-get update
apt-get update upgrade -y
reboot
apt --purge autoremove
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
apt-get install -y git curl build-essential
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

Logs for the `pkmn.ai` services can be viewed through `journalctl`:

```sh
journalctl -xeu pkmn.ai*
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

This list needs to be kept up to date to reflect changes to Cloudflare's service.
