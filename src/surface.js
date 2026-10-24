// What a channel session's agent is told about Slack, and what it may not do
// there. Without this the agent only hears the harness's Web GUI prompt: on
// 2026-10-23 a thread session took its replies for a report to a GUI
// operator, read this plugin's bot token out of cordis.patch.yml and posted
// with curl/python on its own (~34 posts, real mentions the formatter would
// have escaped, the token pasted into every command and so into the session
// log). One session even posted as Hermes with ~/.hermes/.env's token.
//
// Three agent-scoped registrations close that path: the Web-surface prompt
// slot (and its runtime context) is shadowed with the Slack facts, a tool
// guard refuses Slack write calls and pasted tokens, and tool results are
// scrubbed of tokens so the model never holds one to paste.

/** The harness's Web GUI prompt slot (dsh-harness-dev-context); a same-named scoped section shadows it. */
export const SURFACE_SECTION = 'app:web-surface'

/** First-party order of that slot (dsh-system-prompt SECTION_ORDERS.WEB_SURFACE / CONTEXT_ORDERS.WEB_SURFACE). */
const SURFACE_SECTION_ORDER = 10100
const SURFACE_CONTEXT_ORDER = 210

/** Slack tokens: bot/user/config (xox?-) and app-level (xapp-). Short masked forms like "xoxb-…" do not match. */
const TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{8,}|\bxapp-\d+-[A-Za-z0-9-]{8,}/g

/** Anything that talks to the Slack Web API, an SDK, or an incoming webhook. */
const SLACK_API = /slack\.com\/api|slack_sdk|slack_bolt|@slack\/(?:web-api|bolt)/i
const WEBHOOK = /hooks\.slack\.com\//i

/** Web API methods that change what the workspace shows (dotted or SDK snake spelling). */
const WRITE_METHOD = new RegExp('\\b(?:'
  + 'chat[._](?:postMessage|postEphemeral|update|delete|scheduleMessage|meMessage)'
  + '|reactions[._](?:add|remove)'
  + '|files[._](?:upload\\w*|getUploadURLExternal|completeUploadExternal|delete|share\\w*)'
  + '|pins[._](?:add|remove)'
  + '|bookmarks[._](?:add|edit|remove)'
  + '|conversations[._](?:create|invite\\w*|kick|archive|unarchive|join|leave|rename|setPurpose|setTopic|mark)'
  + ')\\b')

/** Tools that run code or fetch URLs; a write method named in them is a post. */
function runsCode(name) {
  return typeof name === 'string' && /bash|shell|terminal|run_code|web_fetch|pwsh/.test(name)
}

/** Every string inside a tool's (frozen JSON) arguments. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) strings(item, out)
  return out
}

/**
 * Why a channel agent may not run this tool call, or undefined to let it run.
 * A pasted token is refused in any tool (it would also land in the session
 * log); a Slack write or webhook is refused in tools that run code or fetch.
 * Reads keep working when the token is not pasted.
 * @param exec - the tool execution (`name`, parsed `arguments`).
 */
export function slackBypassReason(exec) {
  const text = strings(exec?.arguments).join('\n')
  if (text.search(TOKEN) >= 0) {
    return 'a Slack token must not appear in a tool call. Your final reply is posted to the Slack thread for you; '
      + 'never read, print or use a Slack token (yours or another bot\'s).'
  }
  if (runsCode(exec?.name) && (WEBHOOK.test(text) || (SLACK_API.test(text) && WRITE_METHOD.test(text)))) {
    return 'posting to Slack yourself is blocked in a Slack channel session. Your final reply of this turn is posted '
      + 'to the thread automatically — put what the thread needs there, and write mentions as <@USER_ID>.'
  }
  return undefined
}

/** Replace every Slack token in `text`; unchanged text is returned as is. */
export function redactTokens(text) {
  if (typeof text !== 'string') return text
  return text.replace(TOKEN, (token) => token.slice(0, token.indexOf('-') + 1) + '<redacted>')
}

