#!/usr/bin/env bash
# Runs inside the test container (see run.sh) as root with HOME=/home/hatch, like Muse's VM:
# clone → install → keygen → seal/import → check → start --cutover → one Slack mention answered (with an
# approval prompt for a bash call outside the sandbox, clicked Allow, then a bash tool call) → restart → stop.
# Slack, the model APIs and GitHub's MCP host are fakes (fake-world.mjs); nothing real is touched.
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

# A proxy on :8890 that answers every CONNECT with 407 (stale credentials): Node says only "fetch failed" (code 0).
start_refuser() {
  python3 -c 'import socketserver
class H(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(4096); self.request.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("127.0.0.1", 8890), H).serve_forever()' &
  refuser=$!
  trap 'kill $refuser 2>/dev/null' EXIT
  sleep 1
}
stop_refuser() { kill $refuser 2>/dev/null; wait $refuser 2>/dev/null; trap - EXIT; }
# The service env's proxy variables → 127.0.0.1:<port> (a stale copy).
point_env_proxy_at() { sed -i -E 's#^(https?_proxy|HTTPS?_PROXY|all_proxy|ALL_PROXY)=.*#\1="http://127.0.0.1:'"$1"'"#' $DSK/env; }
# Simulate the VM being re-created: the unit and its enable link in /etc are gone, the bot is down.
lose_unit() {
  systemctl disable --now dsh-slack.service >/dev/null 2>&1
  rm -f /etc/systemd/system/dsh-slack.service
  systemctl daemon-reload
}

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
# The key the fake model puts inline in the command it asks approval for; the prompt must mask it.
APPROVAL_SECRET="ghp_$(rand)"
printf '{"bot":"%s","app":"%s","approvalSecret":"%s","keys":{"NVIDIA_API_KEY":"%s","OPENCODE_GO_API_KEY":"%s","DEEPSEEK_API_KEY":"%s"}}\n' \
  "$BOT_TOKEN" "$APP_TOKEN" "$APPROVAL_SECRET" "$NV_KEY" "$GO_KEY" "$DS_KEY" > tokens.json
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
point_env_proxy_at 8889
$REPO/deploy/linux/setup.sh check --no-model > /tmp/check-stale.log 2>&1 && fail "check passed with a dead proxy" || pass "check fails with a dead proxy in the env file"
grep -m1 'Slack Web API\|Slack bot token' /tmp/check-stale.log
grep -q 'proxy in the service environment is unreachable' /tmp/check-stale.log && pass "check names the unreachable proxy" || fail "check does not name the unreachable proxy"
start_refuser
point_env_proxy_at 8890
$REPO/deploy/linux/setup.sh check --no-model > /tmp/check-refused.log 2>&1 && fail "check passed through a refusing proxy" || pass "check fails through a proxy that answers 407"
stop_refuser
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

section "start --cutover → a mention is answered in its thread, after an approved bash call, a bash call and a web_search"
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

section "approvals by rule: an ordinary command outside the sandbox runs without a prompt"
grep '"method":"chat.postMessage"' $LOG | grep '"approve":true' | grep -q 'auto-ok' && fail "the ordinary command got an approval prompt" || pass "no approval prompt for the ordinary command"
grep -q 'approval allowed by rule (bash in .*): echo auto-ok' $DSK/logs/dsh.log && pass "dsh.log records the command allowed by rule" || fail "no 'approval allowed by rule' line for the ordinary command in dsh.log"
case "$answered" in *'auto-ok-42'*) pass "the ordinary command ran outside the sandbox" ;; *) fail "the ordinary command's output is not in the answer" ;; esac

