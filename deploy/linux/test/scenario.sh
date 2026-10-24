#!/usr/bin/env bash
# Runs inside the test container (see run.sh) as root with HOME=/home/hatch, like Muse's VM:
# clone → install → keygen → seal/import → check → start --cutover → one Slack mention answered (with a
# bash tool call) → restart → stop. Slack, the model APIs and GitHub's MCP host are fakes
# (fake-world.mjs); nothing real is touched.
set -uo pipefail

export HOME=/home/hatch
REPO=$HOME/dsh-slack-channel
DSK=$HOME/.dsh-slack
FAKE=/etc/fakeworld
LOG=/var/log/fakeworld.jsonl
PROXY=http://127.0.0.1:8888
fails=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
section() { printf '\n######## %s\n' "$*"; }
# The shell Muse runs commands in: proxy variables set, plus the test CA for the fakes.
muse() { env http_proxy=$PROXY https_proxy=$PROXY all_proxy=$PROXY no_proxy=localhost,127.0.0.1 \
  HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY ALL_PROXY=$PROXY NO_PROXY=localhost,127.0.0.1 \
  NODE_EXTRA_CA_CERTS=$FAKE/ca.crt HOME=$HOME "$@"; }

section "network like the VM"
# REDIRECT turns an outside destination into 127.0.0.1 with a non-loopback source: allow that.
sysctl -qw net.ipv4.conf.all.route_localnet=1
iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner ! --uid-owner tinyproxy -j REDIRECT --to-ports 8443
iptables -A OUTPUT -o lo -j ACCEPT
# The redirected packet still leaves by the outside route here, so -o lo does not match it.
iptables -A OUTPUT -m conntrack --ctstate DNAT -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner tinyproxy -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/8443) 2>/dev/null && break; sleep 1; done
out="$(curl -4 -sS --max-time 15 -o /dev/null https://registry.npmjs.org/ 2>&1)"
case "$out" in *"wrong version number"*|*"packet length too long"*) pass "direct https fails like the VM ($out)" ;; *) fail "direct https: $out" ;; esac
code="$(muse curl -sS --max-time 30 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ 2>&1)"
[ "$code" = 200 ] && pass "https through the proxy: $code" || fail "https through the proxy: $code"

section "fake hosts: certificates, tokens, a gh that is logged in"
mkdir -p $FAKE && cd $FAKE || exit 1
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=dshslack test CA' -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=slack.com' -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:slack.com,DNS:wss-primary.slack.com,DNS:integrate.api.nvidia.com,DNS:opencode.ai,DNS:api.deepseek.com,DNS:api.githubcopilot.com\n' > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out server.crt 2>/dev/null
rand() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
BOT_TOKEN="xoxb-111-222-$(rand)"; APP_TOKEN="xapp-1-A111-333-$(rand)"
NV_KEY="nvapi-fake-$(rand)"; GO_KEY="oc_sk_fake$(rand)"; DS_KEY="sk-fake$(rand)"; GH_FAKE="gho_fake$(rand)"
printf '{"bot":"%s","app":"%s","keys":{"NVIDIA_API_KEY":"%s","OPENCODE_GO_API_KEY":"%s","DEEPSEEK_API_KEY":"%s"}}\n' \
  "$BOT_TOKEN" "$APP_TOKEN" "$NV_KEY" "$GO_KEY" "$DS_KEY" > tokens.json
chmod 600 tokens.json
# Stand-in for the VM's `gh` (logged in as azumag there): enough for check and the MCP header.
cat > /usr/local/bin/gh <<EOF
#!/bin/sh
case "\$1 \$2" in
  "api user") echo fake-azumag ;;
  "auth token") echo $GH_FAKE ;;
  *) echo "fake gh: \$*" >&2; exit 1 ;;
esac
EOF
chmod 755 /usr/local/bin/gh
SECRETS=("$BOT_TOKEN" "$APP_TOKEN" "$NV_KEY" "$GO_KEY" "$DS_KEY" "$GH_FAKE")
leak_check() { # files…
  local f s found=0
  for f in "$@"; do
    [ -e "$f" ] || continue
    for s in "${SECRETS[@]}"; do grep -qF -- "$s" "$f" && { fail "a secret appears in $f"; found=1; break; }; done
  done
  [ $found = 0 ] && pass "no secret in: $*"
}

