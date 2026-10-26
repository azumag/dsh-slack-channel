# dsh-slack-channel

A Slack **channel** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): point a Slack bot at a DSH runtime and drive the agent from any Slack channel or DM. One live agent session per channel — or per Slack thread with `sessionScope: thread` — replies posted back in-thread.

Pure `fetch` + the platform `WebSocket` — no npm dependencies, no build step, Node ≥ 22. **Socket Mode needs no public URL** — the bot holds an outbound websocket, so it works behind NAT/firewalls.

## What it does

| Slack side | DSH side |
|---|---|
| message event (channels, groups, DMs) | `createTextUserMessage` → `agent.followup()` — the same in-process seam the [ACP bridge](../../code/deepseek-harness/packages/acp/acp) uses |
| committed assistant text | collected per turn from `session/event` (`assistant/message`), posted on `turn/end` via `chat.postMessage` |
| /stop command | `agent.cancel({ kind: 'user' })` + queue clear |
| /new command | dispose the channel's agent, start a fresh session |
| reaction ack | ⏳ reaction while the turn runs, removed when the reply lands |
| errors | `agent/error` quoted back to the channel |
| a message that mentions the bot | the reply opens with a mention of that message's author (`<@U123>`) |
| a message from another app | served like any other message — one agent, several integrations in one channel |
| a permission approval (`approval/request`) | posted as a Block Kit prompt with **Allow once** / **Deny** buttons; the click decides the request |
| an `ask_user_question` call | posted as its options, one button each; a free-form question is answered by a plain channel reply |
| nobody answers a prompt | it expires (`interactiveTimeoutMs`, 30 minutes by default) and the turn continues fail-closed, so the channel is never left blocked |

Sessions are created through `ctx.agents` (`inject: ['agents']`), so each channel gets a real DSH session with its own history, tools, and model route. `auth.test` identifies this bot once at startup: its own messages are skipped so the agent never reacts to itself, while messages from **other** apps (their own `bot_id`) are served. Every other `subtype` — edits, deletes, joins, thread broadcasts — is a trace and never drives the agent.