section "the approval prompt shows the command it asks about (key masked), and the click allows it"
prompt="$(grep '"method":"chat.postMessage"' $LOG | grep '"approve":true' | tail -n 1)"
echo "approval prompt: $prompt"
[ -n "$prompt" ] && pass "an approval prompt was posted in the mention's thread" || fail "no approval prompt was posted"
case "$prompt" in *'"thread_ts":"'"$mention_ts"'"'*) pass "the prompt is in the mention's thread" ;; *) fail "the prompt is not in the mention's thread" ;; esac
printf '%s' "$prompt" | grep -qF 'Asked because the command matches the rule' && pass "the prompt names the rule that made it ask" || fail "the prompt does not say which rule made it ask"
shown="GH_TOKEN=ghp_&lt;redacted&gt; sh -c 'echo approval-ok-\$((6*7))' 2&gt;&amp;1 &lt; /dev/null; rm -rf /nonexistent-dsh-e2e"
printf '%s' "$prompt" | grep -qF "$shown" && pass "the prompt shows the command, escaped, the key masked" || fail "the prompt does not show the command as expected: $shown"
printf '%s' "$prompt" | grep -qF '"approvalCall":"*Command*\n```\n' && pass "the command is a code block" || fail "the command is not a code block"
grep -qF "$APPROVAL_SECRET" $LOG && fail "the inline key reached Slack" || pass "the inline key reached no Slack call"
grep -q '"ws":"sent click"' $LOG && pass "Allow was clicked over the socket" || fail "no click was sent"
settled="$(grep '"method":"chat.update"' $LOG | grep 'Approval: allowed once' | tail -n 1)"
echo "settled prompt: $settled"
printf '%s' "$settled" | grep -qF "$shown" && pass "the settled prompt says allowed once and keeps the command" || fail "the settled prompt lost the command or the decision"
case "$answered" in *'approval-ok-42'*) pass "the approved command ran outside the sandbox" ;; *) fail "the approved command's output is not in the answer" ;; esac

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

section "start-saved: running and connected → nothing"
grep -q 'INFO \[slack-socket\] socket connected (num_connections=1)' $DSK/logs/dsh.log && pass "dsh.log has Slack's hello (socket connected)" || fail "no socket connected line in dsh.log"
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss1.log 2>&1 && pass "start-saved exit 0" || fail "start-saved exit $?"
cat /tmp/ss1.log
grep -q 'start-saved: running — nothing to do' /tmp/ss1.log && pass "start-saved leaves a connected bot alone" || fail "start-saved acted on a connected bot"
(flock $DSK/.lock sleep 12) & holder=$!; sleep 1
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss-lock.log 2>&1; rc=$?
wait $holder
grep -q 'another start/stop/start-saved is running' /tmp/ss-lock.log && [ $rc = 0 ] && pass "start-saved yields to a held lock" || { fail "start-saved under a held lock (rc $rc)"; cat /tmp/ss-lock.log; }

section "start-saved after the machine is re-created, from a shell without proxy settings"
lose_unit
$REPO/deploy/linux/setup.sh status > /tmp/status-lost.log 2>&1
grep -q 'service unit: MISSING' /tmp/status-lost.log && pass "status names the missing unit" || { fail "status does not name the missing unit"; cat /tmp/status-lost.log; }
before_env="$(sha256sum < $DSK/env)"
$REPO/deploy/linux/setup.sh start-saved > /tmp/ss2.log 2>&1 && pass "start-saved (no proxy in the shell)" || fail "start-saved (no proxy in the shell) exit $?"
cat /tmp/ss2.log
grep -q "env file's are kept" /tmp/ss2.log && pass "the env file's proxy settings were kept" || fail "start-saved did not keep the env file's proxy settings"
[ "$(sha256sum < $DSK/env)" = "$before_env" ] && pass "env file unchanged" || fail "env file changed"
[ -f /etc/systemd/system/dsh-slack.service ] && systemctl is-active --quiet dsh-slack.service && pass "unit written again, running" || fail "unit/service not back"
grep -q 'start-saved: done — the bot is running and connected to Slack' /tmp/ss2.log && pass "start-saved saw Slack's socket connect" || fail "start-saved: no socket connect"

section "start-saved after the machine is re-created, from the proxy shell → install again"
lose_unit
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss3.log 2>&1 && pass "start-saved (proxy shell)" || fail "start-saved (proxy shell) exit $?"
cat /tmp/ss3.log
grep -q 'install again' /tmp/ss3.log && grep -q 'start-saved: done' /tmp/ss3.log && pass "installed again and connected" || fail "no re-install + connect"
grep -q 'already installed' $DSK/logs/start-saved.log && pass "the installed dsh CLI was kept" || fail "dsh CLI installed anew"
systemctl is-enabled --quiet dsh-slack.service && pass "enabled again" || fail "not enabled"

