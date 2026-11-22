#!/usr/bin/env bash
# In-place image upgrade (does NOT touch CloudFormation, so no instance replacement).
#   ./scripts/upgrade.sh <stack-name> headscale 0.30.0
#   ./scripts/upgrade.sh <stack-name> headplane 0.8.3
#   ./scripts/upgrade.sh <stack-name> caddy 2.11.10-alpine
# Headscale: go ONE minor version at a time and read the release notes first.
# Takes a manual Lightsail snapshot before changing anything.
source "$(dirname "$0")/lib.sh"
COMPONENT=${1:?component: headscale|headplane|caddy}
VERSION=${2:?version tag, e.g. 0.30.0}
case $COMPONENT in
  headscale) IMAGE=headscale/headscale ;;
  headplane) IMAGE=ghcr.io/tale/headplane ;;
  caddy) IMAGE=caddy ;;
  *) echo "unknown component $COMPONENT" >&2; exit 1 ;;
esac
[[ $VERSION =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad version" >&2; exit 1; }

INSTANCE=$(output InstanceName)
SNAP="${INSTANCE}-pre-${COMPONENT}-${VERSION//./-}-$(date +%Y%m%d%H%M)"
echo "snapshot: $SNAP"
aws lightsail create-instance-snapshot --instance-name "$INSTANCE" --instance-snapshot-name "$SNAP" >/dev/null
until [[ $(aws lightsail get-instance-snapshot --instance-snapshot-name "$SNAP" --query 'instanceSnapshot.state' --output text) == available ]]; do sleep 10; done

ssh_setup
remote "set -e; cd /opt/headscale
  sudo cp /var/lib/headscale/db.sqlite /var/lib/headscale/db.sqlite.pre-$VERSION 2>/dev/null || true
  sudo sed -i -E 's#image: ${IMAGE}:[^[:space:]]+#image: ${IMAGE}:${VERSION}#' docker-compose.yaml
  grep -n 'image:' docker-compose.yaml
  sudo docker compose pull $COMPONENT
  sudo docker compose up -d $COMPONENT
  sleep 10; sudo docker compose ps; sudo docker compose logs --tail 30 $COMPONENT"
echo
echo "If healthy, update lib/versions.ts for FRESH installs only (it changes the user-data"
echo "fingerprint; do not redeploy an existing instance with it unless you mean to replace it)."
