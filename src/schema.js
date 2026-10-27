import { isAbsolute } from 'node:path'
import { invalidPatterns } from './command-policy.js'

// Config schema for dsh-slack-channel.
//
// Cordis calls `Config['~standard'].validate(config)` during plugin load
// (vendor/cordis/src/fiber.ts). We implement the Standard Schema v1 surface
// inline so the plugin keeps zero npm dependencies — same approach as
// dsh-a2a-plugin and the dsh-telegram-channel sibling.

const REPLY_MODES = ['last', 'all']

/** What one agent session spans: a whole channel, or one Slack thread. */
const SESSION_SCOPES = ['channel', 'thread']

/** Which failed model requests move a session to its next fallback route. */
const FALLBACK_TRIGGERS = ['any', 'quota']

/** Hard cap on the context block, whatever the config asks for. */
const CONTEXT_MESSAGES_MAX = 200

/**
 * Slack user ids that may be mentioned back at the channel (U… bots and
 * humans alike; W… legacy workspace users). Deliberately loose about case and
 * separators so fixtures and hand-written ids both validate — an entry that
 * does not match simply never turns into a mention.
 */
const SLACK_USER_ID = /^[UW][A-Za-z0-9_-]{1,}$/

const DEFAULTS = Object.freeze({
  apiBase: 'https://slack.com/api',
  allowedChannelIds: [],
  allowAllChannels: false,
  retryDelayMs: 3000,
  socketRetryDelayMs: 2000,
  receivePollMs: 5000,
  maxReplyChars: 4000,
  replyMode: 'last',
  sessionScope: 'channel',
  fallbackOn: 'any',
  fallbackCooldownMs: 0,
  threadReplies: true,
  ackReaction: 'hourglass',
  notifyUnauthorized: false,
  mentionOnly: false,
  mentionBackBots: false,
  mentionBackBotIds: [],
  maxBotTurns: 10,
  maxBotRepeats: 3,
  maxConcurrentTurns: 0,
  mentionUserIds: [],
  mentionRewrites: {},
  slackSurface: true,
  ccUserIds: [],
  contextMessages: 20,
  threadContextMessages: 30,
  interactiveTimeoutMs: 30 * 60 * 1000,
  autoAllowCommands: false,
  askCommands: [],
  denyCommands: [],
})

/** Hard cap on the interactive-prompt deadline (24h), whatever the config asks. */
const INTERACTIVE_TIMEOUT_MAX = 24 * 60 * 60 * 1000

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveNumber(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) return null // null = invalid
  return value
}

