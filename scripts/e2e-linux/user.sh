#!/usr/bin/env bash
# Runs as a normal user with a fresh HOME. Never use `set -x` here: the key and password are in the environment.
set -euo pipefail
S=/home/e2e
mkdir -p "$HOME"
cd "$HOME"

echo "Installing the CLI from the tarball..."
npm install -g --prefix "$HOME/.npm-global" --silent "$S/cli.tgz" >/dev/null 2>&1
export PATH="$HOME/.npm-global/bin:$PATH"

# New random key and password, made here and used only for this run.
export DSC_E2E_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export DSC_E2E_PASSWORD="e2e test $(node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")"

echo "Running the CLI (downloads wallet.jar, then sends one registration)..."
set +e
expect "$S/drive.exp" "$(command -v delegated-staking-cli)" >"$S/transcript.raw"
CODE=$?
set -e

node "$S/check.mjs" "$S/transcript.raw" "$CODE" "$HOME"
