# Setup

**pkmn.ai** runs on virtual machine imaged with the current [Ubuntu](#Ubuntu) [LTS
release](https://wiki.ubuntu.com/Releases) and the stack is built on [Nginx](#Nginx) proxying to
[Node](#Node).

## Ubuntu

As `root`, create a `pkmn` user and set up the authorized SSH keys for passwordless remote login:

```sh
adduser pkmn
mkdir ~pkmn/.ssh
chmod 700 ~pkmn/.ssh
cat ~/.ssh/authorized_keys > ~pkmn/.ssh/authorized_keys
chmod 600 ~pkmn/.ssh/authorized_keys
```

If unable to login as `pkmn` after the above steps, edit `/etc/ssh/sshd_config` and restart the SSH
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

Allow `pkmn` to reload Nginx, reload the systemd unit files and to manager any `pkmn.*` service.

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

## Nginx

Install Nginx, add `www-data` to the `pkmn` group so that Nginx can serve the static files in
`/home/pkmn/ai/public`, and then link the `nginx.conf`:

```sh
apt-get install nginx
usermod -a -G pkmn www-data
ln -s /home/pkmn/ai/config/nginx.conf /etc/nginx/sites-available/pkmn.ai
ln -s /etc/nginx/sites-{available,enabled}/pkmn.ai
```

Allow Nginx traffic through the firewall:

```sh
ufw allow 'Nginx Full'
ufw delete allow 'Nginx HTTP'
ufw status
```

Use `snap` to install [`certbot`](https://certbot.eff.org/) and get certificates for the domains
(*you may need to remove the relevant SSL sections from the `nginx.conf` to boostrap*):

```sh
snap install --classic certbot
ln -s /snap/bin/certbot /usr/bin/certbot
certbot --nginx -d pkmn.ai -d www.pkmn.ai
```

Restart the Nginx server:

```sh
service nginx restart
```

Logs for the Nginx service can be viewed via `journalctl`, and the logrotated access logs can be
found in `/var/log/nginx`:

```sh
journalctl -xeu nginx
tail -f /var/log/nginx/access.log
```