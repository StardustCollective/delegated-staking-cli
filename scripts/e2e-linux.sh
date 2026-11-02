#!/usr/bin/env bash
# Linux end-to-end test. Packs the CLI, then runs it in a fresh ubuntu:24.04 container.
# Needs Docker. Sends ONE real registration request to Constellation mainnet from a key generated
# inside the container (unfunded, so the server rejects it). Never prints the key or password.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Packing the CLI..."
(cd "$REPO" && npm pack --silent --pack-destination "$WORK" >/dev/null)
TGZ="$(ls "$WORK"/*.tgz)"

echo "Starting a fresh ubuntu:24.04 container..."
docker run --rm \
  -v "$TGZ:/e2e/cli.tgz:ro" \
  -v "$REPO/scripts/e2e-linux:/e2e/scripts:ro" \
  ubuntu:24.04 bash /e2e/scripts/inside.sh
