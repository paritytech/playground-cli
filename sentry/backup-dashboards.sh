#!/usr/bin/env bash
# Fetch every known Playground CLI dashboard into sentry/dashboards/.
# Run before any dashboard modification. The JSON files in that directory
# are the source of truth for the current state and let an agent diff
# changes before applying them.

set -euo pipefail

# Keychain item is `sentry-api-token-playground`; `sentry-api-token` is the
# historical name and is kept as a fallback for older machines.
TOKEN=$(security find-generic-password -s sentry-api-token-playground -w 2>/dev/null \
    || security find-generic-password -s sentry-api-token -w)
BASE="https://de.sentry.io/api/0/organizations/paritytech"

# Known dashboard IDs. Append new IDs after creating new dashboards.
DASHBOARDS=(
    "2143100"   # Playground CLI Health
    "2216067"   # Failures Detail
    "2216096"   # E2E Health
)

mkdir -p sentry/dashboards
for id in "${DASHBOARDS[@]}"; do
    echo "Backing up dashboard $id..."
    curl -sf \
        -H "Authorization: Bearer $TOKEN" \
        "$BASE/dashboards/$id/" \
        | python3 -m json.tool > "sentry/dashboards/$id.json"
done
echo "OK Backups written to sentry/dashboards/"
