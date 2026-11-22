#!/usr/bin/env bash
# Validate and apply a Headscale policy file (HuJSON).
#   ./scripts/policy.sh <stack-name> policy.local.hujson          # check + apply
#   ./scripts/policy.sh <stack-name> policy.local.hujson --check  # check only
# Prints the current policy to <file>.bak-<timestamp> first so you can roll back.
source "$(dirname "$0")/lib.sh"
FILE=${1:?policy file}
MODE=${2:-apply}
[[ -f $FILE ]] || { echo "no such file: $FILE" >&2; exit 1; }
ssh_setup
remote 'cat > /tmp/policy.hujson' < "$FILE"
remote 'sudo docker cp /tmp/policy.hujson headscale:/tmp/policy.hujson'
remote 'sudo docker exec headscale /ko-app/headscale policy check -f /tmp/policy.hujson' && echo "policy OK"
[[ $MODE == --check ]] && exit 0
remote 'sudo docker exec headscale /ko-app/headscale policy get' > "$FILE.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
remote 'sudo docker exec headscale /ko-app/headscale policy set -f /tmp/policy.hujson'
remote 'rm -f /tmp/policy.hujson'