section "Muse's own DSH/agents files exist and must stay untouched"
mkdir -p $HOME/.dsh $HOME/.agents
echo '# muse own' > $HOME/.dsh/cordis.patch.yml
echo '# muse own' > $HOME/.agents/AGENTS.md
before_own="$(find $HOME/.dsh $HOME/.agents -type f -exec sha256sum {} + | sort)"

section "clone + install (as the VM: root, HOME=/home/hatch, proxy only in the shell)"
git clone --quiet /repo.git $REPO || { fail clone; exit 1; }
cd $HOME || exit 1
start=$(date +%s)
if muse $REPO/deploy/linux/setup.sh install > /tmp/install.log 2>&1; then pass "install ($(( $(date +%s) - start )) s)"; else fail "install"; fi
tail -n 30 /tmp/install.log
grep -q 'not using /usr/bin/node: no npm next to it' /tmp/install.log && pass "system node without npm skipped, own Node installed" || fail "own Node not chosen"
systemctl is-active --quiet dsh-slack.service && fail "bot started by install" || pass "install did not start the bot"
[ -f /etc/systemd/system/dsh-slack.service ] && pass "system unit written" || fail "no system unit"
grep -E '^(HOME|DSH_HOME|DSH_AGENTS_HOME|NODE_USE_ENV_PROXY|DSH_TELEMETRY_DISABLED)=' $DSK/env
grep -c -iE '^(https?|all|no)_proxy=' $DSK/env | sed 's/^/proxy lines in env file: /'
loose="$(find $DSK /etc/systemd/system/dsh-slack.service ! -type l -perm /o+w | head -5)"
[ -z "$loose" ] && pass "nothing in $DSK is writable by other users" || fail "writable by others: $loose"
loose="$(find $DSK/secrets $DSK/home $DSK/env -perm /o+r | head -5)"
[ -z "$loose" ] && pass "secrets/home/env not readable by others" || fail "readable by others: $loose"
ls $DSK/cli/node_modules/ws/package.json >/dev/null 2>&1 && pass "ws available for the fake world" || fail "no ws in the dsh install"

section "a second install is quick and keeps everything"
start=$(date +%s)
muse $REPO/deploy/linux/setup.sh install > /tmp/install2.log 2>&1 && pass "re-install ($(( $(date +%s) - start )) s)" || { fail "re-install"; tail -20 /tmp/install2.log; }
grep -q 'already installed' /tmp/install2.log && pass "dsh CLI not reinstalled" || fail "dsh CLI reinstalled"
[ "$(grep -c 'kept existing' /tmp/install2.log)" = 6 ] && pass "configs kept" || fail "configs not kept: $(grep -c 'kept existing' /tmp/install2.log)"

section "fake world up (reachable only through the proxy)"
systemd-run --unit fakeworld -E WS_FROM=$DSK/cli/node_modules/ws/package.json -E FAKE_DIR=$FAKE -E FAKE_LOG=$LOG /usr/bin/node /fake-world.mjs
sleep 2
code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' --cacert $FAKE/ca.crt https://slack.com/api/api.test 2>&1)"
case "$code" in 200) fail "fake Slack reachable directly" ;; *) pass "fake Slack not reachable directly ($code)" ;; esac
code="$(muse curl -sS --max-time 10 -o /dev/null -w '%{http_code}' --cacert $FAKE/ca.crt -X POST https://slack.com/api/api.test 2>&1)"
[ "$code" = 200 ] && pass "fake Slack through the proxy" || fail "fake Slack through the proxy: $code"