function validate(input) {
  if (input !== undefined && input !== null && !isPlainObject(input)) {
    return { issues: [{ message: 'config must be a non-array object' }] }
  }
  const src = input || {}
  const issues = []
  const cfg = {}

  // Slack needs TWO tokens: the bot token (xoxb-…, Web API — post messages,
  // reactions) and the app-level token (xapp-…, Socket Mode — the wss
  // connection). Environment fallbacks mirror the Telegram sibling.
  cfg.botToken = optionalString(src.botToken)
  if (cfg.botToken === null) issues.push({ message: 'botToken must be a non-empty string' })
  cfg.appToken = optionalString(src.appToken)
  if (cfg.appToken === null) issues.push({ message: 'appToken must be a non-empty string' })

  // apiBase — the official Web API by default; point at a mock for tests.
  cfg.apiBase = optionalString(src.apiBase) ?? DEFAULTS.apiBase
  if (!cfg.apiBase.startsWith('http://') && !cfg.apiBase.startsWith('https://')) {
    issues.push({ message: 'apiBase must be an http(s) URL' })
    cfg.apiBase = DEFAULTS.apiBase
  }

  // Agent route for the per-channel sessions the plugin creates.
  cfg.provider = optionalString(src.provider)
  if (cfg.provider === null) issues.push({ message: 'provider must be a non-empty string' })
  cfg.model = optionalString(src.model)
  if (cfg.model === null) issues.push({ message: 'model must be a non-empty string' })

  // Fallback chain: when the current route's model request fails, the agent
  // retries the failed step on the next route instead of ending the turn.
  // `fallbacks` lists the routes in order; the older single-route form
  // (fallbackProvider/fallbackModel/fallbackReasoningEffort) is a one-entry
  // chain. Leaving both unset keeps single-route behavior.
  cfg.fallbackProvider = optionalString(src.fallbackProvider)
  if (cfg.fallbackProvider === null) issues.push({ message: 'fallbackProvider must be a non-empty string' })
  cfg.fallbackModel = optionalString(src.fallbackModel)
  if (cfg.fallbackModel === null) issues.push({ message: 'fallbackModel must be a non-empty string' })
  if ((cfg.fallbackProvider === undefined) !== (cfg.fallbackModel === undefined)) {
    issues.push({ message: 'fallbackProvider and fallbackModel must be set together' })
  }
  cfg.fallbackReasoningEffort = optionalString(src.fallbackReasoningEffort)
  if (cfg.fallbackReasoningEffort === null) issues.push({ message: 'fallbackReasoningEffort must be a non-empty string' })
  cfg.fallbacks = []
  if (src.fallbacks !== undefined && src.fallbacks !== null) {
    if (!Array.isArray(src.fallbacks)) {
      issues.push({ message: 'fallbacks must be an array of { provider, model } routes' })
    } else {
      src.fallbacks.forEach((entry, index) => {
        const at = 'fallbacks[' + index + ']'
        if (!isPlainObject(entry)) {
          issues.push({ message: at + ' must be an object with provider and model' })
          return
        }
        const provider = optionalString(entry.provider)
        const model = optionalString(entry.model)
        const reasoningEffort = optionalString(entry.reasoningEffort)
        if (typeof provider !== 'string') issues.push({ message: at + '.provider must be a non-empty string' })
        if (typeof model !== 'string') issues.push({ message: at + '.model must be a non-empty string' })
        if (reasoningEffort === null) issues.push({ message: at + '.reasoningEffort must be a non-empty string' })
        if (typeof provider !== 'string' || typeof model !== 'string' || reasoningEffort === null) return
        cfg.fallbacks.push({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
      })
    }
    if (cfg.fallbackProvider !== undefined) {
      issues.push({ message: 'set either fallbacks or fallbackProvider/fallbackModel, not both' })
    }
  }
  if (cfg.fallbackProvider !== undefined && cfg.fallbackModel !== undefined && cfg.fallbacks.length === 0) {
    cfg.fallbacks.push({
      provider: cfg.fallbackProvider,
      model: cfg.fallbackModel,
      ...(cfg.fallbackReasoningEffort === undefined ? {} : { reasoningEffort: cfg.fallbackReasoningEffort }),
    })
  }

  // Which failures move a session down the chain: 'any' (every failed model
  // request except a stopped turn; RATE_LIMIT / SERVER / TIMEOUT … only once
  // the provider's own retry policy has given up) or 'quota' (QUOTA /
  // ACCOUNT_QUOTA only).
  cfg.fallbackOn = src.fallbackOn ?? DEFAULTS.fallbackOn
  if (!FALLBACK_TRIGGERS.includes(cfg.fallbackOn)) {
    issues.push({ message: 'fallbackOn must be one of: ' + FALLBACK_TRIGGERS.join(', ') })
    cfg.fallbackOn = DEFAULTS.fallbackOn
  }

  // Milliseconds on a fallback route before the primary is tried again within
  // the same turn. 0 (the default) keeps the fallback until the turn ends.
  cfg.fallbackCooldownMs = nonNegativeNumber(src.fallbackCooldownMs, DEFAULTS.fallbackCooldownMs)
  if (cfg.fallbackCooldownMs === undefined) {
    issues.push({ message: 'fallbackCooldownMs must be a non-negative number of milliseconds' })
    cfg.fallbackCooldownMs = DEFAULTS.fallbackCooldownMs
  }

  // Workspace cwd handed to every created agent; absolute because the agent
  // registry validates it as a workspace root.
  cfg.cwd = optionalString(src.cwd)
  if (cfg.cwd === null) {
    issues.push({ message: 'cwd must be a non-empty string' })
  } else if (cfg.cwd !== undefined && !isAbsolute(cfg.cwd)) {
    issues.push({ message: 'cwd must be an absolute path: ' + cfg.cwd })
    cfg.cwd = undefined
  }

  // Permission preset pinned onto every freshly created channel session —
  // the same named table the web UI's preset switcher offers (e.g.
  // workspace-write, danger-full-access). Unset keeps the composition
  // defaults for new sessions.
  cfg.permissionPreset = optionalString(src.permissionPreset)
  if (cfg.permissionPreset === null) issues.push({ message: 'permissionPreset must be a non-empty string' })

  // Agent preset mounted into every channel session (fresh and resumed) — the
  // same composition table the web UI's preset switcher lists (e.g. standard,
  // minimal). The preset, not the profile, is what supplies bash/read/grep and
  // the other preset tools, so an unset value leaves a channel session with
  // profile-scoped tools only.
  cfg.agentPreset = optionalString(src.agentPreset)
  if (cfg.agentPreset === null) issues.push({ message: 'agentPreset must be a non-empty string' })

  // Per-channel workspace overrides: channel id → absolute workspace root.
  // Lets a Slack sidebar section (channels grouped per project) agree with
  // DSH: every channel in one section works in that section's workspace.
  // Slack exposes no bot API for sections, so the grouping lives on the
  // human side and this map carries the machine side.
  cfg.channelCwd = {}
  if (src.channelCwd !== undefined && src.channelCwd !== null) {
    if (typeof src.channelCwd !== 'object' || Array.isArray(src.channelCwd)) {
      issues.push({ message: 'channelCwd must be an object mapping channel ids to absolute paths' })
    } else {
      for (const [id, value] of Object.entries(src.channelCwd)) {
        if (typeof id !== 'string' || id.length === 0 || typeof value !== 'string' || !isAbsolute(value)) {
          issues.push({ message: 'channelCwd[' + JSON.stringify(id) + '] must map to an absolute path' })
          continue
        }
        cfg.channelCwd[id] = value
      }
    }
  }

  // Channel authorization. An empty list with allowAllChannels=false (the
  // default) denies every channel: a bot token is a credential and whoever
  // can post into a served channel can drive a full agent with shell tools.
  cfg.allowedChannelIds = src.allowedChannelIds ?? DEFAULTS.allowedChannelIds
  if (!Array.isArray(cfg.allowedChannelIds)) {
    issues.push({ message: 'allowedChannelIds must be an array of channel ids (strings)' })
    cfg.allowedChannelIds = []
  } else {
    cfg.allowedChannelIds = cfg.allowedChannelIds.map((id) => {
      if (typeof id !== 'string' || id.length === 0) {
        issues.push({ message: 'allowedChannelIds entries must be non-empty strings, got ' + JSON.stringify(id) })
        return ''
      }
      return id
    })
  }
  cfg.allowAllChannels = !!src.allowAllChannels || DEFAULTS.allowAllChannels
  cfg.notifyUnauthorized = !!src.notifyUnauthorized || DEFAULTS.notifyUnauthorized

  // Backoff.
  cfg.retryDelayMs = nonNegativeNumber(src.retryDelayMs, DEFAULTS.retryDelayMs)
  if (cfg.retryDelayMs === undefined) {
    issues.push({ message: 'retryDelayMs must be a non-negative number' })
    cfg.retryDelayMs = DEFAULTS.retryDelayMs
  }
  cfg.socketRetryDelayMs = nonNegativeNumber(src.socketRetryDelayMs, DEFAULTS.socketRetryDelayMs)
  if (cfg.socketRetryDelayMs === undefined) {
    issues.push({ message: 'socketRetryDelayMs must be a non-negative number' })
    cfg.socketRetryDelayMs = DEFAULTS.socketRetryDelayMs
  }
  cfg.receivePollMs = nonNegativeNumber(src.receivePollMs, DEFAULTS.receivePollMs)
  if (cfg.receivePollMs === undefined || cfg.receivePollMs < 10) {
    issues.push({ message: 'receivePollMs must be a number of at least 10' })
    cfg.receivePollMs = DEFAULTS.receivePollMs
  }

  // Replies.
  cfg.maxReplyChars = positiveNumber(src.maxReplyChars, DEFAULTS.maxReplyChars)
  if (cfg.maxReplyChars === undefined || cfg.maxReplyChars > 40000) {
    issues.push({ message: 'maxReplyChars must be a number in (0, 40000]' })
    cfg.maxReplyChars = DEFAULTS.maxReplyChars
  }
  cfg.replyMode = REPLY_MODES.includes(src.replyMode) ? src.replyMode : DEFAULTS.replyMode
  if (src.replyMode !== undefined && !REPLY_MODES.includes(src.replyMode)) {
    issues.push({ message: 'replyMode must be one of ' + REPLY_MODES.join('|') })
  }

  // Session scope: 'channel' keeps one session per channel (threads share
  // it); 'thread' gives every Slack thread its own session — a top-level
  // message opens a new one, replies in its thread continue it.
  cfg.sessionScope = SESSION_SCOPES.includes(src.sessionScope) ? src.sessionScope : DEFAULTS.sessionScope
  if (src.sessionScope !== undefined && !SESSION_SCOPES.includes(src.sessionScope)) {
    issues.push({ message: 'sessionScope must be one of ' + SESSION_SCOPES.join('|') })
  }

  // UX toggles.
  cfg.threadReplies = src.threadReplies === undefined ? DEFAULTS.threadReplies : !!src.threadReplies
  cfg.ackReaction = optionalString(src.ackReaction) ?? DEFAULTS.ackReaction

  // Mention gating: when true a channel message drives a turn only if it
  // addresses the bot (or is one of our commands). DMs are always addressed
  // to the bot and are never gated. Messages that are gated are remembered
  // and attached to the next turn that does address the bot, so the agent
  // still sees the conversation it was not asked to answer.
  cfg.mentionOnly = src.mentionOnly === undefined ? DEFAULTS.mentionOnly : !!src.mentionOnly

  // Bot-to-bot loop budget: how many messages from OTHER apps in a row may
  // drive a turn in one conversation before the bot stays silent. Two agents
  // that mention each other otherwise answer each other forever; a human
  // message resets the budget. 0 disables the guard.
  cfg.maxBotTurns = nonNegativeNumber(src.maxBotTurns, DEFAULTS.maxBotTurns)
  if (cfg.maxBotTurns === undefined || !Number.isInteger(cfg.maxBotTurns)) {
    issues.push({ message: 'maxBotTurns must be a non-negative integer (0 disables the ceiling)' })
    cfg.maxBotTurns = DEFAULTS.maxBotTurns
  }
  cfg.maxBotRepeats = nonNegativeNumber(src.maxBotRepeats, DEFAULTS.maxBotRepeats)
  if (cfg.maxBotRepeats === undefined || !Number.isInteger(cfg.maxBotRepeats)) {
    issues.push({ message: 'maxBotRepeats must be a non-negative integer (0 disables repetition detection)' })
    cfg.maxBotRepeats = DEFAULTS.maxBotRepeats
  }

  // How many channel turns may run at once across every conversation; later
  // messages wait in their conversation's queue and start oldest first. 0
  // (the default) leaves conversations independent.
  cfg.maxConcurrentTurns = nonNegativeNumber(src.maxConcurrentTurns, DEFAULTS.maxConcurrentTurns)
  if (cfg.maxConcurrentTurns === undefined || !Number.isInteger(cfg.maxConcurrentTurns)) {
    issues.push({ message: 'maxConcurrentTurns must be a non-negative integer (0 means no limit)' })
    cfg.maxConcurrentTurns = DEFAULTS.maxConcurrentTurns
  }

  // Mention the author back when the author is another app. Off by default:
  // the automatic mention is what turns two replying agents into a loop.
  cfg.mentionBackBots = src.mentionBackBots === undefined ? DEFAULTS.mentionBackBots : !!src.mentionBackBots

  // Apps mentioned back even while mentionBackBots is off (e.g. the Muse
  // orchestrator, whose instructions expect a pinged answer).
  const backIds = src.mentionBackBotIds ?? DEFAULTS.mentionBackBotIds
  if (!Array.isArray(backIds)) {
    issues.push({ message: 'mentionBackBotIds must be an array of Slack user ids (strings)' })
    cfg.mentionBackBotIds = []
  } else {
    const ids = []
    for (const id of backIds) {
      if (typeof id !== 'string' || !SLACK_USER_ID.test(id)) {
        issues.push({ message: 'mentionBackBotIds entries must be Slack user ids like U0123ABCD, got ' + JSON.stringify(id) })
        continue
      }
      if (!ids.includes(id)) ids.push(id)
    }
    cfg.mentionBackBotIds = ids
  }

  // Mention allowlist: the only ids the agent's own text may turn into a real
  // Slack mention. The formatter escapes < > & outside code spans so model
  // output cannot ping anyone by accident; ids listed here are restored after
  // escaping. Empty (the default) keeps every agent-typed mention as text.
  const mentionIds = src.mentionUserIds ?? DEFAULTS.mentionUserIds
  if (!Array.isArray(mentionIds)) {
    issues.push({ message: 'mentionUserIds must be an array of Slack user ids (strings)' })
    cfg.mentionUserIds = []
  } else {
    const ids = []
    for (const id of mentionIds) {
      if (typeof id !== 'string' || !SLACK_USER_ID.test(id)) {
        issues.push({ message: 'mentionUserIds entries must be Slack user ids like U0123ABCD, got ' + JSON.stringify(id) })
        continue
      }
      if (!ids.includes(id)) ids.push(id)
    }
    cfg.mentionUserIds = ids
  }

  // Mention redirects (old id → successor id) applied to every outbound post,
  // agent text and the automatic sender/CC prefix alike. Empty by default.
  const rewrites = src.mentionRewrites ?? DEFAULTS.mentionRewrites
  if (!isPlainObject(rewrites)) {
    issues.push({ message: 'mentionRewrites must be a map of Slack user id to Slack user id' })
    cfg.mentionRewrites = {}
  } else {
    const map = {}
    for (const [from, to] of Object.entries(rewrites)) {
      if (!SLACK_USER_ID.test(from) || typeof to !== 'string' || !SLACK_USER_ID.test(to)) {
        issues.push({ message: 'mentionRewrites entries must map a Slack user id to a Slack user id, got ' + JSON.stringify(from) + ' → ' + JSON.stringify(to) })
        continue
      }
      map[from] = to
    }
    cfg.mentionRewrites = map
  }

  // Tell channel agents they are on Slack (their reply is posted for them) and
  // refuse Slack API writes / pasted tokens in their tool calls; see surface.js.
  // On by default: without it the agent believes it talks to the Web GUI.
  cfg.slackSurface = src.slackSurface === undefined ? DEFAULTS.slackSurface : !!src.slackSurface
  // Deployment text appended to that Slack prompt (team roster, house rules).
  cfg.surfacePrompt = optionalString(src.surfacePrompt)
  if (cfg.surfacePrompt === null) issues.push({ message: 'surfacePrompt must be a non-empty string' })

  // CC ids appended to the first reply chunk after the sender mention. Empty by
  // default (the wagyu CC was dropped on 2026-10-23).
  const ccIds = src.ccUserIds ?? DEFAULTS.ccUserIds
  if (!Array.isArray(ccIds)) {
    issues.push({ message: 'ccUserIds must be an array of Slack user ids (strings)' })
    cfg.ccUserIds = []
  } else {
    const ids = []
    for (const id of ccIds) {
      if (typeof id !== 'string' || !SLACK_USER_ID.test(id)) {
        issues.push({ message: 'ccUserIds entries must be Slack user ids like U0123ABCD, got ' + JSON.stringify(id) })
        continue
      }
      if (!ids.includes(id)) ids.push(id)
    }
    cfg.ccUserIds = ids
  }

  cfg.contextMessages = nonNegativeNumber(src.contextMessages, DEFAULTS.contextMessages)
  if (cfg.contextMessages === undefined || cfg.contextMessages > CONTEXT_MESSAGES_MAX) {
    issues.push({ message: 'contextMessages must be a number in [0, ' + CONTEXT_MESSAGES_MAX + ']' })
    cfg.contextMessages = DEFAULTS.contextMessages
  }

  // Thread backfill (sessionScope 'thread'): when a reply in an existing
  // thread creates the thread's session, its first turn carries up to this
  // many of the thread's earlier messages. 0 disables the backfill.
  cfg.threadContextMessages = nonNegativeNumber(src.threadContextMessages, DEFAULTS.threadContextMessages)
  if (cfg.threadContextMessages === undefined || !Number.isInteger(cfg.threadContextMessages) || cfg.threadContextMessages > CONTEXT_MESSAGES_MAX) {
    issues.push({ message: 'threadContextMessages must be an integer in [0, ' + CONTEXT_MESSAGES_MAX + ']' })
    cfg.threadContextMessages = DEFAULTS.threadContextMessages
  }

  // How long an interactive prompt (an approval, or an ask_user_question call)
  // waits in the channel before it fails closed. 0 waits forever — the prompt
  // then ends only when the turn is stopped. The config is what keeps a
  // channel from being blocked by a prompt nobody is watching.
  cfg.interactiveTimeoutMs = nonNegativeNumber(src.interactiveTimeoutMs, DEFAULTS.interactiveTimeoutMs)
  if (cfg.interactiveTimeoutMs === undefined || cfg.interactiveTimeoutMs > INTERACTIVE_TIMEOUT_MAX) {
    issues.push({ message: 'interactiveTimeoutMs must be a number in [0, ' + INTERACTIVE_TIMEOUT_MAX + '] (0 waits forever)' })
    cfg.interactiveTimeoutMs = DEFAULTS.interactiveTimeoutMs
  }

  // Answer approvals for commands by rule instead of asking every time: a
  // command matching denyCommands is rejected, one matching askCommands gets
  // the Slack prompt, anything else is allowed once at once. The lists are
  // regular expressions added to the built-in ones (src/command-policy.js).
  // Off by default: every approval is a prompt.
  cfg.autoAllowCommands = src.autoAllowCommands === undefined ? DEFAULTS.autoAllowCommands : src.autoAllowCommands === true
  if (src.autoAllowCommands !== undefined && typeof src.autoAllowCommands !== 'boolean') {
    issues.push({ message: 'autoAllowCommands must be true or false' })
  }
  for (const key of ['askCommands', 'denyCommands']) {
    const list = src[key] ?? DEFAULTS[key]
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      issues.push({ message: key + ' must be an array of regular expressions (non-empty strings)' })
      cfg[key] = []
      continue
    }
    for (const bad of invalidPatterns(list)) issues.push({ message: key + ': invalid regular expression ' + bad })
    cfg[key] = [...list]
  }

  // Optional channel→session persistence so restarts resume conversations,
  // and the state file carries /pair enrollments.
  cfg.stateFile = optionalString(src.stateFile)
  if (cfg.stateFile === null) issues.push({ message: 'stateFile must be a non-empty path string' })

  // Pairing flow: when set, "/pair <token>" from any channel enrolls it.
  cfg.pairToken = optionalString(src.pairToken)
  if (cfg.pairToken === null) issues.push({ message: 'pairToken must be a non-empty string' })
  if (cfg.pairToken !== undefined && cfg.stateFile === undefined) {
    issues.push({ message: 'pairToken requires stateFile so enrollments survive restarts' })
  }

  // Runtime-only websocket factory override (tests inject a scripted fake);
  // production resolves globalThis.WebSocket. Same posture as the ACP
  // bridge's runtime-only stream override.
  cfg.wsFactory = typeof src.wsFactory === 'function' ? src.wsFactory : undefined

  return issues.length ? { issues } : { value: cfg }
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-slack-channel',
    validate,
  },
}
