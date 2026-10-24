#!/usr/bin/env bash
# Set up the DSH (DeepSeek Harness) Slack bot on a Linux machine from a fresh clone.
#
#   deploy/linux/setup.sh install [--reconfigure]   Node + the dsh CLI + DSH profile/configs + service unit;
#                                            starts nothing. --reconfigure rewrites the configs from the
#                                            templates (old ones kept as .bak-*)
#   deploy/linux/setup.sh keygen             print a one-line public key for the secrets handoff
#   deploy/linux/setup.sh import <blob>      open the sealed secrets (Slack tokens + model API keys)
#   deploy/linux/setup.sh check [--no-model|--all-routes]   verify everything without connecting to Slack's socket
#   deploy/linux/setup.sh netcheck           compare this shell's proxy settings with the service's
#   deploy/linux/setup.sh git-identity "<name>" <email>   who the bot's commits are by (not ~/.gitconfig)
#   deploy/linux/setup.sh start --cutover    start DSH with the Slack channel (only once the old bot is stopped)
#   deploy/linux/setup.sh stop | restart | status | logs [N] | uninstall
#
# Everything the bot owns lives in $DSK_HOME (default ~/.dsh-slack): its own DSH home (DSH_HOME, so an
# existing ~/.dsh is never read or changed), its own shared-agents root (DSH_AGENTS_HOME, so ~/.agents is
# not read), Node, the dsh CLI, secrets and logs. The agent works in $DSK_WORKDIR (default ~/work).
#
# Environment overrides: DSK_HOME, DSK_WORKDIR, DSK_PORT (DSH's local web server, default 4198),
# NODE_VERSION (v24.22.1), DSH_VERSION (0.2.1-rc.2), DSK_SUPERVISOR (system | user | manual).
set -euo pipefail
umask 077

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$REPO_DIR/deploy/linux/setup.sh"
TEMPLATES="$REPO_DIR/deploy/linux/templates"
DSK_HOME="${DSK_HOME:-$HOME/.dsh-slack}"
DSK_WORKDIR="${DSK_WORKDIR:-$HOME/work}"
DSK_PORT="${DSK_PORT:-4198}"
NODE_VERSION="${NODE_VERSION:-v24.22.1}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"

DSH_HOME_DIR="$DSK_HOME/home"
CHECK_HOME="$DSK_HOME/check-home"
AGENTS_HOME="$DSK_HOME/agents"
PROFILE_DIR="$DSH_HOME_DIR/profiles/slack"
CLI_DIR="$DSK_HOME/cli"
DSH_JS="$CLI_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
SECRETS_DIR="$DSK_HOME/secrets"
SLACK_FILE="$SECRETS_DIR/slack.json"
KEYS_FILE="$DSH_HOME_DIR/.env"
SLACK_PATCH="$DSK_HOME/slack-channel.patch.yml"
HANDOFF_KEY="$DSK_HOME/handoff-key.json"
ENV_FILE="$DSK_HOME/env"
LOG_DIR="$DSK_HOME/logs"
LOG_FILE="$LOG_DIR/dsh.log"
UNIT="dsh-slack"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- environment

load_env() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run: $SELF install"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# Proxy and CA settings the service takes over from the installing shell.
NET_VARS="http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY NODE_USE_ENV_PROXY
NODE_EXTRA_CA_CERTS NODE_USE_SYSTEM_CA SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE"

# Append this shell's NET_VARS to the env file ($1) as NAME="value"; NET_NAMES gets the names.
# Loopback (DSH's own web server, the agent's local tools) never goes through the proxy, and Node
# ignores proxy variables unless NODE_USE_ENV_PROXY=1, so that is turned on whenever a proxy is set.
write_net_env() {
  local name value proxy=""
  NET_NAMES=()
  for name in $NET_VARS; do
    value="${!name:-}"
    [ -n "$value" ] || continue
    case "$value" in *[\"\\\$\`]*) say "warning: $name has a character the env file cannot carry; not copied"; continue ;; esac
    case "$name" in
      no_proxy|NO_PROXY) value="$value,127.0.0.1,localhost,::1" ;;
      *_proxy|*_PROXY) proxy=1 ;;
    esac
    printf '%s="%s"\n' "$name" "$value" >> "$1"
    NET_NAMES+=("$name")
  done
  [ -n "$proxy" ] || return 0
  if [ -z "${no_proxy:-}${NO_PROXY:-}" ]; then
    printf 'no_proxy="127.0.0.1,localhost,::1"\nNO_PROXY="127.0.0.1,localhost,::1"\n' >> "$1"
    NET_NAMES+=(no_proxy NO_PROXY)
  fi
  if [ -z "${NODE_USE_ENV_PROXY:-}" ]; then
    printf 'NODE_USE_ENV_PROXY=1\n' >> "$1"
    NET_NAMES+=(NODE_USE_ENV_PROXY)
  fi
}