section "check before the secrets and without bwrap (must fail, nothing secret printed)"
mv /usr/bin/bwrap /usr/bin/bwrap.hidden
$REPO/deploy/linux/setup.sh check --no-model > /tmp/check0.log 2>&1 && fail "check passed without secrets" || pass "check fails without secrets"
mv /usr/bin/bwrap.hidden /usr/bin/bwrap
cat /tmp/check0.log
case "$(grep 'command sandbox' /tmp/check0.log)" in
  '✗ command sandbox'*'bwrap not installed'*|'✓ command sandbox — Landlock'*) pass "without bwrap check reports the sandbox: $(grep -o 'command sandbox.\{0,50\}' /tmp/check0.log)" ;;
  *) fail "no command sandbox line without bwrap" ;;
esac

section "keygen → seal (owner side, from a Mac-like ~/.dsh) → import"
pub="$($REPO/deploy/linux/setup.sh keygen)"
case "$pub" in dsk-pub1:*) pass "keygen: ${pub:0:20}…" ;; *) fail "keygen: $pub" ;; esac
OWNER=/tmp/owner-dsh; mkdir -p $OWNER
cat > $OWNER/cordis.patch.yml <<EOF
- insert:
    - id: slack-channel
      name: /Users/someone/work/dsh-slack-channel/src/index.js
      config:
        botToken: $BOT_TOKEN
        appToken: $APP_TOKEN
        cwd: /Users/someone/work
EOF
cat > $OWNER/.credentials.yaml <<EOF
version: '1'
records:
  client-connection/browser-session:
    kind: grant
refs:
  OPENCODE_GO_API_KEY: '$GO_KEY'
  DEEPSEEK_API_KEY: $DS_KEY
  GROQ_API_KEY: gsk_notneeded
  NVIDIA_API_KEY: "$NV_KEY"
EOF
sealed="$(node $REPO/deploy/secrets.mjs seal "$pub" --dsh-home $OWNER 2>/tmp/seal.err)"
cat /tmp/seal.err
rm -rf $OWNER
case "$sealed" in dsk-sealed1:*) pass "sealed (${#sealed} chars)" ;; *) fail "seal" ;; esac
$REPO/deploy/linux/setup.sh import "$sealed" > /tmp/import.log 2>&1 && pass "import" || fail "import"
cat /tmp/import.log
[ ! -e $DSK/handoff-key.json ] && pass "handoff key deleted" || fail "handoff key left"
$REPO/deploy/linux/setup.sh import "$sealed" > /dev/null 2>&1 && fail "second import worked" || pass "blob cannot be opened twice"
[ "$(stat -c %a $DSK/secrets/slack.json)" = 600 ] && pass "slack.json 600" || fail "slack.json mode"
[ "$(stat -c %a $DSK/home/.env)" = 600 ] && pass "keys .env 600" || fail "keys .env mode"
grep -oE '^[A-Z_]+=' $DSK/home/.env | tr '\n' ' ' | sed 's/^/keys: /'; echo
grep -qE 'GROQ|OPENCODE' $DSK/home/.env && fail "a key the kit does not use was carried" || pass "only NVIDIA_API_KEY + DEEPSEEK_API_KEY carried"
leak_check /tmp/install.log /tmp/install2.log /tmp/import.log /tmp/seal.err /tmp/check0.log

section "check (service env only)"
$REPO/deploy/linux/setup.sh check > /tmp/check.log 2>&1 && pass "check" || fail "check"
cat /tmp/check.log
grep -q '✓ command sandbox — bwrap' /tmp/check.log && pass "check finds bwrap" || fail "check did not find bwrap"
leak_check /tmp/check.log
grep '"host":"integrate.api.nvidia.com"\|"host":"opencode.ai"\|"host":"api.deepseek.com"' $LOG | tail -n 4
grep '"host":"integrate.api.nvidia.com"' $LOG | grep -q '"keyMatches":true' && pass "NVIDIA model call with its key through the proxy" || fail "NVIDIA: no request with the right key"
grep '"host":"api.deepseek.com"' $LOG | grep '"path":"/v1/tools/search"' | grep -q '"keyMatches":true' && pass "DeepSeek Search API with its key through the proxy" || fail "DeepSeek Search API: no request with the right key"
grep -q '"host":"opencode.ai"' $LOG && fail "check called OpenCode" || pass "no OpenCode call"
grep '"host":"api.deepseek.com"' $LOG | grep -q 'messages' && fail "check called a DeepSeek model" || pass "no DeepSeek model call"
grep -q '✓ web search' /tmp/check.log && pass "check: web search" || fail "check: no web search line"
grep -q '"ws":"connected"' $LOG && fail "check opened the Slack socket" || pass "check did not open the Slack socket"

