#!/usr/bin/env bash
# Deliver the Cognito app-client secret to the instance and start the stack.
#   ./scripts/bootstrap-secret.sh <stack-name>
# The secret goes Cognito API -> this shell variable -> SSH stdin -> a 0600 root file.
# It is never in CloudFormation, user data, instance metadata, argv, or git.
# Re-run any time to rotate the secret (it restarts Headscale + Headplane).
source "$(dirname "$0")/lib.sh"

POOL=$(output UserPoolId)
CLIENT=$(output UserPoolClientId)
IP=$(output StaticIpAddress)
SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT" \
  --query 'UserPoolClient.ClientSecret' --output text)
[[ -n $SECRET && $SECRET != None ]] || { echo "could not read client secret" >&2; exit 1; }

ssh_setup
echo "waiting for first-boot user data to finish on $TARGET ..."
remote 'sudo cloud-init status --wait >/dev/null; sudo test -f /etc/systemd/system/hs-bootstrap.path'

ROTATE=no
remote 'test -f /opt/headscale/.bootstrapped' && ROTATE=yes
remote "sudo sh -c 'umask 077; printf %s $IP > /opt/headscale/secrets/public_ipv4'"
printf '%s' "$SECRET" | remote "sudo sh -c 'umask 077; cat > /opt/headscale/secrets/oidc_client_secret.tmp && mv /opt/headscale/secrets/oidc_client_secret.tmp /opt/headscale/secrets/oidc_client_secret'"
unset SECRET

# The path unit fires on create/change; start explicitly too (joins the same job) so we block until done.
remote 'sudo systemctl start hs-bootstrap.service'
if [[ $ROTATE == yes ]]; then
  echo "rotating: restarting headscale + headplane to pick up the new secret"
  remote 'sudo docker compose -f /opt/headscale/docker-compose.yaml restart headscale headplane'
fi
remote 'sudo journalctl -u hs-bootstrap.service --no-pager -n 20; sudo docker compose -f /opt/headscale/docker-compose.yaml ps'
echo "done -> $(output AdminUrl)"