Mention-back covers humans and apps alike: whoever wrote `<@our-id>` gets `<@their-id>` in front of the answer. Two agents that mention each other can therefore keep answering each other — see [Known limitations](#known-limitations).

## Requirements

- Node ≥ 22 (platform `fetch` + `WebSocket`)
- A DSH runtime composition that provides the `agents` service (any agent-loop-bearing composition — the default web/headless profiles qualify)
- A Slack workspace where you can install apps
- **Slack-side setup** — see the next section; budget ~10 minutes

## Slack app setup (10 minutes)

Create the app at [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From scratch* → name it (e.g. `deepseeker`), pick your workspace. Then five stops in the app's settings:

### 1. App-level token (`xapp-…`) — *Basic Information* page

Scroll to **App-Level Tokens** → **Generate Token and Scopes**:

- Name: `socket` (anything)
- Scope to add: **`connections:write`**

**Generate** and copy — this token is shown only once. It authenticates the Socket Mode websocket and nothing else.

> ⚠️ Don't confuse this page's other credentials with what the plugin needs: the **Client Secret**, **Signing Secret**, and deprecated **Verification Token** belong to the HTTP-webhook/OAuth install flows, which this plugin never touches. You can leave them untouched (or regenerate them — it changes nothing here).

### 2. Bot token scopes + install (`xoxb-…`) — *OAuth & Permissions* page

Scroll to **Scopes** → *Bot Token Scopes* → **Add an OAuth Scope** for each:

| Scope | Why |
|---|---|
| `chat:write` | post replies |
| `channels:history` | read messages in public channels |
| `groups:history` | read messages in private channels |
| `im:history` | read DMs |
| `reactions:write` | the ⏳ working reaction |
| `reactions:read` | remove it when done |

Then scroll up that page → **Install to Workspace** → **Allow** → copy the **Bot User OAuth Token** (`xoxb-…`). Adding scopes later requires clicking *Reinstall* — do that whenever you change scopes.

### 3. Socket Mode — *Socket Mode* page

Toggle **On**. (This is what the `xapp-` token is for; without it the plugin can't connect — and you never need a public URL or TLS.)

### 4. Interactivity — *Interactivity & Shortcuts* page

Toggle **On** and leave the Request URL empty: with Socket Mode the click payloads arrive over the same websocket. This is what makes the **Allow once** / **Deny** buttons on an approval prompt (and the option buttons of an `ask_user_question` prompt) work. The text fallbacks — `!allow`, `!deny`, `!answer <text>` — keep working without it.

### 5. Event subscriptions — *Event Subscriptions* page

Toggle **Enable Events** → *Subscribe to bot events* → add exactly:

- `message.channels` (public channels)
- `message.groups` (private channels)
- `message.im` (DMs)

**Save Changes**.

> ⚠️ Do **not** subscribe `app_mention` — Slack would deliver both the mention and the underlying message, and the agent would answer twice.

### 6. Invite the bot and grab a channel id

In Slack: `/invite @yourbot` in the channel you want served (DMs need no invite — find the bot under **Apps** in your sidebar).

Get the channel id either way:

- Post `/id` in the channel once the plugin is running — the bot replies with the id, or
- Slack UI: channel name → *About* tab → **Channel ID** (starts `C` public / `G` private / `D` DM)

### Which Slack credentials matter — summary

| Credential | Page | Used by the plugin |
|---|---|---|
| **App-Level Token** (`xapp-`) | Basic Information → App-Level Tokens | ✅ Socket Mode connection |
| **Bot User OAuth Token** (`xoxb-`) | OAuth & Permissions (after install) | ✅ all Web API calls |
| Client ID / Client Secret | Basic Information | ❌ (OAuth install flow only) |
| Signing Secret | Basic Information | ❌ (HTTP webhook verification only) |
| Verification Token | Basic Information | ❌ (deprecated) |

## Configure the plugin

Keep both tokens out of the repo — the overlay reads them from the environment:

```yaml
- insert:
    - id: slack-channel
      name: dsh-slack-channel            # or the absolute path to src/index.js
      inject: [agents]
      config:
        botToken: !!js process.env.SLACK_BOT_TOKEN
        appToken: !!js process.env.SLACK_APP_TOKEN
        # Target channels: Slack channel ids from /id (C…/G…/D…).
        allowedChannelIds: ['C0123456789']
```

The shipped [`cordis.patch.yml`](cordis.patch.yml) is exactly this, with every knob documented — mount it directly:

```sh
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
  pnpm dsh web --patch /path/to/dsh-slack-channel/cordis.patch.yml
```

For a **headless runtime** (no GUI — the whole agent lives behind Slack), boot the headless profile the same way and keep the process running:

```sh
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
  pnpm dsh --profile headless --patch /path/to/dsh-slack-channel/cordis.patch.yml
```

Prefer not to restart on config changes? Set `pairToken` + `stateFile` once, then enroll channels from Slack itself with `/pair <token>` — no host restart, enrollments persist.

### Linux server kit

[`deploy/linux/setup.sh`](deploy/linux/setup.sh) sets the bot up on a Linux machine from a clone, without the desktop app: its own Node and the npm `dsh` CLI, a `slack` profile with the desktop profile's bundles (models: NVIDIA only; DeepSeek's key serves web search/fetch), a systemd service (`dsh-slack.service`; a background loop where there is no systemd) and everything else under `~/.dsh-slack` (its own `DSH_HOME`). Secrets travel sealed to a one-time key generated on the target (`keygen` → `deploy/secrets.mjs seal` on the source → `import`); `check` tests the install with only the service's environment — tokens, proxy, one headless model turn per provider — without opening the Slack socket, and whether the bash tool has a command sandbox (DSH on Linux confines commands with bubblewrap, else Landlock, and runs none when neither works — `apt-get install bubblewrap` where the kernel has no Landlock); the service starts only with `start --cutover`, because two connections on one Slack app split the events. DSH's log records go to `~/.dsh-slack/logs/dsh.log` (the CLI keeps them in memory otherwise). [`deploy/linux/test/run.sh`](deploy/linux/test/run.sh) runs the whole flow in an Ubuntu container behind an HTTP proxy against fake Slack and model APIs. The walkthrough used to move the bot to another machine is [`docs/MUSE_HANDOFF.md`](docs/MUSE_HANDOFF.md) (Japanese).

### Handing the bot over to another host (receive off)

Two Socket Mode connections on one Slack app split the events between them, so only one host should receive. To move the bot without cutting the turns that run on the old host, start the new host first, then create the **receive-off file** beside the old host's `stateFile` (`state.json` → `state.receive-off`; any content):

```sh
touch ~/.dsh/slack-state.receive-off      # the old host: close the socket, keep working
```

Within `receivePollMs` the old host closes its Slack socket (no plugin reload: nothing running there stops). Turns already running and messages already waiting in its queue still run there and reply through the Web API; new messages reach the new host only. An approval or `ask_user_question` raised on the old host is declined at once (`unavailable` / an error naming the handover), because the clicks and `!answer`s now go to the new host. The old host writes what is left to `state.drain.json` (`running` / `waiting` conversation keys, `drained: true` once nothing is left); stop it then. A reload or restart while the file exists mounts without a socket and still resumes what the pending file carried. Delete the file to receive again (the drain file goes with it). A reply posted in a thread whose turn still runs on the old host reaches the new host, which answers it in a session of its own.

## Channel commands

Commands are plain messages with a verb prefix. **Prefer `!`**: Slack's own
client intercepts leading-`/` text as (unregistered) slash commands —
"*Only visible to you — /new is not a valid command*" — and it never reaches
the bot. A leading space (` /new`) also gets through; both spellings work.

| Command | Effect |
|---|---|
| !new (or /new) | dispose the channel's session and start a fresh one |
| !stop (or /stop) | cancel the running turn and clear the queue |
| !allow / !deny | decide the approval prompt this channel is waiting on (the buttons do the same) |
| !answer <text> | answer the pending question in your own words — the "Other" path for a question that has buttons |
| !id (or /id) | reply with the channel id (for `allowedChannelIds`) |
| !pair <token> (or /pair) | enroll this channel when `pairToken` is configured |
| !help, !start (or /…) | command summary |

Anything else goes to the agent as a user message. Messages posted while the agent is busy are queued per channel and drained in order (with a configurable ack). Replies post in-thread when `threadReplies` is on.

One exception: while a question prompt is waiting in the channel, a plain message **that is not one of the commands above** answers the oldest unanswered *free-form* question (one with no options to click). Questions that offer options are answered by their buttons, or with `!answer …` for a reply that is not on the list.

## Using Slack as a remote DSH interface

Every Slack conversation the bot is in gets its own independent DSH session. Three shapes:

| Shape | How | Best for |
|---|---|---|
| **DM the bot** | find it under **Apps** in your Slack sidebar | a private remote DSH terminal — no invite, no id discovery |
| **A dedicated channel** | `/invite @yourbot` | a shared workspace thread; everyone sees the agent's work |
| **Many channels** | `/invite @yourbot` in each | separating projects — each channel keeps its own session |

Slack never auto-joins bots to channels — `/invite` per channel (or just use the DM, which needs nothing). Serving *every* channel the bot is a member of without listing ids is `allowAllChannels: true` — weigh that against everyone in the workspace being able to drive the agent.

**Sections ↔ workspaces.** A Slack sidebar section is the natural image of a DSH
workspace: file one channel per project into a section named for it, and pin
each channel's workspace with `channelCwd` (falling back to `cwd`). Sections
are client-side organization — Slack ships no bot API to create or read them —
so the mapping is agreed on both ends: you group the channels in Slack, the
config pins each channel's workspace here. Every channel remains one
independent session (`/new` starts a fresh one) rooted in that workspace,
carrying the same route, permission preset, agent preset, and persistence as
the web interface.

**Route and fallback chain.** `provider`/`model` pin the primary route for every
channel session. `fallbacks` lists further routes, tried in order: when a model
request fails, the failed step is retried on the next route inside the same
turn, so the channel still gets an answer. Retryable failures (`RATE_LIMIT`,
`SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`) move on only after the
provider's own retry policy (llm-retry, 5 attempts by default) has given up;
the rest — `QUOTA` (which includes the DeepSeek API's HTTP 402 insufficient
balance), auth errors, an unknown model — move on at once. A stopped turn never
does. The rest of the turn stays on the route it reached, and every new turn
starts again on the primary route, so a route that recovers (a lifted rate
limit, a topped-up balance) is used again. With `fallbackCooldownMs` the
primary is also tried again inside the turn once that long has passed since
the last switch — a long turn no longer spends every remaining step on a
fallback after one short rate-limit burst; a primary that still fails walks the
chain again from its first route. Entries that repeat the primary or an
earlier entry are skipped. Each switch is logged as a warning (`model request
failed on … retrying this turn on … (fallback n/m)`).

```yaml
provider: nvidia
model: z-ai/glm-5.3
fallbacks:
  - { provider: nvidia, model: moonshotai/kimi-k2.6 }
  - { provider: nvidia, model: z-ai/glm-5.3-flash }
  - { provider: nvidia, model: deepseek-ai/deepseek-v4.1-flash }
  - { provider: opencode-go, model: deepseek-v4.1-flash }
  - { provider: deepseek-official, model: deepseek-flash }   # DeepSeek-V4.1-Flash-1017
```

llm-retry keeps one retry budget per provider and step, so after the primary
exhausted NVIDIA's retries, the next NVIDIA routes in the same step get one
attempt each for a retryable failure before the chain moves on; a later step
gets the full budget again. `fallbackOn: quota` restricts the chain to budget
failures (`QUOTA` / `ACCOUNT_QUOTA`). The older single-route form
`fallbackProvider` / `fallbackModel` (/ `fallbackReasoningEffort`) still works
as a one-entry chain.

## Full configuration reference

| Key | Default | Meaning |
|---|---|---|
| `botToken` | `SLACK_BOT_TOKEN` env | Bot token (`xoxb-`) for the Web API. |
| `appToken` | `SLACK_APP_TOKEN` env | App-level token (`xapp-`) for Socket Mode. |
| `apiBase` | `https://slack.com/api` | Web API base; point at a mock for tests. |
| `provider` / `model` | host default | Agent route for created sessions. |
| `fallbacks` | `[]` | Ordered fallback routes, each `{ provider, model, reasoningEffort? }`. After a failed model request the step is retried on the next route in the same turn; the next turn starts on the primary route again. See *Route and fallback chain*. |
| `fallbackOn` | `any` | Which failures move down the chain: `any` (every failure except a stopped turn; retryable ones after the provider's retries are spent) or `quota` (`QUOTA` / `ACCOUNT_QUOTA` only). |
| `fallbackCooldownMs` | `0` | Milliseconds on a fallback route before the primary is tried again within the same turn. `0` keeps the fallback until the turn ends. |
| `fallbackProvider` / `fallbackModel` / `fallbackReasoningEffort` | — | Single-route shorthand for a one-entry `fallbacks`; cannot be combined with `fallbacks`. |
| `cwd` | server cwd | Workspace root for created sessions (must be absolute). |
| `channelCwd` | — | Per-channel workspace override: `{ "C…": "/abs/path" }`. Lets a Slack sidebar section (channels grouped per project) agree with DSH workspaces. |
| `permissionPreset` | composition default | Named preset applied to each freshly created session — the same table the web UI's preset switcher offers (`workspace-write`, `danger-full-access`, …). Resumed sessions keep their existing knobs. |
| `agentPreset` | composition default (no preset) | Agent preset mounted into each channel session — the same composition table the web UI's preset switcher lists (`standard`, `minimal`, …). The preset is what supplies `bash`/`read`/`grep` and the rest of that preset's tools, prompt sections and skills; without it a channel session sees only the plugins the profile mounts globally (its MCP servers, the workspace dependency tools) and honestly reports that it cannot read repository files or CI. Mounted on resume too, so a session created before the setting existed gains the tools on its next resume. |
| `allowedChannelIds` | `[]` | Channel allowlist. Empty + `allowAllChannels: false` denies everything. |
| `allowAllChannels` | `false` | Explicitly serve every channel the bot is in. |
| `notifyUnauthorized` | `false` | Reply "not authorized" to rejected channels. |
| `stateFile` | — | JSON file persisting channel → session ids and /pair enrollments. Beside it, `<name>.pending.json` carries waiting messages and running turns across a plugin reload or host restart: teardown writes it, the next mount queues them again (a caught turn resumes with a channel note) and renames the file to `.pending.json.restored`. While `<name>.receive-off` exists the channel keeps no Slack socket and reports what is left in `<name>.drain.json` (handover, above). |
| `pairToken` | — | Enables the enrollment flow (requires `stateFile`). |
| `sessionScope` | `channel` | `channel`: one session per channel (threads share it). `thread`: one session per Slack thread — a top-level message opens a new session, replies in its thread continue it; queues, `!stop`, `!new`, prompts and unseen context stay inside the thread. |
| `replyMode` | `last` | `last`: final assistant message of a turn; `all`: join every assistant message. |
| `maxReplyChars` | `4000` | Split longer replies at line boundaries. |
| `threadReplies` | `true` | Reply in-thread under the originating message's thread root (a reply in a thread is answered in that same thread). |
| `ackReaction` | `hourglass` | Emoji reaction marking the message being worked on (empty string disables). |
| `mentionOnly` | `false` | Serve only messages that address the bot (or one of its commands). DMs are never gated. Messages that are gated become context, not silence — see below. |
| `maxBotTurns` | `10` | Backstop ceiling on app-driven turns in one conversation since the last human message (a human message resets it; `0` disables the ceiling). |
| `maxBotRepeats` | `3` | How many times the same normalized text (mentions stripped) may drive a turn in one conversation before it is dropped. This is the primary ping-pong brake; `0` disables it. |
| `maxConcurrentTurns` | `0` | How many channel turns may run at once across all conversations. A message that finds every slot taken waits in its conversation's queue (acked with `Queued: another conversation's turn is running`) and starts, oldest first, when a turn ends. A conversation holds at most one waiting entry: later messages to it (progress checks, re-requests) join that entry without a second ack — only the receipt reaction — and are answered together in one turn, so pinging a waiting thread never adds turns. `!stop` in a waiting thread drops its waiting messages. `0` means no limit. Turns the host starts itself (scheduled reminders, goal rounds) are not counted. |
| `mentionBackBots` | `false` | Mention the author back when the author is another app. Off by default: the automatic mention is what closes a two-agent loop. |
| `mentionUserIds` | `[]` | Slack user ids (`U…`) the agent's own text may turn into a real mention. Empty keeps every agent-written `<@U…>` as escaped text — see below. |
| `mentionRewrites` | `{}` | Map of Slack user id → user id. Every outbound mention of a key (agent text — escaped or not, with or without a label — and the automatic sender/CC prefix) is posted as a real mention of its value instead, so a retired id is never pinged even when the agent copies it from another bot's roster. |
| `slackSurface` | `true` | Tell every channel agent it is on Slack: its Web-GUI prompt slot is replaced by "your final reply is posted to this thread", its tool calls may not post to Slack themselves (Slack API writes, webhooks and pasted tokens are refused), and Slack tokens in tool results are shown as `xoxb-<redacted>`. Covers resumed sessions too. |
| `surfacePrompt` | — | Text appended to that Slack prompt, such as the team roster and house rules. |
| `ccUserIds` | `[]` | Slack user ids always added after the sender mention on the first reply chunk (for example an orchestrator). Built after mrkdwn conversion, so it does not need to be in `mentionUserIds`. |
| `contextMessages` | `20` | How many unseen messages a mention-driven turn carries as context (`0` disables the buffer, `200` is the cap). |
| `threadContextMessages` | `30` | `sessionScope: thread` only: when a reply in an existing thread creates that thread's session (the thread predates the switch to thread scope, or follows `!new` or a restart), its first turn carries up to this many of the thread's earlier messages — see *Thread history backfill* (`0` disables, `200` is the cap). |
| `interactiveTimeoutMs` | `1800000` (30 min) | How long a Slack approval/question prompt waits before it is settled without an answer (`0` waits until the turn is stopped, `86400000` is the cap). |
| `retryDelayMs` | `3000` | Backoff after Web API failures. |
| `socketRetryDelayMs` | `2000` | Backoff between Socket Mode reconnects. |
| `receivePollMs` | `5000` | How often the receive-off file is checked (handover). |

### Mentions in replies

Reply text is escaped: outside code spans every `<`, `>` and `&` becomes `&lt;`, `&gt;`, `&amp;`, so nothing the model writes can become a link (`<https://…|click>`) or ping someone by accident. That includes `<@U…>` — a mention the agent types in its own reply is posted as literal text unless the id is listed in `mentionUserIds`:

```yaml
mentionUserIds:
  - U0C7AN52QGN   # teammate agent
  - U0C6HEG8KC6   # teammate agent
```

Only those ids come back as real mentions; every other `<@U…>` — and every other angle-bracket form — stays escaped. The list is validated (empty entries, non-strings and `<@…>` wrappers are rejected at load) and de-duplicated.

Two mentions never need the allowlist:

- The first chunk of a reply is prefixed with a mention of the author of the message that drove the turn, whenever that message addressed the bot and the author is a human. An app's message gets no automatic mention back unless `mentionBackBots: true`; that prefix is added *after* escaping, so it always resolves.
- Code spans and fenced blocks are never escaped, but Slack renders mentions inside them as code — they stay text.

An empty `mentionUserIds` (the default) is the safe posture for a channel where the agent should never address anyone: only the automatic mention-back above reaches a human or another app.

### Mention gating and context

`mentionOnly: true` is the setting for a channel where several people (or several agents) talk and only some messages are meant for this bot. A message that does not address the bot drives no turn at all: no session is created, no reply is posted, no reaction is added. DMs are exempt — a message in a DM is always addressed to the bot.

Gated messages are not discarded. They are remembered per channel (the last `contextMessages` of them) and prepended to the next turn that *does* address the bot:

```
[channel context — 3 message(s) posted since your last reply, oldest first]
<@U0C7AN52QGN>: #2267 is closed, evidence attached
<@U123>: thanks — can you double-check it?
<@U0A1B2C3D4>: +1
[end of channel context]

<@U123> what do you think?
```

The block is consumed by that turn, so each unseen message is carried exactly once; the session then holds it as ordinary history. Attribution is the raw mention spelling (`<@U…>`) — the form the agent can address someone with in its reply, provided that id is in `mentionUserIds` (see *Mentions in replies*). Messages longer than 1500 characters are truncated inside the block, and a composition that gates nothing never allocates the buffer at all.

### Thread history backfill

With `sessionScope: thread` a thread's session normally starts with the thread itself, so it has seen everything. A reply can still land in a thread that has no session yet: the thread was started before the switch to thread scope, `!new` was posted in it, or the host restarted without a `stateFile` mapping (the mention-gating buffer above is in memory only). The first turn of such a session opens with the thread so far, fetched with `conversations.replies` (the `channels:history` / `groups:history` / `im:history` scopes the setup already grants):

```
[Thread context — prior messages in this thread (not yet in conversation history):]
[thread parent] <@U123>: can you look at the flaky deploy test?
[assistant] It times out waiting for the health check — see the log above.
<@U0A1B2C3D4>: the timeout is 30s, the check takes 45s on cold start
[End of thread context]

<@U123> so what should we change?
```

One line per message (newlines shown as `⏎`, 1500 characters at most), oldest first, the newest `threadContextMessages` kept with the thread's parent always on top. The triggering message is never part of the block, nor is anything the unseen-message block of the same turn already carries. Edits, joins and other traces are skipped. Later turns get no block — the session remembers from then on — and neither do top-level messages, a resumed session (it already holds its history) nor `sessionScope: channel`. Because `!new` is one of the triggers, a fresh session in an old thread re-reads that thread; start a new top-level thread for a clean slate, or set `threadContextMessages: 0`. A failed fetch (missing scope, network, timeout) is logged as a warning and the turn goes ahead without the block.

### Interactive prompts (approvals and questions)

A channel session is a real DSH session, so it can stop and ask — for a permission (**run this command that needs to leave the sandbox?**) or for input (`ask_user_question`). Without help those prompts only exist in a DSH client that has the session open, which a Slack-driven session usually does not: the turn stays open, the channel's busy flag stays set, and every later message queues with no answer ever coming. The plugin answers both seams for the sessions it owns:

- **Approval** — posted in the turn's thread with **Allow once** and **Deny** buttons, the tool name, the reason the tool gave, and **the call itself**: a command tool's command (with its working directory) or any other tool's arguments as JSON, in a code block. The click closes the request (`allowed-once` / `rejected`); `!allow` / `!deny` do the same from the keyboard.
- **`ask_user_question`** — posted with one button per option (per question, in a batch). A **multi-select** question toggles and commits with **Submit selection**. A free-form question — one with no options to click — is answered by a plain channel message; `!answer <text>` answers any question in your own words (the "Other" path).
- **Settled prompts are rewritten in place**: the buttons are removed and the message shows who decided and what. A click on an already-settled prompt does nothing.

The prompt is escaped exactly like a reply, so the tool's reason cannot smuggle a link or a `@channel` into the channel. The buttons carry an opaque prompt id, and a click from a channel that is not authorized is ignored.

DSH's approval request names the call only by id (`toolName`, `callId`, the model's `reason`), so the plugin remembers each call's arguments on `tools/pre-execute` (the latest 32 per channel agent) and shows the one the request names. The command is shown as written — `&`, `<`, `>` escaped, a ```` ``` ```` inside it broken so it cannot end the block — cut at 2000 rendered characters with a note saying how long it really is, and with secret-looking values masked before it reaches Slack (`src/redact.js`: known key shapes such as `xoxb-`, `ghp_`, `nvapi-`, `sk-`, JWTs; values of secret-named variables, JSON keys, flags and `Authorization` headers; `user:password@` in URLs; PEM private keys — best effort, references such as `$GH_TOKEN` stay readable). The settled message keeps the command, so the thread records what was allowed. A call the plugin did not see (one raised before a reload, say) is said so instead of left out.

**Nothing waits forever.** A prompt that nobody answers is settled at `interactiveTimeoutMs` (30 minutes by default): an approval fails closed (`unavailable` — the operation is *not* approved), a question returns a timeout error to the model, and either way the turn finishes and the channel takes work again. Set a smaller value to fail fast in unattended channels, or `0` to wait until you `!stop` the turn.

Other answerers in the composition are not bypassed: the prompt is also offered downstream (the DSH web UI, for example), whichever answers first wins, and a downstream answerer that declines to answer — no UI attached, or the session is not open there — leaves the channel in charge. A request from an agent this plugin does not own (a web session, another integration's agent) is delegated untouched; a *subagent* of a channel session is prompted in the channel it was delegated from, so a delegated approval cannot wedge the parent turn.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_auth` at connect | tokens swapped, or app token from the wrong page | `xapp-` = Socket Mode (App-Level Tokens), `xoxb-` = Web API (OAuth & Permissions); the plugin logs which one failed |
| `missing_scope` on Web API calls | bot scopes missing or added after install | add the scopes, then click **Reinstall to Workspace** |
| Connects, but posting a message does nothing | channel not in `allowedChannelIds` | the authorization gate runs before commands — add the channel id to the config, use `/pair`, or set `allowAllChannels: true` |
| Connects, but nothing at all arrives | event subscriptions missing | *Event Subscriptions* → `message.channels` / `message.groups` / `message.im`, Save |
| Reply lands but no ⏳ reaction | `reactions:write` scope missing | add the scopes, reinstall |
| Two replies per message | `app_mention` subscribed alongside `message.channels` | remove `app_mention` from the event subscriptions |
| A reply shows `&lt;@U…&gt;` instead of a mention | the id is not in `mentionUserIds`, so the mention stayed escaped | add the id (mentions the agent writes are escaped by design — see *Mentions in replies*) |
| Approval/question buttons do nothing | *Interactivity* is off for the Slack app | *Interactivity & Shortcuts* → **On** (no Request URL needed with Socket Mode); `!allow` / `!deny` / `!answer` work meanwhile |
| A prompt says *Expired* although nobody answered | `interactiveTimeoutMs` elapsed | answer sooner, raise the value, or set `0` to wait indefinitely |
| Socket Mode connects, then drops periodically | expected | Slack recycles connections; the plugin reconnects automatically with a fresh URL |

## Security

A bot token is a **credential**: whoever can post into a served channel can drive a full agent — with shell tools if the composition mounts them. The plugin denies every channel by default. Practical posture:

1. Post `/id` in the target channel; put the channel id in `allowedChannelIds`.
2. Prefer private channels/groups; in public channels every member can drive the agent.
3. Never set `allowAllChannels: true` on a bot installed workspace-wide.
4. Restrict the composition the channel mounts into — don't give the Slack-facing host approval-free shell access unless you accept the risk.
5. For enrollment without config edits, set `pairToken` (+ `stateFile`) and `/pair <token>` from the target channel. Enrollment is additive; remove ids from `state.json` to revoke.

`agentPreset` decides how much of that composition a channel session gets. Left unset, sessions inherit only the profile-scoped plugins (MCP servers, workspace dependency tools): the agent can read GitHub objects its token allows but cannot open repository files or run commands. Setting it to `standard` (or any preset whose children include `tool-bash`/`tool-fs`) hands the channel the same tool set the web UI has — including in-workspace writes and command execution. Approval questions reach the channel as buttons, so whoever can post in the channel can also approve them: keep `permissionPreset` (and the sandbox it selects) as the real limit on what the agent may do unattended, and treat the buttons as a speed bump rather than a boundary between people.

## Testing

```sh
node tests/run.mjs
```

104 tests, no network required: the suite drives the plugin's `apply` against a local mock Web API server and a scripted fake websocket — reply delivery (threaded), reaction acks, echo guard, queueing, /new, /stop, /pair enrollment persistence, unauthorized gating, teardown, Socket Mode ack/reconnect/abort behavior, interactive-prompt delivery and every way one settles (button, text command, downstream answerer, deadline, abort), config validation, mrkdwn escaping, chunk splitting, and the Web API client (error mapping, 429 Retry-After header).

There is also a live smoke test without an LLM: `node smoke.mjs` mounts the plugin with a stub echo agent against your real workspace (tokens from `.env.local`, gitignored) — post a message, get `echo: <text>` in-thread.

## Known limitations

- **Text only** — attachments, blocks, and mentions in the incoming message are ignored (only `text` is forwarded); replies are mrkdwn text.
- **Socket Mode only** — no Events API webhook mode; the plugin holds a websocket in-process.
- **No slash-command integration** — commands are plain chat text ("!new"); Slack's slash-command payloads are acked and ignored (Block Kit *button* clicks are handled).
- **One turn per session at a time** — concurrent messages queue (joined into one waiting entry per conversation); they are not steering. With `sessionScope: thread` the unit is the thread, so other threads are not held up — unless `maxConcurrentTurns` caps turns across threads.
- **Prompts are answered by whoever can post in the channel** — the buttons inherit the channel's trust model (anyone who can drive the agent can also approve its requests). Restrict the channel and the `permissionPreset` rather than relying on the prompt.
- **A prompt is one message** — a question batch with more options than Slack renders as buttons falls back to a compact `!answer <text>` prompt, and a prompt that Slack rejects (message too large, channel archived) fails closed immediately.
- **Agents can ping each other, within a budget** — messages from other apps are served, and the reply used to mention the app back, which could sustain a conversation between two agents. Defaults now bound that in layers: `mentionBackBots: false` (no automatic mention at an app), `maxBotRepeats: 3` (the fourth occurrence of the same normalized text in a conversation is dropped — the actual loop repeated verbatim), `maxBotTurns: 10` (a generous ceiling for varied bot chatter), and the existing `mentionOnly` gate. A human message resets both counters. The guard logs `bot loop guard: staying silent` when it trips. An agent's own mentions still reach Slack only for ids in `mentionUserIds`, so keep that list to the participants that should be addressable. Also note that a channel where the bot is present is served *whether or not* the bot is mentioned (`allowAllChannels`, or a listed channel): mention-back is not mention-gating.

## Files

```
package.json            zero-dependency plugin package (exports ./src/index.js)
cordis.patch.yml        ready-made --patch overlay with a hardened example config
smoke.mjs               live smoke test: echo agent on your real workspace (reads .env.local)
src/index.js            entry: name / inject / Config / apply — socket loop wiring, commands, reply path
src/schema.js           Standard Schema v1 config validator (inline, no deps)
src/slack.js            Web API client: call / openConnections / postMessage / updateMessage / reactions, splitMessage
src/socket.js           Socket Mode loop: fresh-URL reconnect, envelope acks, event + interactive routing
src/handover.js         receive-off and drain files (moving the bot to another host without stopping its turns)
src/interactions.js     Slack-side answering for approval/request and user-questions/request (buttons, deadline, the call's command)
src/redact.js           masking of secret-looking values in what an approval prompt shows
src/format.js           markdown → Slack mrkdwn (escaped angle brackets, allowlisted mentions restored, fences preserved)
src/message.js          frozen user-message factory (dsh-llm createUserMessage shape)
src/collector.js        per-turn reply collector (last/all)
src/sessions.js         per-channel agent manager (create/resume, state file, enrollments)
tests/                  104-test suite + mock Web API + fake websocket (node tests/run.mjs)
deploy/secrets.mjs      sealed secrets handoff (keygen / seal from ~/.dsh / open)
deploy/linux/           Linux server kit: setup.sh, check.mjs, log-stdout.mjs, templates/, test/ (container test)
docs/MUSE_HANDOFF.md    moving the bot to another machine by prompts (Japanese)
```