section "start-saved: socket still up, but the proxy refuses the env file's copy → net-refresh + restart"
# The DSH case: Slack's socket was opened with the old credentials and stays up, every new connection
# (model calls, web search) is refused.
start_refuser
point_env_proxy_at 8890
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss4.log 2>&1 && pass "start-saved (refused copy)" || fail "start-saved (refused copy) exit $?"
stop_refuser
cat /tmp/ss4.log
grep -q "start-saved: RESTARTING — the proxy refuses the env file's settings" /tmp/ss4.log && grep -q 'CONNECT/HTTP 407' /tmp/ss4.log && pass "the refused copy was found (407) while the socket was up" || fail "the refused copy was not found"
grep -q 'start-saved: done' /tmp/ss4.log && pass "restarted and connected again" || fail "not connected after the refresh"
grep -q '127.0.0.1:8890' $DSK/env && fail "the refused proxy is still in the env file" || pass "env file has the shell's proxy again"

section "start-saved: the proxy in the env file is unreachable, the socket keeps failing → net-refresh + restart"
point_env_proxy_at 8889
systemctl restart dsh-slack.service
since="$(date -u +%FT%T)"
for _ in $(seq 1 60); do
  [ "$(sed -nE 's/^([0-9T:.-]+Z) .*apps\.connections\.open failed.*/\1/p' $DSK/logs/dsh.log | awk -v s="$since" '$1 >= s' | wc -l)" -ge 3 ] && break
  sleep 2
done
grep 'apps.connections.open failed' $DSK/logs/dsh.log | tail -n 1 | cut -c1-200
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss6.log 2>&1 && pass "start-saved (failing socket)" || fail "start-saved (failing socket) exit $?"
cat /tmp/ss6.log
grep -q 'start-saved: RESTARTING — the bot cannot reach Slack' /tmp/ss6.log && grep -q 'start-saved: done' /tmp/ss6.log && pass "failing socket found, connected again" || fail "no recovery from a failing socket"
$REPO/deploy/linux/setup.sh status > /tmp/status-history.log 2>&1
grep -A5 'start-saved acted' /tmp/status-history.log | grep -c 'start-saved:' | grep -q '^[3-5]$' && pass "status shows the start-saved history" || { fail "no start-saved history in status"; cat /tmp/status-history.log; }
leak_check /tmp/ss1.log /tmp/ss2.log /tmp/ss3.log /tmp/ss4.log /tmp/ss6.log /tmp/status-lost.log /tmp/status-history.log $DSK/logs/start-saved.log $DSK/logs/start-saved.history

section "/etc/environment's proxy wins when it gets through (a cron run's credentials expire within minutes)"
# On Muse's VM a cron run's proxy credentials are refused minutes later, /etc/environment's (written at
# boot) keep working. Two spellings of the one working proxy tell the sources apart: the shell has
# http://127.0.0.1:8888, /etc/environment http://127.0.0.1:8888/.
ETC_PROXY=http://127.0.0.1:8888/
cp /etc/environment /tmp/environment.orig
printf 'https_proxy="%s"\nhttp_proxy="%s"\nHTTPS_PROXY="%s"\nHTTP_PROXY="%s"\n' $ETC_PROXY $ETC_PROXY $ETC_PROXY $ETC_PROXY >> /etc/environment
muse $REPO/deploy/linux/setup.sh install > /tmp/install-etc.log 2>&1 || fail "install exit $?"
grep -q 'network settings taken from /etc/environment' /tmp/install-etc.log && grep -qx "https_proxy=\"$ETC_PROXY\"" $DSK/env &&
  pass "install took /etc/environment's proxy" || { fail "install did not take /etc/environment's proxy"; tail -n 20 /tmp/install-etc.log; }