supervisor() {
  if [ -n "${DSK_SUPERVISOR:-}" ]; then printf '%s\n' "$DSK_SUPERVISOR"; return; fi
  if [ -f "$DSK_HOME/supervisor" ]; then cat "$DSK_HOME/supervisor"; return; fi
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$(id -u)" = 0 ]; then echo system; return; fi
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    if systemctl --user show-environment >/dev/null 2>&1; then echo user; return; fi
  fi
  echo manual
}

sctl() {
  if [ "$(supervisor)" = system ]; then systemctl "$@"; else
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    systemctl --user "$@"
  fi
}

download() { # url → stdout
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else die "need curl or wget to download $1"; fi
}

node_major() { "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0; }

# A Node >= 22.3 (process.getBuiltinModule) with npm in the same directory (npm installs the dsh CLI).
# Images that keep npm elsewhere (node in /usr/bin, npm in /opt/…/bin) get our own Node instead.
find_node() {
  local cand real
  for cand in "$DSK_HOME/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    [ "$(node_major "$cand")" -ge 24 ] || { printf 'not using %s: older than Node 24\n' "$cand" >&2; continue; }
    real="$(readlink -f "$cand")"
    if [ -x "$(dirname "$real")/npm" ]; then printf '%s\n' "$real"; return 0; fi
    if [ -x "$(dirname "$cand")/npm" ]; then printf '%s\n' "$cand"; return 0; fi
    printf 'not using %s: no npm next to it\n' "$cand" >&2
  done
  return 1
}

install_node() {
  local arch tarball url sums tmp
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m) — install Node >= 24 yourself and re-run" ;;
  esac
  tarball="node-$NODE_VERSION-linux-$arch.tar.gz"
  url="https://nodejs.org/dist/$NODE_VERSION"
  tmp="$(mktemp -d)"
  say "downloading $url/$tarball"
  download "$url/$tarball" > "$tmp/$tarball"
  download "$url/SHASUMS256.txt" > "$tmp/SHASUMS256.txt"
  sums="$(grep " $tarball\$" "$tmp/SHASUMS256.txt" | awk '{print $1}')"
  [ -n "$sums" ] || die "no checksum for $tarball in SHASUMS256.txt"
  [ "$(sha256sum "$tmp/$tarball" | awk '{print $1}')" = "$sums" ] || die "checksum mismatch for $tarball"
  rm -rf "$DSK_HOME/node"
  mkdir -p "$DSK_HOME/node"
  tar -xzf "$tmp/$tarball" -C "$DSK_HOME/node" --strip-components=1 --no-same-owner --no-same-permissions
  rm -rf "$tmp"
}

# Fill @…@ in a template. An existing file is kept, unless --reconfigure (then backed up).
RECONFIGURE=0
render() { # template dest
  local src="$1" dest="$2"
  if [ -e "$dest" ]; then
    if [ "$RECONFIGURE" = 0 ]; then say "kept existing $dest"; return; fi
    mv "$dest" "$dest.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "$(dirname "$dest")"
  sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@DSH_HOME@|$DSH_HOME_DIR|g" -e "s|@SLACK_FILE@|$SLACK_FILE|g" \
      -e "s|@WORKDIR@|$DSK_WORKDIR|g" "$src" > "$dest.tmp"
  chmod 600 "$dest.tmp"
  mv "$dest.tmp" "$dest"
  say "wrote $dest"
}

dsh_version() { "$DSK_NODE" "$DSH_JS" --version 2>/dev/null || true; }

# ---------------------------------------------------------------- service

