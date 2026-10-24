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
#   deploy/linux/setup.sh net-refresh        copy this shell's proxy settings to the service again (restarts it)
#   deploy/linux/setup.sh git-identity "<name>" <email>   who the bot's commits are by (not ~/.gitconfig)
#   deploy/linux/setup.sh start --cutover    start DSH with the Slack channel (only once the old bot is stopped)
#   deploy/linux/setup.sh start-saved        for cron: bring a started bot back when it is down (machine re-created)
#                                            or keeps failing to reach Slack (stale proxy copy); otherwise nothing
#   deploy/linux/setup.sh stop | restart | status | logs [N] | uninstall
#
# Everything the bot owns lives in $DSK_HOME (default ~/.dsh-slack): its own DSH home (DSH_HOME, so an
# existing ~/.dsh is never read or changed), its own shared-agents root (DSH_AGENTS_HOME, so ~/.agents is
# not read), Node, the dsh CLI, secrets and logs. The agent works in $DSK_WORKDIR (default ~/work).
#
# Environment overrides: DSK_HOME, DSK_WORKDIR, DSK_PORT (DSH's local web server, default 4198),
# NODE_VERSION (v24.22.1), DSH_VERSION (0.2.1-rc.2), DSK_SUPERVISOR (system | user | manual).
# Extra variables for the bot go in $DSK_HOME/env.local (install rewrites env and appends env.local).
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

shell_has_proxy() { local name; for name in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY; do [ -n "${!name:-}" ] && return 0; done; return 1; }

env_has_proxy() { [ -f "$ENV_FILE" ] && grep -qE '^(https?_proxy|all_proxy|HTTPS?_PROXY|ALL_PROXY)=' "$ENV_FILE"; }

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

unit_path() {
  case "$(supervisor)" in
    system) printf '/etc/systemd/system/%s.service\n' "$UNIT" ;;
    user) printf '%s/.config/systemd/user/%s.service\n' "$HOME" "$UNIT" ;;
  esac
}

# One start / stop / start-saved at a time: a cron run and a person can overlap, and a stop must not be
# undone by a start-saved that read `wanted` just before it was removed. fd 9 is closed for the bot itself
# (manual_start), so the lock never outlives this script.
lock_kit() { # seconds to wait
  exec 9> "$DSK_HOME/.lock"
  command -v flock >/dev/null 2>&1 || return 0
  flock -w "$1" 9
}

pidfile() { printf '%s/%s.pid\n' "$DSK_HOME" "$UNIT"; }

# Alive while any process of its group is (the loop leader can die before its child).
manual_running() { local p; p="$(pidfile)"; [ -f "$p" ] && kill -0 -- "-$(cat "$p")" 2>/dev/null; }

manual_start() {
  if manual_running; then say "$UNIT already running (pid $(cat "$(pidfile)"))"; return; fi
  mkdir -p "$LOG_DIR"
  # setsid: own process group, so stop can take the restart loop and DSH together.
  ( cd "$DSK_WORKDIR" && exec 9>&- && setsid bash -c 'while :; do "$@"; rc=$?; echo "$(date -u +%FT%TZ) exited with $rc; restarting in 15s"; sleep 15; done' \
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

# When the running bot started, as UTC "YYYY-MM-DDTHH:MM:SS" (empty when unknown).
running_since() {
  local at
  case "$(supervisor)" in
    manual) [ -f "$(pidfile)" ] && date -u -r "$(pidfile)" +%FT%T 2>/dev/null || true ;;
    *) at="$(sctl show "$UNIT.service" -p ActiveEnterTimestamp --value 2>/dev/null || true)"
       [ -n "$at" ] && [ "$at" != n/a ] && date -u -d "$at" +%FT%T 2>/dev/null || true ;;
  esac
}

# Each Socket Mode attempt of the bot ends in one of these dsh.log lines, as "<ts> <what>" (only those at
# or after $1, an ISO time, when given). "socket connected" comes from log-stdout.mjs (Slack's hello).
socket_lines() {
  [ -f "$LOG_FILE" ] || return 0
  sed -nE 's/^([0-9T:.-]+Z) [A-Z]+ \[slack-(channel|socket)\] (socket connected|socket closed|socket connect failed|apps\.connections\.open failed).*/\1 \3/p' "$LOG_FILE" |
    awk -v since="${1:-}" '$1 >= since' || true
}

# The channel retries every few seconds, so three attempts in a row without "socket connected" since the
# bot started = it cannot reach Slack (a dead or refused proxy copy, or Slack itself is down).
socket_failing() {
  local last; last="$(socket_lines "$(running_since)" | tail -n 3)"
  [ "$(grep -c . <<<"$last")" -ge 3 ] && ! grep -q 'socket connected' <<<"$last"
}

connected_since() { grep -q 'socket connected' <<<"$(socket_lines "$1")"; }