grep -qE '^(all_proxy|ALL_PROXY)=' $DSK/env && fail "the shell's all_proxy came along" || pass "no proxy variable from the shell (its credentials expire)"
start_refuser
point_env_proxy_at 8890
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss7.log 2>&1 && pass "start-saved (refused copy, /etc/environment passes)" || fail "start-saved (refused copy, /etc/environment passes) exit $?"
cat /tmp/ss7.log
grep -q "/etc/environment's pass); taking /etc/environment's proxy settings" /tmp/ss7.log && grep -q 'start-saved: done' /tmp/ss7.log &&
  grep -qx "https_proxy=\"$ETC_PROXY\"" $DSK/env && pass "restarted with /etc/environment's proxy" || fail "did not take /etc/environment's proxy"
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss8.log 2>&1
grep -q 'start-saved: running — nothing to do' /tmp/ss8.log && pass "the next run leaves it alone (no restart loop)" || { fail "the next run acted"; cat /tmp/ss8.log; }
# /etc/environment's proxy refused too → this shell's settings, as before.
sed -i -E "s#^(https?_proxy|HTTPS?_PROXY)=.*#\1=\"http://127.0.0.1:8890\"#" /etc/environment
point_env_proxy_at 8890
muse $REPO/deploy/linux/setup.sh start-saved > /tmp/ss9.log 2>&1 && pass "start-saved (both refused)" || fail "start-saved (both refused) exit $?"
stop_refuser
cat /tmp/ss9.log
grep -q "this shell's: 200 .*taking this shell's proxy settings" /tmp/ss9.log && grep -qx "https_proxy=\"$PROXY\"" $DSK/env &&
  pass "fell back to this shell's proxy" || fail "no fallback to this shell's proxy"
cp /tmp/environment.orig /etc/environment

section "logs and status hide a proxy password that a library put in an error"
echo "$(date -u +%FT%T.000Z) WARN [slack-channel] chat.postMessage failed: tunnel via http://muse:PROXYPW-scrub-test@hatch-egress-proxy:3128 refused (407)" >> $DSK/logs/dsh.log
$REPO/deploy/linux/setup.sh logs 5 > /tmp/logs-scrub.log 2>&1
$REPO/deploy/linux/setup.sh status > /tmp/status-scrub.log 2>&1
grep -q 'http://<hidden>@hatch-egress-proxy' /tmp/logs-scrub.log && grep -q 'http://<hidden>@hatch-egress-proxy' /tmp/status-scrub.log &&
  ! grep -q 'PROXYPW-scrub-test' /tmp/logs-scrub.log /tmp/status-scrub.log && pass "proxy password hidden in logs and status" ||
  { fail "proxy password shown"; cat /tmp/logs-scrub.log /tmp/status-scrub.log; }

section "stop"
$REPO/deploy/linux/setup.sh stop
systemctl is-active --quiet dsh-slack.service && fail "still running" || pass "stopped"
systemctl is-enabled --quiet dsh-slack.service && fail "still enabled" || pass "disabled (no start at boot)"
pgrep -af 'dsh/lib/bin.js' | grep -v pgrep && fail "processes left" || pass "no bot processes left"
$REPO/deploy/linux/setup.sh start-saved > /tmp/ss5.log 2>&1
grep -q 'start-saved: not wanted' /tmp/ss5.log && ! systemctl is-active --quiet dsh-slack.service && pass "start-saved leaves a stopped bot stopped" || { fail "start-saved after stop"; cat /tmp/ss5.log; }
ls -la $DSK/home/ | grep -E 'slack-state' || true

section "Muse's own files untouched, no secret in the bot's log"
after_own="$(find $HOME/.dsh $HOME/.agents -type f -exec sha256sum {} + | sort)"
[ "$before_own" = "$after_own" ] && pass "~/.dsh and ~/.agents unchanged" || { fail "Muse's files changed"; diff <(echo "$before_own") <(echo "$after_own"); }
leak_check $DSK/logs/dsh.log /tmp/start.log

printf '\n%s failure(s)\n' "$fails"
exit $(( fails > 0 ))
