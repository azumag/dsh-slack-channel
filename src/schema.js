import { isAbsolute } from 'node:path'

// Config schema for dsh-slack-channel.
//
// Cordis calls `Config['~standard'].validate(config)` during plugin load
// (vendor/cordis/src/fiber.ts). We implement the Standard Schema v1 surface
// inline so the plugin keeps zero npm dependencies — same approach as
// dsh-a2a-plugin and the dsh-telegram-channel sibling.

const REPLY_MODES = ['last', 'all']

/** Hard cap on the context block, whatever the config asks for. */
const CONTEXT_MESSAGES_MAX = 200

const DEFAULTS = Object.freeze({
  apiBase: 'https://slack.com/api',
  allowedChannelIds: [],
  allowAllChannels: false,
  retryDelayMs: 3000,
  socketRetryDelayMs: 2000,
  maxReplyChars: 4000,
  replyMode: 'last',
  threadReplies: true,
  ackReaction: 'hourglass',
  notifyUnauthorized: false,
  mentionOnly: false,
  contextMessages: 20,
})

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

  // UX toggles.
  cfg.threadReplies = src.threadReplies === undefined ? DEFAULTS.threadReplies : !!src.threadReplies
  cfg.ackReaction = optionalString(src.ackReaction) ?? DEFAULTS.ackReaction

  // Mention gating: when true a channel message drives a turn only if it
  // addresses the bot (or is one of our commands). DMs are always addressed
  // to the bot and are never gated. Messages that are gated are remembered
  // and attached to the next turn that does address the bot, so the agent
  // still sees the conversation it was not asked to answer.
  cfg.mentionOnly = src.mentionOnly === undefined ? DEFAULTS.mentionOnly : !!src.mentionOnly
  cfg.contextMessages = nonNegativeNumber(src.contextMessages, DEFAULTS.contextMessages)
  if (cfg.contextMessages === undefined || cfg.contextMessages > CONTEXT_MESSAGES_MAX) {
    issues.push({ message: 'contextMessages must be a number in [0, ' + CONTEXT_MESSAGES_MAX + ']' })
    cfg.contextMessages = DEFAULTS.contextMessages
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
