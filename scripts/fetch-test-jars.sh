#!/usr/bin/env bash
# Downloads the Tessellation wallet and keytool JARs used by the integration tests.
set -euo pipefail

VERSION="v3.6.2"
BASE="https://github.com/Constellation-Labs/tessellation/releases/download/${VERSION}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.test-jars"
mkdir -p "$DIR"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

for base in cl-wallet cl-keytool; do
  name="$base.jar"
  sum="$base.sha256"
  if [ ! -f "$DIR/$name" ] || [ ! -f "$DIR/$sum" ]; then
    curl -fsSL -o "$DIR/$name" "$BASE/$name"
    curl -fsSL -o "$DIR/$sum" "$BASE/$sum"
  fi
  expected="$(tr -d '[:space:]' < "$DIR/$sum")"
  actual="$(sha256_of "$DIR/$name")"
  if [ "$expected" != "$actual" ]; then
    echo "Checksum mismatch for $name" >&2
    rm -f "$DIR/$name" "$DIR/$sum"
    exit 1
  fi
done
echo "Test JARs ready in $DIR"
