#!/usr/bin/env bash
# SSH to the instance with a short-lived Lightsail certificate.
#   ./scripts/ssh.sh <stack-name>                      # interactive shell
#   ./scripts/ssh.sh <stack-name> sudo docker compose -f /opt/headscale/docker-compose.yaml ps
#   ./scripts/ssh.sh <stack-name> hs nodes list         # `hs` = headscale CLI shortcut
source "$(dirname "$0")/lib.sh"
ssh_setup
if [[ ${1:-} == hs ]]; then
  shift
  remote -t "sudo docker exec headscale /ko-app/headscale $(printf '%q ' "$@")"
elif [[ $# -gt 0 ]]; then
  remote -t "$@"
else
  ssh -t "${SSH_OPTS[@]}" "$TARGET"
fi
