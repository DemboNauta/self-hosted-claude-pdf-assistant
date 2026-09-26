#!/usr/bin/env bash
# Runs on the VPS as root; scripts/deploy.ps1 uploads it to /tmp and calls it.
#
#   deploy-remote.sh deploy <dir> <revision> [domain] [port]
#       Builds the uploaded release (/tmp/pca-release.tgz) with a private Node 22,
#       swaps it in as <dir>/app, (re)starts the systemd service, waits for the
#       health check and rolls back if it fails. The first run also creates the
#       service user, installs OCR packages, Node and a starter .env. With a domain
#       it (re)writes this app's own block in the shared Caddyfile.
#   deploy-remote.sh set-password <dir>       password on stdin → APP_PASSWORD_HASH
#   deploy-remote.sh set-claude-token <dir>   token on stdin → CLAUDE_CODE_OAUTH_TOKEN
#
# Never touches <dir>/data. Exit codes: 0 ok, 1 error, 3 deployed but not started
# because the login password is not set yet.
set -euo pipefail

CMD=${1:?command required}
DIR=${2:?deploy dir required}
APP_USER=pdfclaude
SERVICE=pdfclaudeassistant
NODE_MAJOR=22
ARCHIVE=/tmp/pca-release.tgz
CADDYFILE=/etc/caddy/Caddyfile
NODE_BIN=$DIR/runtime/node/bin

log() { echo "[PdfClaudeAssistant] $*"; }
die() {
  log "$*"
  exit 1
}

# Replaces (or appends) KEY=... in .env without echoing the value.
set_env() {
  local key=$1 line=$2 tmp
  tmp=$(mktemp)
  awk -v key="$key" -v line="$line" '
    index($0, key "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }' "$DIR/.env" >"$tmp"
  cat "$tmp" >"$DIR/.env"
  rm -f "$tmp"
}

env_value() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1 | tr -d "\"' \r"; }

# After changing .env: (re)start the service if the app is installed and has a password.
restart_if_installed() {
  systemctl is-enabled --quiet "$SERVICE" 2>/dev/null || return 0
  [ -n "$(env_value APP_PASSWORD_HASH)" ] || return 0
  systemctl restart "$SERVICE"
  if healthy "$(env_value PORT)"; then
    log "Service (re)started and healthy."
  else
    journalctl -u "$SERVICE" -n 30 --no-pager || true
    die "The service did not come up after the change."
  fi
}

ensure_user() {
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    log "Created system user $APP_USER."
  fi
}