write_unit() {
  local mode="$1" dir wanted user_line=""
  if [ "$mode" = system ]; then
    dir=/etc/systemd/system; wanted=multi-user.target; user_line="User=$(id -un)"
  else
    dir="$HOME/.config/systemd/user"; wanted=default.target
  fi
  mkdir -p "$dir"
  cat > "$dir/$UNIT.service" <<EOF
[Unit]
Description=DSH (DeepSeek Harness) Slack bot
After=network-online.target

[Service]
Type=simple
$user_line
UMask=0077
EnvironmentFile=$ENV_FILE
WorkingDirectory=$DSK_WORKDIR
ExecStart=$DSK_NODE $DSH_JS --profile slack --patch $SLACK_PATCH --port $DSK_PORT --no-open
# SIGTERM lets the Slack channel write its pending queue (waiting messages, running turns)
KillMode=mixed
TimeoutStopSec=45
Restart=always
RestartSec=15
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=$wanted
EOF
  chmod 644 "$dir/$UNIT.service"
  sctl daemon-reload
  say "wrote $dir/$UNIT.service"
}

pidfile() { printf '%s/%s.pid\n' "$DSK_HOME" "$UNIT"; }

# Alive while any process of its group is (the loop leader can die before its child).
manual_running() { local p; p="$(pidfile)"; [ -f "$p" ] && kill -0 -- "-$(cat "$p")" 2>/dev/null; }

manual_start() {
  if manual_running; then say "$UNIT already running (pid $(cat "$(pidfile)"))"; return; fi
  mkdir -p "$LOG_DIR"
  # setsid: own process group, so stop can take the restart loop and DSH together.
  ( cd "$DSK_WORKDIR" && setsid bash -c 'while :; do "$@"; rc=$?; echo "$(date -u +%FT%TZ) exited with $rc; restarting in 15s"; sleep 15; done' \
    _ "$DSK_NODE" "$DSH_JS" --profile slack --patch "$SLACK_PATCH" --port "$DSK_PORT" --no-open >> "$LOG_FILE" 2>&1 < /dev/null & echo $! > "$(pidfile)" )
  say "started $UNIT (pid $(cat "$(pidfile)"), log $LOG_FILE)"
}

manual_stop() { # TERM the whole process group, wait for it to drain, KILL what is left
  local p pgid _
  p="$(pidfile)"
  if manual_running; then
    pgid="$(cat "$p")"
    kill -TERM -- "-$pgid" 2>/dev/null || true
    for _ in $(seq 1 90); do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 -- "-$pgid" 2>/dev/null; then kill -KILL -- "-$pgid" 2>/dev/null || true; say "killed $UNIT (did not exit within 45 s)"
    else say "stopped $UNIT"; fi
  fi
  rm -f "$p"
}

service_running() {
  case "$(supervisor)" in
    manual) manual_running ;;
    *) sctl is-active --quiet "$UNIT.service" ;;
  esac
}

service_start() {
  case "$(supervisor)" in
    manual) load_env; manual_start ;;
    *) sctl enable --now "$UNIT.service" >/dev/null 2>&1 || sctl enable --now "$UNIT.service"; say "enabled + started $UNIT" ;;
  esac
}

service_stop() {
  case "$(supervisor)" in
    manual) manual_stop ;;
    *) sctl disable --now "$UNIT.service" >/dev/null 2>&1 || true; say "stopped + disabled $UNIT" ;;
  esac
}

# Log lines with DSH's local web-server token masked (the URL line carries ?token=…).
masked_log() { sed -E 's/([?&]token=)[A-Za-z0-9_-]+/\1<hidden>/g' "$LOG_FILE"; }

# ---------------------------------------------------------------- commands

cmd_install() {
  [ "$(uname -s)" = Linux ] || die "this script is for Linux"
  case "${1:-}" in --reconfigure) RECONFIGURE=1 ;; "") ;; *) die "usage: $SELF install [--reconfigure]" ;; esac
  mkdir -p "$DSK_HOME" "$LOG_DIR" "$SECRETS_DIR" "$AGENTS_HOME" "$DSH_HOME_DIR" "$CHECK_HOME" "$DSK_WORKDIR"
  chmod 700 "$DSK_HOME" "$SECRETS_DIR" "$DSH_HOME_DIR"

  step "Node >= 24"
  local node
  if ! node="$(find_node)"; then install_node; node="$(find_node)" || die "Node install failed"; fi
  DSK_NODE="$node"
  say "node $("$node" -v) at $node"

  step "dsh CLI $DSH_VERSION ($CLI_DIR)"
  if [ -f "$DSH_JS" ] && [ "$(dsh_version)" = "$DSH_VERSION" ]; then
    say "already installed"
  else
    mkdir -p "$CLI_DIR"
    printf '{\n  "private": true,\n  "dependencies": { "@deepseek-ai/dsh": "%s" }\n}\n' "$DSH_VERSION" > "$CLI_DIR/package.json"
    # The cache stays inside $DSK_HOME (never ~/.npm). Install scripts are not needed: every native
    # addon dsh uses ships a linux prebuild.
    ( cd "$CLI_DIR" && PATH="$(dirname "$node"):$PATH" npm_config_cache="$DSK_HOME/cache/npm" \
        "$(dirname "$node")/npm" install --no-fund --no-audit --loglevel=error )
    [ "$(dsh_version)" = "$DSH_VERSION" ] || die "dsh CLI install failed ($(dsh_version))"
  fi
  say "dsh $(dsh_version)"

  step "environment ($ENV_FILE)"
  local mode; mode="$(supervisor)"
  echo "$mode" > "$DSK_HOME/supervisor"
  # The agent's shell tools inherit this PATH: keep the installing user's PATH (git, gh, …) after ours.
  # HOME too: systemd gives a unit the passwd home of its User=, which is not always where this was
  # installed (root with HOME=/home/<user>), and gh/git look under HOME.
  # A git identity set with `git-identity` survives a re-install.
  local kept_git=""
  [ -f "$ENV_FILE" ] && kept_git="$(grep -E '^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=' "$ENV_FILE" || true)"
  cat > "$ENV_FILE" <<EOF