/** Redact the text parts of tool content; the same array when nothing changed. */
function redactContent(content) {
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map((part) => {
    if (part?.type !== 'text' || typeof part.text !== 'string') return part
    const text = redactTokens(part.text)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? out : content
}

/**
 * The prompt that replaces the Web GUI slot for a channel agent.
 * @param options.selfUserId - this bot's Slack user id, once auth.test answered.
 * @param options.mentionUserIds - ids the formatter turns into real mentions.
 * @param options.extra - deployment text appended (team roster, house rules).
 */
export function surfacePrompt({ selfUserId, mentionUserIds = [], extra } = {}) {
  const others = mentionUserIds.filter((id) => id !== selfUserId)
  const lines = [
    'This session is not a DeepSeek Harness Web GUI session. You are talking through Slack: you are the Slack bot of '
      + 'this harness' + (selfUserId === undefined ? '' : ' (<@' + selfUserId + '>)') + ', and every message you receive '
      + 'came from a Slack channel or thread through the dsh-slack-channel plugin.',
    '- Your final reply of each turn is posted to that same thread automatically, as one message. Write it for the '
      + 'people and bots in the thread, in the language they use, not as a report to an operator, and put everything '
      + 'the thread needs into it.',
    '- Never call the Slack Web API yourself (no curl, scripts, SDKs or web_fetch to slack.com), never read, print or '
      + 'use a Slack token — yours or another bot\'s — and never post as another bot. Such tool calls are refused.',
    others.length > 0
      ? '- To mention someone write <@USER_ID>. Only these ids become real mentions: '
        + others.map((id) => '<@' + id + '>').join(' ') + '. Any other <@…> is posted as plain text.'
      : '- Mentions you write are posted as plain text; the plugin mentions the sender of the message you answer.',
  ]
  if (typeof extra === 'string' && extra.trim().length > 0) lines.push(extra.trim())
  return lines.join('\n')
}

/**
 * Install the Slack surface on one channel agent: the prompt slot, the tool
 * guard, and token redaction of tool results. Every registration goes
 * through `agentCtx`, so it applies to that agent alone and is disposed with
 * it. A missing service only warns: the channel still answers.
 * @param agentCtx - the agent's scoped context, supplied by `setup`.
 * @param options.config - validated plugin config.
 * @param options.selfUserId - getter for this bot's user id (undefined until auth.test answers).
 * @param options.logger - named plugin logger.
 */
export function installSlackSurface(agentCtx, { config, selfUserId = () => undefined, logger }) {
  const systemPrompt = agentCtx.get?.('systemPrompt')
  if (systemPrompt === undefined) {
    logger.warn('no systemPrompt service on the channel agent; it keeps the Web GUI prompt')
  } else {
    const ids = [...new Set([...(config.mentionUserIds ?? []), ...Object.values(config.mentionRewrites ?? {})])]
    systemPrompt.section({
      name: SURFACE_SECTION,
      order: SURFACE_SECTION_ORDER,
      interpolate: false,
      text: () => surfacePrompt({ selfUserId: selfUserId(), mentionUserIds: ids, extra: config.surfacePrompt }),
    })
    systemPrompt.context({
      name: SURFACE_SECTION,
      order: SURFACE_CONTEXT_ORDER,
      interpolate: false,
      text: 'Current surface: a Slack thread. Your final reply is posted there by the dsh-slack-channel plugin.',
    })
  }

  const tools = agentCtx.get?.('tools')
  if (tools === undefined) logger.warn('no tools service on the channel agent; Slack API calls are not guarded')
  else tools.guard(slackBypassReason)

  // Prepended, so this listener is the outermost: it redacts whatever content
  // every other post-execute policy settled on, not an intermediate draft.
  agentCtx.on('tools/post-execute', async (_exec, result, next) => {
    const decision = await next()
    if (decision?.kind === 'block') {
      const feedback = redactContent(decision.feedback)
      return feedback === decision.feedback ? decision : { ...decision, feedback }
    }
    // An accept that replaces the value cannot also replace content.
    if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const content = decision.content ?? result?.content
    const redacted = redactContent(content)
    return redacted === content ? decision : { ...decision, content: redacted }
  }, { prepend: true })
}
