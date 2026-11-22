#!/usr/bin/env bash
# Shared helpers. Uses your local AWS credentials (AWS_PROFILE / AWS_REGION).
# SSH uses Lightsail's short-lived SSH certificate from GetInstanceAccessDetails,
# so no long-lived key pair is downloaded or stored.
set -euo pipefail

STACK=${1:?usage: $0 <stack-name> ...}
shift || true

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

HS_TMP=$(mktemp -d)
trap 'rm -rf "$HS_TMP"' EXIT
chmod 700 "$HS_TMP"

ssh_setup() {
  INSTANCE=$(output InstanceName)
  local details
  details=$(aws lightsail get-instance-access-details --instance-name "$INSTANCE" --protocol ssh --output json)
  HS_DETAILS=$details python3 - "$HS_TMP" <<'PY'
import json, os, sys
d = json.loads(os.environ["HS_DETAILS"])["accessDetails"]
tmp = sys.argv[1]
def w(name, body, mode=0o600):
    p = os.path.join(tmp, name)
    with open(p, "w") as f: f.write(body if body.endswith("\n") else body + "\n")
    os.chmod(p, mode)
w("key", d["privateKey"])
w("key-cert.pub", d["certKey"])
w("target", f'{d["username"]}@{d["ipAddress"]}')
w("known_hosts", "".join(f'{d["ipAddress"]} {k["algorithm"]} {k["publicKey"]}\n' for k in d.get("hostKeys", [])) or "")
PY
  TARGET=$(cat "$HS_TMP/target")
  local strict=yes
  [[ -s $HS_TMP/known_hosts ]] || strict=accept-new
  SSH_OPTS=(-i "$HS_TMP/key" -o CertificateFile="$HS_TMP/key-cert.pub" -o IdentitiesOnly=yes
    -o UserKnownHostsFile="$HS_TMP/known_hosts" -o StrictHostKeyChecking=$strict -o ConnectTimeout=15)
}

remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