# A variable's value in the env file (quotes removed), empty when absent.
env_get() { local v; v="$(sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1)"; v="${v#\"}"; printf '%s' "${v%\"}"; }

# "<CONNECT code> <HTTP code>" of a request to Slack through proxy $1 (000: none).
proxy_codes() { curl -s -o /dev/null --max-time 20 -x "$1" -w '%{http_connect} %{http_code}' https://slack.com/api/api.test 2>/dev/null || true; }

# The proxy itself said no: 401/403/407 to the CONNECT. A timeout or an error from Slack is not a refusal:
# re-copying the settings would not help, so it must not cause a restart.
proxy_refused() { case "$1" in 401\ *|403\ *|407\ *) return 0 ;; esac; return 1; }
proxy_passes() { case "$1" in 200\ *) return 0 ;; esac; return 1; }

# Muse's VM hands each shell new proxy credentials, and the copy in the env file can stop working. The
# running bot does not notice on Slack (its socket was opened earlier), but every new connection (each
# model call, web search, GitHub) is refused. 0 when the proxy refuses the copy (asked twice) and lets
# this shell's settings through, i.e. when net-refresh helps. Sets PROBE_NOTE to the codes seen.
env_proxy_stale() {
  command -v curl >/dev/null 2>&1 || return 1
  local f s env_codes shell_codes
  f="$(env_get https_proxy)"; [ -n "$f" ] || f="$(env_get HTTPS_PROXY)"
  s="${https_proxy:-${HTTPS_PROXY:-}}"
  [ -n "$f" ] && [ -n "$s" ] && [ "$f" != "$s" ] || return 1
  env_codes="$(proxy_codes "$f")"
  proxy_refused "$env_codes" || return 1
  sleep 3
  env_codes="$(proxy_codes "$f")"
  proxy_refused "$env_codes" || return 1
  shell_codes="$(proxy_codes "$s")"
  PROBE_NOTE="env file's: CONNECT/HTTP $env_codes; this shell's: $shell_codes"
  proxy_passes "$shell_codes"
}

# A start-saved line, also kept in $LOG_DIR/start-saved.history (how often it had to act, and why).
record() { say "$*"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG_DIR/start-saved.history" 2>/dev/null || true; }
die_saved() { record "error: $*" >&2; exit 1; }

# Text from logs with DSH's local web-server token masked (the URL line carries ?token=…) and the user:password
# of any URL hidden: the service's proxy settings carry credentials, and some libraries put the proxy URL in errors.
scrub() { sed -E 's/([?&]token=)[A-Za-z0-9_-]+/\1<hidden>/g; s#(://)[^/@[:space:]]+@#\1<hidden>@#g'; }
masked_log() { scrub < "$LOG_FILE"; }

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
  # Lines added by hand would be lost here (start-saved re-runs install after the machine is re-created).
  [ -f "$DSK_HOME/env.local" ] && cat "$DSK_HOME/env.local" >> "$ENV_FILE"
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
  say "where /etc does not survive a reboot (the unit is lost), run every 10 min from cron: $SELF start-saved"
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

# Copy this shell's proxy and CA settings into the env file again, replacing only those lines (for when
# the shell's proxy settings changed after install), and restart the bot if it was started. Names only.
cmd_net_refresh() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run: $SELF install"
  local name names="" tmp="$ENV_FILE.tmp"
  shell_has_proxy || die "this shell has no proxy settings — run this from the shell whose proxy works; $ENV_FILE left as it is"
  for name in $NET_VARS; do names="$names|$name"; done
  grep -vE "^(${names#|})=" "$ENV_FILE" > "$tmp" || true
  write_net_env "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  say "network settings taken from this shell (values not shown): ${NET_NAMES[*]}"
  if [ -f "$DSK_HOME/wanted" ]; then cmd_restart; else say "the bot is not started; nothing to restart"; fi
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
  lock_kit 120 || die "another start/stop/start-saved is running ($DSK_HOME/.lock)"
  local from=0 _ found=""
  [ -f "$LOG_FILE" ] && from="$(wc -c < "$LOG_FILE")"
  service_start
  echo started > "$DSK_HOME/wanted"
  # "own identity resolved" = Slack's Web API answered, "socket connected" = Slack accepted the Socket Mode
  # connection; a bad token or no route to Slack shows up as warnings instead.
  for _ in $(seq 1 45); do
    sleep 2
    found="$(tail -c +"$((from + 1))" "$LOG_FILE" 2>/dev/null | scrub | grep -E 'own identity resolved|socket connected|apps.connections.open failed|socket connect failed|socket closed|socket loop crashed|slack-channel: no (bot|app) token' | head -n 4 || true)"
    grep -qE 'socket connected|failed|socket closed|crashed|no (bot|app) token' <<<"$found" && break
  done
  say "--- Slack channel"
  if [ -n "$found" ]; then say "$found"; else say "no Slack channel line yet after 90 s"; fi
  say "--- last log lines"
  tail -c +"$((from + 1))" "$LOG_FILE" 2>/dev/null | scrub | tail -n 12
}