HOME=$HOME
PATH=$(dirname "$node"):$PATH
DSH_HOME=$DSH_HOME_DIR
DSH_AGENTS_HOME=$AGENTS_HOME
DSH_TELEMETRY_DISABLED=1
DSK_HOME=$DSK_HOME
DSK_NODE=$node
EOF
  [ -n "$kept_git" ] && printf '%s\n' "$kept_git" >> "$ENV_FILE"
  # A service starts without this shell's proxy settings. Where direct egress is blocked (Muse's VM
  # answers https on :443 with plain text) DSH then reaches neither Slack nor the models.
  write_net_env "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "supervisor: $mode"
  if [ "${#NET_NAMES[@]}" -gt 0 ]; then say "network settings taken from this shell (values not shown): ${NET_NAMES[*]}"
  else say "no proxy settings in this shell: the service connects directly"; fi

  step "DSH home ($DSH_HOME_DIR) and the slack profile"
  render "$TEMPLATES/home-cordis.patch.yml" "$DSH_HOME_DIR/cordis.patch.yml"
  render "$TEMPLATES/profile-package.json" "$PROFILE_DIR/package.json"
  render "$TEMPLATES/profile-cordis.yml" "$PROFILE_DIR/cordis.yml"
  render "$TEMPLATES/profile-pnpm-workspace.yaml" "$PROFILE_DIR/pnpm-workspace.yaml"
  render "$TEMPLATES/profile-cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
  render "$TEMPLATES/slack-channel.patch.yml" "$SLACK_PATCH"
  # The headless runs of `check` get their own DSH home (sessions apart) with the same patch and keys.
  ln -sfn "$DSH_HOME_DIR/cordis.patch.yml" "$CHECK_HOME/cordis.patch.yml"
  ln -sfn "$KEYS_FILE" "$CHECK_HOME/.env"

  step "service"
  if [ "$mode" != manual ]; then
    write_unit "$mode"
    if [ "$mode" = user ] && command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$(id -un)" 2>/dev/null || true
      if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
        say "WARNING: lingering is off — the service stops when you log out. Fix: sudo loginctl enable-linger $(id -un)"
      fi
    fi
  else
    say "no usable systemd: the bot runs as a background loop (log $LOG_FILE). It does NOT start again after a"
    say "reboot by itself — add to crontab:  @reboot $SELF start-saved"
  fi
  if service_running; then say "the bot is running: it keeps its old environment and configs until: $SELF restart"; fi

  step "done"
  say "Nothing was started. Next:"
  [ -f "$SLACK_FILE" ] || say "  1. $SELF keygen   (post the printed dsk-pub1:… line; the owner answers with a dsk-sealed1:… blob)"
  [ -f "$SLACK_FILE" ] || say "  2. $SELF import <dsk-sealed1:…>"
  say "  3. $SELF check"
  say "  4. only when told the old bot is stopped: $SELF start --cutover"
}

cmd_keygen() {
  load_env
  "$DSK_NODE" "$REPO_DIR/deploy/secrets.mjs" keygen "$HANDOFF_KEY"
}

cmd_import() {
  [ -n "${1:-}" ] || die "usage: $SELF import <dsk-sealed1:…>"
  load_env
  "$DSK_NODE" "$REPO_DIR/deploy/secrets.mjs" open "$HANDOFF_KEY" "$1" --slack-out "$SLACK_FILE" --env-out "$KEYS_FILE"
  if service_running; then say "the bot is running: the new secrets take effect at: $SELF restart"; fi
}

