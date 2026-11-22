# Backup Pi-hole on the control-plane box

If your only Pi-hole is at home and `override_local_dns: true`, every remote device loses **all**
DNS when your house loses power or internet. This adds a second Pi-hole on the Lightsail box that
answers only over the tailnet, so Tailscale's resolver fails over to it.

```
tailnet DNS:  100.64.0.2 (home Pi-hole, first)  ->  100.64.0.6 (this box, backup)
```

It's installed **in place**, outside user data, so it never triggers an instance replacement.
It fits in the 1 GB bundle (Pi-hole is capped at 256 MB; about 450k blocklist domains used ~25 MB more RAM).

## Install

```bash
STACK=Headscale
# 1. one-time key for the box's own tailnet client
./scripts/ssh.sh $STACK hs users list
./scripts/ssh.sh $STACK hs preauthkeys create --user <ID> --expiration 1h
# 2. on the box
./scripts/ssh.sh $STACK
sudo install -d -m 755 /opt/extras /var/lib/pihole && sudo install -d -m 700 /opt/extras/secrets /var/lib/ts-client
sudo nano /opt/extras/docker-compose.yaml          # paste extras/backup-pihole/docker-compose.yaml
echo 'TS_AUTHKEY=<key>' | sudo tee /opt/extras/ts.env >/dev/null && sudo chmod 600 /opt/extras/ts.env
printf 'HS_DOMAIN=hs.example.com\nTAILNET_IP=0.0.0.0\n' | sudo tee /opt/extras/.env
cd /opt/extras && sudo docker compose up -d tailscale && sudo docker exec ts-client tailscale ip -4
sudo truncate -s0 /opt/extras/ts.env               # key is single-use; don't leave it around
sudo sed -i 's/^TAILNET_IP=.*/TAILNET_IP=<the 100.x from above>/' .env
sudo sh -c 'umask 077; openssl rand -base64 24 | tr -d "\n" > secrets/pihole_web_password'
sudo docker compose up -d pihole
```

3. **Copy your home Pi-hole's lists and rules.** Take a Teleporter export at home
   (Settings → Teleporter, or `pihole-FTL --teleporter`), copy it to the box, then run
   `sudo docker cp x.zip pihole:/tmp/ && sudo docker exec pihole pihole-FTL --teleporter /tmp/x.zip && sudo docker exec pihole pihole -g`.
   The compose environment overrides the imported listen, upstream and web settings, so the
   import can't widen what this Pi-hole listens on.
4. **Add it as the second nameserver**: in Headplane → DNS, or in `dns.nameservers.global` in
   `/opt/headscale/config/config.yaml` (then `docker restart headscale`).

## Verify

- `sudo ss -lunp | grep :53` should show only `127.0.0.1` and the tailnet IP (plus systemd-resolved on 127.0.0.53/54).
- From outside, `dig @<static IP> example.com` must time out. UDP 53 is not in the Lightsail firewall.
- **Failover drill:** run a throwaway client in a container on the box. Containerized, `--accept-dns=true`
  can't touch any real machine's DNS, and an ephemeral key removes the node when it stops.
  ```bash
  ./scripts/ssh.sh $STACK hs preauthkeys create --user <ID> --expiration 30m --ephemeral
  sudo docker run -d --rm --name ts-dnstest -e TS_AUTHKEY=<key> -e TS_USERSPACE=true -e TS_ACCEPT_DNS=true \
    -e TS_STATE_DIR=mem: -e TS_EXTRA_ARGS=--login-server=https://hs.example.com tailscale/tailscale:v1.104.7
  sudo docker exec ts-dnstest tailscale dns query doubleclick.net   # 0.0.0.0
  # now stop Tailscale on your home Pi-hole host for ~10 s and query again; it should still answer
  sudo docker stop ts-dnstest
  ```

## Caveats

- **Lists drift.** Re-run the Teleporter import after you change blocklists or allowlists at home
  (or use a sync tool such as nebula-sync).
- **Upstream is plain DNS to Cloudflare from AWS** (`1.1.1.1;1.0.0.1`). Swap in a DoH proxy like the
  home Pi-hole's if that matters to you.
- **Admin UI** is on `127.0.0.1:8081`. Reach it with `ssh -L 8081:127.0.0.1:8081` via `scripts/ssh.sh`'s target.
- **It shares fate with the control plane.** If the Lightsail box is down, this backup is down
  too, but the home Pi-hole still answers over existing tunnels. Each covers the other's outage.
