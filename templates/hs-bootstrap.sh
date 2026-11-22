#!/usr/bin/env bash
# Installed at /opt/headscale/bin/hs-bootstrap.sh. Triggered by hs-bootstrap.path
# when /opt/headscale/secrets/oidc_client_secret appears (written over SSH by
# scripts/bootstrap-secret.sh). Idempotent: safe to re-run on every boot.
set -euo pipefail

BASE=/opt/headscale
SECRETS=$BASE/secrets
CONFIG=$BASE/config/config.yaml
COMPOSE=(docker compose -f "$BASE/docker-compose.yaml")

log() { echo "[hs-bootstrap] $*"; }

[[ -s $SECRETS/oidc_client_secret ]] || { log "no OIDC client secret yet; waiting"; exit 0; }

# 1. Fill in the DERP public IPv4 (the attached Lightsail static IP).
if grep -q '__PUBLIC_IPV4__' "$CONFIG"; then
  ip=""
  [[ -s $SECRETS/public_ipv4 ]] && ip=$(tr -d '[:space:]' < "$SECRETS/public_ipv4")
  if [[ -z $ip ]]; then
    tok=$(curl -fsS -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
    ip=$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
  fi
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "could not determine public IPv4"; exit 1; }
  sed -i "s/__PUBLIC_IPV4__/$ip/" "$CONFIG"
  log "DERP ipv4 set to $ip"
fi

# 2. Start Caddy + Headscale and wait for Headscale to be healthy.
"${COMPOSE[@]}" up -d caddy headscale
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T headscale /ko-app/headscale health >/dev/null 2>&1; then
    log "headscale healthy"; break
  fi
  [[ $i -eq 60 ]] && { log "headscale never became healthy"; "${COMPOSE[@]}" logs --tail 50 headscale; exit 1; }
  sleep 3
done

# 3. Headplane needs a Headscale API key in OIDC mode. Create once.
if [[ ! -s $SECRETS/headscale_api_key ]]; then
  key=$("${COMPOSE[@]}" exec -T headscale /ko-app/headscale apikeys create --expiration 999d | tr -d '[:space:]')
  [[ -n $key ]] || { log "failed to create API key"; exit 1; }
  umask 077
  printf '%s' "$key" > "$SECRETS/headscale_api_key.tmp"
  mv "$SECRETS/headscale_api_key.tmp" "$SECRETS/headscale_api_key"
  log "created headscale API key (999d)"
fi

# 4. Start Headplane.
"${COMPOSE[@]}" up -d headplane
touch "$BASE/.bootstrapped"
log "done"
