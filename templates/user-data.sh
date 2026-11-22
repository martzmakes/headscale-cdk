#!/bin/sh
# Lightsail launch script (runs once, as root, on first boot via cloud-init).
# Contains NO secrets. The OIDC client secret is delivered afterwards over SSH
# (scripts/bootstrap-secret.sh), which triggers hs-bootstrap.path.
# Log: /var/log/cloud-init-output.log
#
# Lightsail prepends its own /bin/sh launch script and runs the combination with
# sh (dash), so a #!/bin/bash shebang here is IGNORED. Keep this outer part POSIX:
# write the real script to disk and run it with bash.
cat > /var/lib/hs-firstboot.sh <<'__HS_FIRSTBOOT__'
#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- 1 GB box: add 1 GB swap so image pulls / Node don't OOM ---------------------
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
  sysctl -p /etc/sysctl.d/99-swappiness.conf
fi

# --- Docker (Ubuntu archive packages; unattended-upgrades keeps them patched) ----
apt-get update -y
apt-get install -y docker.io docker-compose-v2 openssl curl sqlite3
systemctl enable --now docker

# Cap container log size so the 40 GB disk never fills with logs.
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker

# --- Directories --------------------------------------------------------------
install -d -m 755 /opt/headscale /opt/headscale/bin /opt/headscale/config /opt/headscale/headplane
install -d -m 700 /opt/headscale/secrets
install -d -m 750 /var/lib/headscale /var/lib/headplane

# --- Rendered files (from templates/ in the CDK repo) -------------------------
{{WRITE_FILES}}

chmod 755 /opt/headscale/bin/hs-bootstrap.sh
cp /opt/headscale/hs-bootstrap.service /opt/headscale/hs-bootstrap.path /etc/systemd/system/

# --- Headplane cookie secret: exactly 32 chars, generated here, never leaves the box
if [ ! -s /opt/headscale/secrets/headplane_cookie_secret ]; then
  (umask 077; openssl rand -hex 16 | tr -d '\n' > /opt/headscale/secrets/headplane_cookie_secret)
fi

# --- Pull images and start Caddy now so the TLS cert is issued early ----------
cd /opt/headscale
docker compose pull
docker compose up -d caddy

# --- Wait for the OIDC secret, then bring up Headscale + Headplane -------------
systemctl daemon-reload
systemctl enable --now hs-bootstrap.path

echo "user-data complete; waiting for scripts/bootstrap-secret.sh"
__HS_FIRSTBOOT__
chmod 700 /var/lib/hs-firstboot.sh
bash /var/lib/hs-firstboot.sh