# Run from the shell whose proxy works: compare its proxy settings with the copy in the env file the
# service uses, and try each one against Slack and GitHub. Prints names, same/different and status codes
# only, never a value.
cmd_netcheck() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run: $SELF install"
  local v s f label c rc out tried=" " any=0
  step "proxy settings: this shell vs $ENV_FILE"
  for v in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY; do
    s="${!v-}"
    f="$(sed -n "s/^$v=//p" "$ENV_FILE" | tail -n 1)"; f="${f#\"}"; f="${f%\"}"
    case "$v" in no_proxy|NO_PROXY) f="${f%,127.0.0.1,localhost,::1}" ;; esac   # install appends loopback
    [ -n "$s$f" ] || continue
    any=1
    if [ -z "$f" ]; then out="not in the env file"
    elif [ -z "$s" ]; then out="only in the env file"
    elif [ "$s" = "$f" ]; then out="same"
    else out="DIFFERENT"; fi
    case "$s" in *://*@*) out="$out; shell value has user:pass@" ;; esac
    case "$f" in *://*@*) out="$out; env file value has user:pass@" ;; esac
    say "$v: $out"
  done
  [ "$any" = 1 ] || say "no proxy settings in this shell or the env file"

  step "CONNECT through each proxy (slack.com, api.github.com, integrate.api.nvidia.com)"
  for v in https_proxy HTTPS_PROXY all_proxy ALL_PROXY; do
    for label in shell envfile; do
      if [ "$label" = shell ]; then s="${!v-}"; else s="$(sed -n "s/^$v=//p" "$ENV_FILE" | tail -n 1)"; s="${s#\"}"; s="${s%\"}"; fi
      [ -n "$s" ] || continue
      case "$tried" in *" $label:$v "*) continue ;; esac
      tried="$tried$label:$v "
      for f in https://slack.com/api/api.test https://api.github.com/zen https://integrate.api.nvidia.com/v1/models; do
        c="$(curl -s -o /dev/null --max-time 20 -x "$s" -w '%{http_connect} %{http_code}' "$f" 2>/dev/null)" && rc=0 || rc=$?
        say "$label $v → ${f#https://}: CONNECT ${c% *} → HTTP ${c#* } (curl exit $rc)"
      done
    done
  done

  step "where this shell's proxy settings come from (file names only)"
  out="$(grep -lsE '^[^#]*(https?_proxy|HTTPS?_PROXY|all_proxy|ALL_PROXY)' /etc/environment /etc/profile /etc/profile.d/* /etc/bash.bashrc \
    "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.zshrc" 2>/dev/null || true)"
  if [ -n "$out" ]; then say "$out"; else say "none of the usual profile files set them (the environment that runs this shell does)"; fi
}

# The bot's commits only: GIT_AUTHOR_*/GIT_COMMITTER_* in the env file. ~/.gitconfig is not touched,
# so whoever else uses git on this machine keeps their own identity.
cmd_git_identity() {
  local name="${1:-}" email="${2:-}" kind tmp
  [ -n "$name" ] && [ -n "$email" ] || die "usage: $SELF git-identity \"<name>\" <email>"
  case "$name$email" in *[\"\\\$\`]*|*$'\n'*) die "name/email must not contain quotes, backslashes, \$, backticks or newlines" ;; esac
  load_env
  tmp="$ENV_FILE.tmp"
  grep -vE '^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=' "$ENV_FILE" > "$tmp" || true
  for kind in AUTHOR COMMITTER; do
    printf 'GIT_%s_NAME="%s"\nGIT_%s_EMAIL="%s"\n' "$kind" "$name" "$kind" "$email" >> "$tmp"
  done
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  say "bot git identity: $name <$email> (in $ENV_FILE; ~/.gitconfig untouched)"
  if service_running; then say "the bot is running: this takes effect at: $SELF restart"; fi
}

cmd_check() {
  load_env
  local args=()
  case "${1:-}" in --no-model|--all-routes) args+=("$1") ;; "") ;; *) die "usage: $SELF check [--no-model|--all-routes]" ;; esac
  # With nothing but the env file, as the service sees it: a setting only this shell has would
  # otherwise pass here and fail after start.
  env -i "$BASH" -c 'set -a; . "$0"; set +a; exec "$@"' "$ENV_FILE" \
    "$DSK_NODE" "$REPO_DIR/deploy/linux/check.mjs" "${args[@]}" \
    --dsh "$DSH_JS" --dsh-version "$DSH_VERSION" --repo "$REPO_DIR" --slack-file "$SLACK_FILE" --keys-file "$KEYS_FILE" \
    --slack-patch "$SLACK_PATCH" --check-home "$CHECK_HOME" --workdir "$DSK_WORKDIR" --port "$DSK_PORT" \
    --running "$(service_running && echo yes || echo no)"
}