# For cron (every few minutes) or @reboot: bring back a bot that was started with start --cutover and not
# stopped since ($DSK_HOME/wanted), using only what survives in $DSK_HOME. Prints "start-saved:" lines
# saying what it did; exit 1 only when it tried and failed.
#  - not wanted: nothing. A stopped bot stays stopped.
#  - wanted, running, Slack's socket not failing, the env file's proxy settings accepted: nothing.
#  - wanted, not running (machine re-created: the unit in /etc is gone): install again with this shell's
#    proxy settings (configs, secrets and sessions kept), then start. A shell without proxy settings keeps
#    the env file's and only writes the unit again.
#  - wanted, running, but the proxy refuses the env file's settings while this shell's get through, or the
#    last socket attempts since it started all failed: take this shell's proxy settings and restart (running
#    turns are interrupted and queued again).
cmd_start_saved() {
  local since why _
  [ -d "$DSK_HOME" ] || die "start-saved: $DSK_HOME not found — run it as the user who installed the bot (HOME=$HOME)"
  [ -f "$DSK_HOME/wanted" ] || { say "start-saved: not wanted (stopped, or never started with --cutover) — nothing to do"; return 0; }
  lock_kit 5 || { say "start-saved: another start/stop/start-saved is running — nothing to do"; return 0; }
  [ -f "$DSK_HOME/wanted" ] || { say "start-saved: stopped meanwhile — nothing to do"; return 0; }
  mkdir -p "$LOG_DIR"
  since="$(date -u +%FT%T)"
  if [ -f "$ENV_FILE" ] && service_running; then
    if env_proxy_stale; then why="the proxy refuses the env file's settings and lets this shell's through ($PROBE_NOTE)"
    elif socket_failing; then why="the bot cannot reach Slack (last socket attempts failed)"
    else say "start-saved: running — nothing to do"; return 0; fi
    shell_has_proxy || die_saved "start-saved: $why and this shell has no proxy settings to give it"
    record "start-saved: RESTARTING — $why; taking this shell's proxy settings"
    cmd_net_refresh
  else
    if ! shell_has_proxy && env_has_proxy; then
      record "start-saved: RECOVERING — the bot should run but does not; this shell has no proxy settings, so the env file's are kept"
      load_env
      [ -x "$DSK_NODE" ] && [ -f "$DSH_JS" ] || die_saved "start-saved: Node or the dsh CLI is gone, and this shell has no proxy settings to download them"
      [ "$(supervisor)" = manual ] || [ -f "$(unit_path)" ] || write_unit "$(supervisor)"
    else
      record "start-saved: RECOVERING — the bot should run but does not; install again (configs, secrets and sessions kept; log $LOG_DIR/start-saved.log), then start"
      if ! "$SELF" install > "$LOG_DIR/start-saved.log" 2>&1; then
        scrub < "$LOG_DIR/start-saved.log" | tail -n 15
        die_saved "start-saved: install failed"
      fi
      load_env
    fi
    service_start
  fi
  for _ in $(seq 1 60); do connected_since "$since" && break; sleep 2; done
  socket_lines "$since" | tail -n 3
  service_running || die_saved "start-saved: the bot is not running after the start"
  connected_since "$since" || die_saved "start-saved: started, but Slack's socket did not connect within 120 s"
  record "start-saved: done — the bot is running and connected to Slack"
}

cmd_stop() {
  [ -d "$DSK_HOME" ] && { lock_kit 120 || die "another start/stop/start-saved is running ($DSK_HOME/.lock)"; }
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
  if [ -f "$DSK_HOME/wanted" ]; then
    say "started with --cutover: yes (start-saved brings it back when it is down; run it from cron where /etc is lost on reboot)"
    [ "$(supervisor)" = manual ] || [ -f "$(unit_path)" ] || say "service unit: MISSING ($(unit_path)) — run: $SELF start-saved"
  else say "started with --cutover: no"; fi
  say "last Slack socket attempts: $(socket_lines | tail -n 3 | tr '\n' ';' | sed 's/;$//; s/;/; /g')"
  if [ -s "$LOG_DIR/start-saved.history" ]; then say "start-saved acted (last 5, UTC):"; tail -n 5 "$LOG_DIR/start-saved.history"; fi
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
  [ -d "$DSK_HOME" ] && { lock_kit 120 || die "another start/stop/start-saved is running ($DSK_HOME/.lock)"; }
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
  net-refresh) cmd_net_refresh ;;
  git-identity) shift; cmd_git_identity "$@" ;;
  start) shift; cmd_start "$@" ;;
  start-saved) cmd_start_saved ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '2,24p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
