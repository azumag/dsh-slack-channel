#!/usr/bin/env bash
# Container test of the Linux kit (no real Slack, no real model API, nothing secret):
#   deploy/linux/test/run.sh [--keep] [--rmi]
# Builds dshslack-test:base (Ubuntu 24.04 x86_64 + systemd + tinyproxy), starts it with systemd as
# PID 1, and runs scenario.sh in it against a clone of this repo's HEAD (commit first). --keep leaves
# the container running for a look around; --rmi also removes the image afterwards.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
IMAGE=dshslack-test:base
NAME="dshslack-test-$$"
KEEP=0; RMI=0
for arg in "$@"; do case "$arg" in --keep) KEEP=1 ;; --rmi) RMI=1 ;; *) echo "usage: $0 [--keep] [--rmi]" >&2; exit 2 ;; esac; done

WORK="$(mktemp -d)"
cleanup() {
  [ "$KEEP" = 1 ] && echo "kept container $NAME (docker rm -f $NAME when done)" || docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ "$RMI" = 1 ] && docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

docker build --platform linux/amd64 -q -t "$IMAGE" "$HERE" >/dev/null
git clone --quiet --bare "$REPO" "$WORK/repo.git"
docker run -d --name "$NAME" --platform linux/amd64 --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "$WORK/repo.git:/repo.git:ro" -v "$HERE/fake-world.mjs:/fake-world.mjs:ro" -v "$HERE/scenario.sh:/scenario.sh:ro" \
  --add-host slack.com:127.0.0.2 --add-host wss-primary.slack.com:127.0.0.2 \
  --add-host integrate.api.nvidia.com:127.0.0.2 --add-host opencode.ai:127.0.0.2 --add-host api.deepseek.com:127.0.0.2 \
  --add-host api.githubcopilot.com:127.0.0.2 \
  "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  state="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
echo "systemd: $state"
docker exec "$NAME" bash /scenario.sh