section "net-refresh: a stale proxy copy in the env file"
envsum() { grep -vE '^(https?|all|no|HTTPS?|ALL|NO)_(proxy|PROXY)=|^NODE_USE_ENV_PROXY=' $DSK/env | sha256sum; }
others_before="$(envsum)"
sed -i -E 's#^(https?_proxy|HTTPS?_PROXY|all_proxy|ALL_PROXY)=.*#\1="http://127.0.0.1:8889"#' $DSK/env
$REPO/deploy/linux/setup.sh check --no-model > /tmp/check-stale.log 2>&1 && fail "check passed with a dead proxy" || pass "check fails with a dead proxy in the env file"
grep -m1 'Slack Web API\|Slack bot token' /tmp/check-stale.log
grep -q 'proxy in the service environment is unreachable' /tmp/check-stale.log && pass "check names the unreachable proxy" || fail "check does not name the unreachable proxy"
# A proxy that answers every CONNECT with 407 (stale credentials): Node says only "fetch failed" (code 0).
python3 -c 'import socketserver
class H(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(4096); self.request.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("127.0.0.1", 8890), H).serve_forever()' &
refuser=$!
trap 'kill $refuser 2>/dev/null' EXIT
sed -i -E 's#^(https?_proxy|HTTPS?_PROXY|all_proxy|ALL_PROXY)=.*#\1="http://127.0.0.1:8890"#' $DSK/env
sleep 1
$REPO/deploy/linux/setup.sh check --no-model > /tmp/check-refused.log 2>&1 && fail "check passed through a refusing proxy" || pass "check fails through a proxy that answers 407"
kill $refuser 2>/dev/null; trap - EXIT
grep -m1 'Slack Web API\|Slack bot token' /tmp/check-refused.log
grep -q 'the proxy refused the tunnel' /tmp/check-refused.log && pass "check names the refused tunnel" || fail "check does not name the refused tunnel"
before="$(sha256sum < $DSK/env)"
$REPO/deploy/linux/setup.sh net-refresh > /tmp/netrefresh0.log 2>&1 && fail "net-refresh ran without proxy settings" || pass "net-refresh refuses a shell without proxy settings: $(tail -n 1 /tmp/netrefresh0.log | cut -c1-80)"
[ "$(sha256sum < $DSK/env)" = "$before" ] && pass "env file untouched by the refused net-refresh" || fail "refused net-refresh changed the env file"
muse $REPO/deploy/linux/setup.sh net-refresh > /tmp/netrefresh.log 2>&1 && pass "net-refresh" || fail "net-refresh"
cat /tmp/netrefresh.log
[ "$(envsum)" = "$others_before" ] && pass "net-refresh kept every other env line" || fail "net-refresh changed other env lines"
[ "$(stat -c %a $DSK/env)" = 600 ] && pass "env file still 600" || fail "env file mode after net-refresh"
$REPO/deploy/linux/setup.sh check --no-model > /tmp/check-refreshed.log 2>&1 && pass "check passes after net-refresh" || { fail "check after net-refresh"; cat /tmp/check-refreshed.log; }
leak_check /tmp/check-stale.log /tmp/check-refused.log /tmp/netrefresh0.log /tmp/netrefresh.log /tmp/check-refreshed.log

section "start needs --cutover"
$REPO/deploy/linux/setup.sh start > /tmp/start0.log 2>&1 && fail "start without --cutover" || pass "start refuses without --cutover: $(head -c 90 /tmp/start0.log)"

section "start --cutover → a mention is answered in its thread, after a bash call and a web_search"
$REPO/deploy/linux/setup.sh start --cutover | tee /tmp/start.log
answered=""
for _ in $(seq 1 90); do
  answered="$(grep '"method":"chat.postMessage"' $LOG | grep 'tools printed' | tail -n 1)"
  [ -n "$answered" ] && break
  sleep 2
