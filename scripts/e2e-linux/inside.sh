#!/usr/bin/env bash
# Runs as root in the container: installs system packages and Node, then hands over to a normal user.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "Installing system packages..."
apt-get update -qq
apt-get install -y -qq --no-install-recommends openjdk-21-jre-headless expect curl ca-certificates xz-utils >/dev/null

NODE_VERSION=v22.15.0
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "Unsupported architecture $(uname -m)"; exit 1 ;;
esac
echo "Installing Node $NODE_VERSION ($ARCH)..."
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.xz" | tar -xJ -C /opt
ln -s "/opt/node-$NODE_VERSION-linux-$ARCH/bin/node" /usr/local/bin/node
ln -s "/opt/node-$NODE_VERSION-linux-$ARCH/bin/npm" /usr/local/bin/npm

useradd --create-home --shell /bin/bash e2e
cp /e2e/cli.tgz /home/e2e/cli.tgz
cp /e2e/scripts/user.sh /e2e/scripts/drive.exp /e2e/scripts/check.mjs /home/e2e/
chmod 644 /home/e2e/cli.tgz /home/e2e/user.sh /home/e2e/drive.exp /home/e2e/check.mjs

# Empty environment: no locale, fresh HOME.
exec runuser -u e2e -- env -i HOME=/home/e2e/run PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm bash /home/e2e/user.sh