ensure_packages() {
  local missing=()
  command -v ocrmypdf >/dev/null 2>&1 || missing+=(ocrmypdf)
  dpkg -s tesseract-ocr-spa >/dev/null 2>&1 || missing+=(tesseract-ocr-spa)
  dpkg -s tesseract-ocr-eng >/dev/null 2>&1 || missing+=(tesseract-ocr-eng)
  command -v pdftoppm >/dev/null 2>&1 || missing+=(poppler-utils)
  command -v xz >/dev/null 2>&1 || missing+=(xz-utils)
  if ((${#missing[@]})); then
    log "Installing ${missing[*]}..."
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}"
  fi
}

# A private Node for this app only: the system Node belongs to the other services.
ensure_node() {
  [ -x "$NODE_BIN/node" ] && return
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" file sums
  sums=$(curl -fsSL "$base/SHASUMS256.txt")
  file=$(echo "$sums" | awk '{print $2}' | grep -E "^node-v${NODE_MAJOR}\.[0-9.]+-linux-x64\.tar\.xz$" | head -n 1)
  [ -n "$file" ] || die "Could not find a Node $NODE_MAJOR release."
  log "Installing ${file%.tar.xz} into $DIR/runtime..."
  mkdir -p "$DIR/runtime"
  curl -fsSL "$base/$file" -o "/tmp/$file"
  (cd /tmp && echo "$sums" | grep " $file\$" | sha256sum -c --quiet -) || die "Node checksum mismatch."
  tar -xJf "/tmp/$file" -C "$DIR/runtime"
  rm -f "/tmp/$file"
  ln -sfn "$DIR/runtime/${file%.tar.xz}" "$DIR/runtime/node"
}

ensure_env() {
  [ -f "$DIR/.env" ] && return
  local port=${1:-8004} old_umask
  old_umask=$(umask)
  umask 077
  cat >"$DIR/.env" <<EOF
# PdfClaudeAssistant settings (created by the first deploy; edit freely).
# HOST, DATA_DIR, WEB_DIR and CLAUDE_CONFIG_DIR are set by the systemd unit.

# Loopback port Caddy proxies to.
PORT=$port

# Login password hash: set it with  .\\scripts\\deploy.ps1 -SetPassword  on your PC.
APP_PASSWORD_HASH=''

SESSION_SECRET=$(openssl rand -hex 32)

# Subscription token from 'claude setup-token':  .\\scripts\\deploy.ps1 -SetClaudeToken
# Never add an Anthropic API key here: the server refuses to start with one.
CLAUDE_CODE_OAUTH_TOKEN=

# Claude model alias or ID (empty = Claude Code default).
CLAUDE_MODEL=

MAX_UPLOAD_MB=0
OCR_LANGS=spa+eng
EOF
  umask "$old_umask"
  log "Created $DIR/.env (port $port)."
}

secure_env() {
  chown "root:$APP_USER" "$DIR/.env"
  chmod 640 "$DIR/.env"
}

build_release() {
  local rev=$1 build=$DIR/build out=$DIR/release.new
  [ -f "$ARCHIVE" ] || die "Release archive $ARCHIVE not found."
  rm -rf "$build" "$out"
  mkdir -p "$build"
  tar -xzf "$ARCHIVE" -C "$build"
  rm -f "$ARCHIVE"
  log "Building revision $rev (pnpm install, web and server builds)..."
  (
    cd "$build"
    export PATH="$NODE_BIN:$PATH" COREPACK_HOME="$DIR/runtime/corepack" \
      COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
    corepack pnpm install --frozen-lockfile --loglevel=warn \
      --filter @pdfclaudeassistant/server... --filter @pdfclaudeassistant/web...
    corepack pnpm --filter @pdfclaudeassistant/web build >/dev/null
    corepack pnpm --filter @pdfclaudeassistant/server build >/dev/null
    corepack pnpm --filter @pdfclaudeassistant/server deploy --prod --legacy "$out" >/dev/null
    cp -r apps/server/dist apps/server/drizzle "$out/"
    cp -r apps/web/dist "$out/public"
    mkdir -p "$out/deploy"
    cp "deploy/$SERVICE.service" "$out/deploy/"
  )
  echo "$rev" >"$out/REVISION"
  # Native modules come prebuilt: make sure they load before switching over.
  (cd "$out" && "$NODE_BIN/node" -e "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get();require('@napi-rs/canvas').createCanvas(1,1);require('@node-rs/argon2')") ||
    die "The new release's native modules do not load; the running version is untouched."
  rm -rf "$build"
}

install_unit() {
  local unit=/etc/systemd/system/$SERVICE.service tmp
  tmp=$(mktemp)
  sed "s#@DIR@#$DIR#g" "$DIR/release.new/deploy/$SERVICE.service" >"$tmp"
  if ! cmp -s "$tmp" "$unit"; then
    install -m 644 "$tmp" "$unit"
    systemctl daemon-reload
    log "Installed $unit."
  fi
  rm -f "$tmp"
  systemctl enable --quiet "$SERVICE"
}

healthy() {
  local port=$1
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# This app's own block in the shared Caddyfile, between markers. Validated before
# reloading; restored from the backup if it does not validate.
setup_caddy() {
  local domain=$1 port=$2 backup block
  command -v caddy >/dev/null 2>&1 || die "Caddy is not installed."
  block=$(
    cat <<EOF
# >>> PDFCLAUDEASSISTANT BEGIN <<<
# Managed by PdfClaudeAssistant's scripts/deploy-remote.sh: edit the script, not here.
$domain {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}

	# Web app, API and the /ws/chat WebSocket. No body limit: uploads come in chunks.
	reverse_proxy 127.0.0.1:$port
}
# >>> PDFCLAUDEASSISTANT END <<<
EOF
  )
  if [ "$(sed -n '/# >>> PDFCLAUDEASSISTANT BEGIN <<</,/# >>> PDFCLAUDEASSISTANT END <<</p' "$CADDYFILE")" = "$block" ]; then
    return 0
  fi
  backup="$CADDYFILE.bak.$(date +%s)"
  cp "$CADDYFILE" "$backup"
  sed -i '/# >>> PDFCLAUDEASSISTANT BEGIN <<</,/# >>> PDFCLAUDEASSISTANT END <<</d' "$CADDYFILE"
  printf '\n%s\n' "$block" >>"$CADDYFILE"
  if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    cp "$backup" "$CADDYFILE"
    die "The Caddyfile did not validate with the new block; restored the previous one."
  fi
  systemctl reload caddy
  log "Caddy serves $domain → 127.0.0.1:$port."
}

cmd_deploy() {
  local rev=${1:-unknown} domain=${2:-} port_arg=${3:-}
  [ "$DIR" != / ] || die "Refusing to deploy to /."
  mkdir -p "$DIR"
  ensure_user
  ensure_packages
  ensure_node
  ensure_env "$port_arg"
  secure_env
  mkdir -p "$DIR/data/claude-home"
  chown -R "$APP_USER:$APP_USER" "$DIR/data"
  chmod 750 "$DIR/data"

  build_release "$rev"
  install_unit
  local port
  port=$(env_value PORT)
  port=${port:-8004}

  # Swap releases, keeping the previous one until the new one is healthy.
  rm -rf "$DIR/app.prev"
  [ -d "$DIR/app" ] && mv "$DIR/app" "$DIR/app.prev"
  mv "$DIR/release.new" "$DIR/app"
  chown -R "root:$APP_USER" "$DIR/app"
  chmod -R g+rX,o-rwx "$DIR/app"
  chmod 755 "$DIR" "$DIR/runtime"

  [ -z "$domain" ] || setup_caddy "$domain" "$port"

  if [ -z "$(env_value APP_PASSWORD_HASH)" ]; then
    rm -rf "$DIR/app.prev"
    log "Revision $rev is installed but not started: set the login password first"
    log "(.\\scripts\\deploy.ps1 -SetPassword on your PC)."
    exit 3
  fi
  [ -n "$(env_value CLAUDE_CODE_OAUTH_TOKEN)" ] ||
    log "Warning: CLAUDE_CODE_OAUTH_TOKEN is empty, Claude will not be connected (-SetClaudeToken)."

  systemctl restart "$SERVICE"
  if healthy "$port"; then
    rm -rf "$DIR/app.prev"
    log "Revision $rev is live on 127.0.0.1:$port."
    return 0
  fi
  log "Health check failed. Last logs:"
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  if [ -d "$DIR/app.prev" ]; then
    rm -rf "$DIR/app"
    mv "$DIR/app.prev" "$DIR/app"
    systemctl restart "$SERVICE"
    log "Rolled back to the previous release ($(cat "$DIR/app/REVISION" 2>/dev/null || echo '?'))."
  fi
  exit 1
}

cmd_set_password() {
  [ -f "$DIR/app/dist/hash-password.js" ] || die "Deploy the app first."
  local line
  line=$(cd "$DIR/app" && "$NODE_BIN/node" dist/hash-password.js) || die "Could not hash the password."
  [ -n "$line" ] || die "Empty password."
  set_env APP_PASSWORD_HASH "$line"
  secure_env
  log "Login password updated."
  restart_if_installed
}

cmd_set_claude_token() {
  local token
  token=$(tr -d '\r\n ')
  [[ "$token" =~ ^[A-Za-z0-9._-]{20,}$ ]] || die "That does not look like a Claude Code token."
  set_env CLAUDE_CODE_OAUTH_TOKEN "CLAUDE_CODE_OAUTH_TOKEN=$token"
  secure_env
  log "Claude token updated."
  restart_if_installed
}

case "$CMD" in
  deploy) cmd_deploy "${@:3}" ;;
  set-password) cmd_set_password ;;
  set-claude-token) cmd_set_claude_token ;;
  *) die "Unknown command $CMD." ;;
esac