done
mention_ts="$(grep '"ws":"sent mention"' $LOG | tail -n 1 | sed -E 's/.*"ts":"([^"]+)".*/\1/')"
echo "mention ts: $mention_ts"
echo "reply: $answered"
grep '"method":"chat.postMessage"' $LOG | cut -c1-300
case "$answered" in
  *'"channel":"C0C8YJTC147"'*'"thread_ts":"'"$mention_ts"'"'*'tool-ok-42'*) pass "answered in the mention's thread with the bash tool's output" ;;
  *) fail "no answer with the tool output in the thread" ;;
esac
case "$answered" in *'example.com'*) pass "the answer carries the web_search result" ;; *) fail "no web_search result in the answer" ;; esac
grep '"path":"/v1/tools/search"' $LOG | grep '"query":"container test"' | grep -q '"keyMatches":true' && pass "web_search went to DeepSeek's Search API with the key, through the proxy" || fail "web_search did not reach the Search API with the key"
grep '"host":"integrate.api.nvidia.com"' $LOG | grep '"hasBash":true' | grep '"web":\[' | grep 'web_search' | grep -q 'web_fetch' && pass "the Slack agent has web_search + web_fetch" || fail "web tools missing from the Slack agent"
grep -q '"host":"opencode.ai"' $LOG && fail "the bot called OpenCode" || pass "the bot called no OpenCode model"
grep -q '"ws":"connected"' $LOG && pass "Socket Mode connected through the proxy" || fail "socket never connected"
grep -q 'own identity resolved' /tmp/start.log && pass "start --cutover shows the channel's identity line" || fail "no identity line in start --cutover"
grep -q 'INFO \[slack-channel\]' $DSK/logs/dsh.log && pass "DSH log records reach dsh.log" || fail "no DSH log records in dsh.log"
grep '"host":"integrate.api.nvidia.com"' $LOG | grep '"hasBash":true' | tail -n 2
grep -E 'CONNECT' /var/log/tinyproxy/tinyproxy.log | grep -oE '[a-z0-9.-]+:443' | sort | uniq -c
$REPO/deploy/linux/setup.sh logs 40 | cut -c1-240
$REPO/deploy/linux/setup.sh status

section "restart: reconnects"
$REPO/deploy/linux/setup.sh restart && sleep 20
systemctl is-active --quiet dsh-slack.service && pass "running after restart" || fail "not running after restart"
[ "$(grep -c '"ws":"connected"' $LOG)" -ge 2 ] && pass "reconnected after restart" || fail "no reconnect after restart"

section "net-refresh while running: restarts"
muse $REPO/deploy/linux/setup.sh net-refresh > /tmp/netrefresh2.log 2>&1 && pass "net-refresh while running" || fail "net-refresh while running"
cat /tmp/netrefresh2.log
grep -q "restarted dsh-slack" /tmp/netrefresh2.log && pass "net-refresh restarted the bot" || fail "net-refresh did not restart the bot"
sleep 20
[ "$(grep -c '"ws":"connected"' $LOG)" -ge 3 ] && pass "reconnected after net-refresh" || fail "no reconnect after net-refresh"

section "stop"
$REPO/deploy/linux/setup.sh stop
systemctl is-active --quiet dsh-slack.service && fail "still running" || pass "stopped"
systemctl is-enabled --quiet dsh-slack.service && fail "still enabled" || pass "disabled (no start at boot)"
pgrep -af 'dsh/lib/bin.js' | grep -v pgrep && fail "processes left" || pass "no bot processes left"
ls -la $DSK/home/ | grep -E 'slack-state' || true

section "Muse's own files untouched, no secret in the bot's log"
after_own="$(find $HOME/.dsh $HOME/.agents -type f -exec sha256sum {} + | sort)"
[ "$before_own" = "$after_own" ] && pass "~/.dsh and ~/.agents unchanged" || { fail "Muse's files changed"; diff <(echo "$before_own") <(echo "$after_own"); }
leak_check $DSK/logs/dsh.log /tmp/start.log

printf '\n%s failure(s)\n' "$fails"
exit $(( fails > 0 ))
