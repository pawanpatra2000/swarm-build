#!/bin/sh
# Start a standalone build with its preview in the background and return.
# Usage: sh tools/live.sh <brief-file> [extra `swarm-build run` args]
# Logs: out/live-server.log. Stop: kill "$(cat out/live-server.pid)"
cd "$(dirname "$0")/.." || exit 1
NODE="${NODE:-node}"
[ -f out/live-server.pid ] && kill "$(cat out/live-server.pid)" 2>/dev/null
mkdir -p out
BRIEF="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; shift
cd out || exit 1
nohup "$NODE" ../bin/swarm-build.mjs run --brief-file "$BRIEF" "$@" > live-server.log 2>&1 &
echo $! > live-server.pid
sleep 1
cat live-server.log