cmd_start() {
  [ "${1:-}" = --cutover ] || die "the old bot must be stopped first (two DSH Slack channels on one Slack app split the events between them). Once it is: $SELF start --cutover"
  [ -f "$SLACK_FILE" ] || die "no Slack tokens yet ($SLACK_FILE) — run keygen + import first"
  load_env
  local from=0 _ found=""
  [ -f "$LOG_FILE" ] && from="$(wc -c < "$LOG_FILE")"
  service_start
  echo started > "$DSK_HOME/wanted"
  # The channel logs "own identity resolved" once Slack's Web API answered; a bad token or no route to
  # Slack shows up as warnings instead. (A healthy Socket Mode connection logs nothing.)
  for _ in $(seq 1 45); do
    sleep 2
    found="$(tail -c +"$((from + 1))" "$LOG_FILE" 2>/dev/null | grep -E 'own identity resolved|apps.connections.open failed|socket connect failed|socket loop crashed|slack-channel: no (bot|app) token' | head -n 3 || true)"
    [ -n "$found" ] && break
  done
  say "--- Slack channel"
  if [ -n "$found" ]; then say "$found"; else say "no Slack channel line yet after 90 s"; fi
  say "--- last log lines"
  tail -c +"$((from + 1))" "$LOG_FILE" 2>/dev/null | sed -E 's/([?&]token=)[A-Za-z0-9_-]+/\1<hidden>/g' | tail -n 12
}

cmd_start_saved() { # @reboot entry for the manual supervisor
  [ -f "$DSK_HOME/wanted" ] && service_start
  return 0
}

cmd_stop() {
  service_stop
  rm -f "$DSK_HOME/wanted"
}

cmd_restart() {
  [ -f "$DSK_HOME/wanted" ] || die "the bot was not started with start --cutover"
  # Running turns are interrupted; the channel queues them again after the restart.
  case "$(supervisor)" in
    manual) manual_stop; load_env; manual_start ;;
    *) sctl restart "$UNIT.service"; say "restarted $UNIT" ;;
  esac
}

cmd_status() {
  load_env
  local mode; mode="$(supervisor)"
  say "supervisor: $mode"
  if service_running; then say "$UNIT: running"; else say "$UNIT: not running"; fi
  [ -f "$DSK_HOME/wanted" ] && say "started with --cutover: yes (comes back after a reboot)" || say "started with --cutover: no"
  [ -f "$SLACK_FILE" ] && say "Slack tokens: present" || say "Slack tokens: missing (keygen + import)"
  if [ -f "$LOG_FILE" ]; then
    say "--- last Slack channel lines"
    masked_log | grep -E '\[slack-channel\]|dsh-slack-channel' | tail -n 5 || true
  fi
  if [ -f "$DSH_HOME_DIR/slack-state.json" ]; then
    say "Slack threads with a session: $("$DSK_NODE" -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).chats??{}).length)' "$DSH_HOME_DIR/slack-state.json" 2>/dev/null || echo '?')"
  fi
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || die "no log yet ($LOG_FILE)"
  masked_log | tail -n "${1:-60}"
}

cmd_uninstall() {
  service_stop
  rm -f "$DSK_HOME/wanted"
  case "$(supervisor)" in
    system) rm -f "/etc/systemd/system/$UNIT.service"; systemctl daemon-reload ;;
    user) rm -f "$HOME/.config/systemd/user/$UNIT.service"; sctl daemon-reload ;;
  esac
  say "service removed. The bot's files (secrets, sessions, logs) stay in $DSK_HOME — delete that directory to remove them too."
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  keygen) cmd_keygen ;;
  import) shift; cmd_import "$@" ;;
  check) shift; cmd_check "$@" ;;
  netcheck) cmd_netcheck ;;
  git-identity) shift; cmd_git_identity "$@" ;;
  start) shift; cmd_start "$@" ;;
  start-saved) cmd_start_saved ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '2,20p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
