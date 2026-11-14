#!/bin/sh
# Start the preview in the background and return. Usage: sh tools/live.sh <brief-file> [extra server args]
# Logs: out/live-server.log. Stop: kill "$(cat out/live-server.pid)"
cd "$(dirname "$0")/.." || exit 1
NODE="${NODE:-$(command -v node || echo /Users/pawan/.nvm/versions/node/v24.21.0/bin/node)}"
[ -f out/live-server.pid ] && kill "$(cat out/live-server.pid)" 2>/dev/null
mkdir -p out
BRIEF="$1"; shift
nohup "$NODE" src/server.mjs --brief-file "$BRIEF" "$@" > out/live-server.log 2>&1 &
echo $! > out/live-server.pid
sleep 1
cat out/live-server.log
