#!/bin/sh
# Hardening of the SyriaHC server (Ubuntu 24.04). Safe to run more than once. Run as root:
#   sh /opt/syriahealthcare/platform/server/harden.sh
# - SSH: keys only (already), no X11/TCP/agent forwarding, 3 tries per connection, idle connections closed.
#   The new settings are checked with "sshd -t" before SSH is reloaded; a running session stays open.
# - fail2ban: an address with 5 failed SSH logins in 10 minutes is blocked for an hour (bots try ~1,500 times a day).
# - Firewall: UDP 443 for HTTP/3.
# - Backups: readable by root only.
set -eu

echo "== SSH"
cat > /etc/ssh/sshd_config.d/90-syriahc.conf <<'EOF'
# SyriaHC hardening (platform/server/harden.sh)
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
sshd -t
systemctl reload ssh
sshd -T | grep -E '^(x11forwarding|allowtcpforwarding|maxauthtries|passwordauthentication|permitrootlogin) '

echo "== fail2ban"
if ! command -v fail2ban-client >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q fail2ban >/dev/null
fi
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
# SyriaHC (platform/server/harden.sh): block an address for an hour after 5 failed SSH logins within 10 minutes.
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban
sleep 2
fail2ban-client status sshd | sed -n '1,6p'

echo "== Firewall"
ufw allow 443/udp comment 'HTTP/3' >/dev/null
ufw status | grep -E '443'

echo "== Backups"
chmod 700 /opt/syriahealthcare/platform/backups
find /opt/syriahealthcare/platform/backups -type f -exec chmod 600 {} +
ls -la /opt/syriahealthcare/platform/backups | head -3

echo "== Website publishing (isolated build)"
install -m 755 -o root -g root /opt/syriahealthcare/platform/server/update-website.sh /usr/local/sbin/syriahc-update-website
install -m 644 -o root -g root /opt/syriahealthcare/platform/website/update-website.service /etc/systemd/system/update-website.service
install -m 644 -o root -g root /opt/syriahealthcare/platform/website/update-website.timer /etc/systemd/system/update-website.timer
systemctl daemon-reload
/usr/local/sbin/syriahc-update-website --force
systemctl enable --now update-website.timer >/dev/null 2>&1

echo "Hardening done."
