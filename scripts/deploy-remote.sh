#!/usr/bin/env bash
# Runs on the VPS; scripts/deploy.ps1 uploads it next to the release archive.
# Replaces the code in DIR with the archive (keeping .env and data/), rebuilds and
# restarts the server container, then waits for the health check.
#
# Usage: bash deploy-remote.sh <deploy dir> <revision>
# Exit codes: 0 deployed, 1 error, 3 first run (code copied, .env still missing).
set -euo pipefail

DIR=${1:?deploy dir required}
REV=${2:-unknown}
ARCHIVE=/tmp/pca-release.tgz

log() { echo "[PdfClaudeAssistant] $*"; }

command -v docker >/dev/null 2>&1 || { log "Docker is not installed on this host."; exit 1; }
docker compose version >/dev/null 2>&1 || { log "The docker compose plugin is missing."; exit 1; }
[ -f "$ARCHIVE" ] || { log "Release archive $ARCHIVE not found."; exit 1; }

mkdir -p "$DIR"
# Only ever clean a directory that is empty or already holds this app.
if [ -n "$(ls -A "$DIR")" ] && ! grep -q '^name: pdfclaudeassistant' "$DIR/docker-compose.yml" 2>/dev/null; then
  log "$DIR is not empty and is not a PdfClaudeAssistant install: refusing to touch it."
  exit 1
fi

# Unpack aside, drop what must never be overwritten, then swap the code.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGE"
rm -rf "$STAGE/data" "$STAGE/.env"
# Old code goes (files deleted from the repo must not linger). .env, data/ and a
# host-specific docker-compose.override.yml stay.
find "$DIR" -mindepth 1 -maxdepth 1 ! -name .env ! -name data ! -name docker-compose.override.yml \
  -exec rm -rf {} +
cp -a "$STAGE/." "$DIR/"
rm -f "$ARCHIVE"
echo "$REV" > "$DIR/REVISION"

# The container runs as uid 1000; give it a fresh data dir on the first deploy.
if [ ! -d "$DIR/data" ]; then
  mkdir -p "$DIR/data/claude-home"
  chown -R 1000:1000 "$DIR/data"
fi

cd "$DIR"
if [ ! -f .env ]; then
  log "Code copied to $DIR (revision $REV), but $DIR/.env does not exist yet."
  exit 3
fi

log "Building and starting revision $REV..."
docker compose build server
docker compose up -d server
docker image prune -f >/dev/null

PORT=$(sed -n 's/^APP_PORT=//p' .env | tail -n 1 | tr -d "\"' \r")
PORT=${PORT:-3000}
health() {
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 ||
    wget -qO- "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}
for _ in $(seq 1 45); do
  if health; then
    log "Healthy on 127.0.0.1:$PORT (revision $REV)."
    exit 0
  fi
  sleep 2
done
log "Health check failed on 127.0.0.1:$PORT. Last server logs:"
docker compose logs --tail 60 server || true
exit 1
