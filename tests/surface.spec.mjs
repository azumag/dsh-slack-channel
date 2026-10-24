// Slack surface tests: the prompt slot, the Slack-API guard and token redaction.

import { test, assert, equal } from './_util.mjs'
import { installSlackSurface, redactTokens, slackBypassReason, surfacePrompt, SURFACE_SECTION } from '../src/surface.js'

// Shaped like real tokens, never real ones; built at run time so secret scanners do not flag them.
const BOT_TOKEN = ['xoxb', '1'.repeat(12), '2'.repeat(12), 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')
const APP_TOKEN = ['xapp', '1', 'A0FAKEFAKE1', '3'.repeat(12), '0123456789abcdef'.repeat(2)].join('-')

const bash = (command) => ({ name: 'bash', arguments: { description: 'x', command } })

test('the 2026-10-23 bypass shapes are refused', () => {
  // curl with the token taken from a variable: no literal, still a post.
  assert(slackBypassReason(bash('curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $TOK" -d @/tmp/m.json')) !== undefined, 'curl post')
  // The python heredoc that built the URL from parts and read the token from the plugin config.
  const heredoc = "python3 - <<'EOF'\nimport re,urllib.request\ntok=re.search(r'botToken:\\s*(\\S+)',open('/Users/azumag/.dsh/cordis.patch.yml').read()).group(1)\n"
    + "def api(m,**p):\n  return urllib.request.urlopen(urllib.request.Request('https://slack.com/api/'+m,data=b''))\napi('chat.postMessage',channel='C1',text='hi')\nEOF"
  assert(slackBypassReason(bash(heredoc)) !== undefined, 'python post')
  assert(slackBypassReason(bash("python3 -c \"from slack_sdk import WebClient; WebClient(token=t).chat_postMessage(channel='C1', text='x')\"")) !== undefined, 'sdk post')
  assert(slackBypassReason({ name: 'web_fetch', arguments: { url: 'https://hooks.slack.com/services/T0/B0/xyz' } }) !== undefined, 'webhook')
  assert(slackBypassReason(bash('curl https://slack.com/api/reactions.add -d name=eyes')) !== undefined, 'reaction')
})

test('a pasted token is refused in any tool, a masked one is not', () => {
  assert(slackBypassReason(bash('TOK="' + BOT_TOKEN + '"; curl https://slack.com/api/auth.test -H "Authorization: Bearer $TOK"')) !== undefined, 'bot token')
  assert(slackBypassReason({ name: 'write', arguments: { path: '/tmp/a.env', content: 'SLACK_APP_TOKEN=' + APP_TOKEN } }) !== undefined, 'app token in a file write')
  equal(slackBypassReason(bash('echo "Bot User OAuth Token (xoxb-…)"')), undefined, 'a masked example')
})

test('reading, grepping and editing Slack code still run', () => {
  equal(slackBypassReason(bash("grep -rn 'chat.postMessage' ~/work/pitag-fix/cline-slack-hook.py")), undefined, 'grep for a method name')
  const read = "python3 - <<'EOF'\nimport json,re,urllib.request\ntok=re.search(r'botToken:\\s*(\\S+)',open('/Users/azumag/.dsh/cordis.patch.yml').read()).group(1)\n"
    + "r=urllib.request.Request('https://slack.com/api/conversations.replies?channel=C1&ts=1.2',headers={'Authorization':'Bearer '+tok})\nEOF"
  equal(slackBypassReason(bash(read)), undefined, 'a thread read without a pasted token')
  equal(slackBypassReason({ name: 'edit', arguments: { path: 'hook.py', old: 'a', new: "requests.post('https://slack.com/api/chat.postMessage')" } }), undefined, 'editing a bot\'s code')
  equal(slackBypassReason(bash('gh pr view 1902 --json state')), undefined, 'unrelated command')
  equal(slackBypassReason(undefined), undefined, 'no exec')
})

test('redactTokens masks bot and app tokens only', () => {
  equal(redactTokens('botToken: ' + BOT_TOKEN + '\nappToken: ' + APP_TOKEN), 'botToken: xoxb-<redacted>\nappToken: xapp-<redacted>')
  equal(redactTokens('no secrets, xoxb-… only'), 'no secrets, xoxb-… only')
  equal(redactTokens(undefined), undefined)
})

test('surfacePrompt names the bot, the auto-post and the mentionable ids', () => {
  const text = surfacePrompt({ selfUserId: 'U0SELF', mentionUserIds: ['U0SELF', 'U0HERMES'], extra: '  Team: Hermes <@U0HERMES>.  ' })
  assert(text.includes('not a DeepSeek Harness Web GUI session'), 'cancels the Web GUI framing')
  assert(text.includes('(<@U0SELF>)'), 'own id')
  assert(text.includes('posted to that same thread automatically'), 'auto-post')
  assert(text.includes('Only these ids become real mentions: <@U0HERMES>.'), 'mentionable ids without itself')
  assert(text.endsWith('Team: Hermes <@U0HERMES>.'), 'deployment text appended, trimmed')
  assert(surfacePrompt({}).includes('posted as plain text'), 'no allowlist')
})

/** Fake agent context: services by name plus recorded listeners. */
function makeAgentCtx({ services = true } = {}) {
  const sections = []
  const contexts = []
  const guards = []
  const listeners = {}
  const registry = services
    ? { systemPrompt: { section: (s) => sections.push(s), context: (c) => contexts.push(c) }, tools: { guard: (g) => guards.push(g) } }
    : {}
  return {
    sections, contexts, guards, listeners,
    get: (name) => registry[name],
    on(event, fn, options) { (listeners[event] ??= []).push(fn); (listeners[event + ':options'] ??= []).push(options) },
  }
}

function makeLogger() {
  const lines = []
  return { lines, info: () => {}, warn: (m) => lines.push(m), error: () => {} }
}

test('installSlackSurface shadows the Web slot and guards the agent', () => {
  const agentCtx = makeAgentCtx()
  let self
  installSlackSurface(agentCtx, {
    config: { mentionUserIds: ['U0HERMES'], mentionRewrites: { U0OLD: 'U0MUSE' }, surfacePrompt: 'Team roster.' },
    selfUserId: () => self,
    logger: makeLogger(),
  })
  equal(agentCtx.sections.length, 1)
  const section = agentCtx.sections[0]
  equal([section.name, section.order, section.interpolate], [SURFACE_SECTION, 10100, false])
  equal([agentCtx.contexts[0].name, agentCtx.contexts[0].order], [SURFACE_SECTION, 210])
  self = 'U0SELF'
  const text = section.text()
  assert(text.includes('(<@U0SELF>)') && text.includes('<@U0HERMES> <@U0MUSE>') && text.endsWith('Team roster.'), 'prompt read at assembly time')
  equal(agentCtx.guards, [slackBypassReason])
})

test('tool results reach the model with tokens redacted', async () => {
  const agentCtx = makeAgentCtx()
  installSlackSurface(agentCtx, { config: {}, logger: makeLogger() })
  const listener = agentCtx.listeners['tools/post-execute'][0]
  equal(agentCtx.listeners['tools/post-execute:options'][0], { prepend: true }, 'outermost listener')
  const result = { isError: false, content: [{ type: 'text', text: 'botToken: ' + BOT_TOKEN }, { type: 'image', data: 'x' }] }
  const accepted = await listener({ name: 'bash' }, result, async () => ({ kind: 'accept' }))
  equal(accepted, { kind: 'accept', content: [{ type: 'text', text: 'botToken: xoxb-<redacted>' }, { type: 'image', data: 'x' }] })
  const replaced = await listener({ name: 'bash' }, result, async () => ({ kind: 'accept', content: [{ type: 'text', text: APP_TOKEN }] }))
  equal(replaced.content, [{ type: 'text', text: 'xapp-<redacted>' }], 'a later listener\'s content is redacted too')
  const blocked = await listener({ name: 'bash' }, result, async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'saw ' + BOT_TOKEN }] }))
  equal(blocked.feedback, [{ type: 'text', text: 'saw xoxb-<redacted>' }])
  const clean = { kind: 'accept' }
  equal(await listener({ name: 'bash' }, { content: [{ type: 'text', text: 'ok' }] }, async () => clean) === clean, true, 'clean result untouched')
  const value = { kind: 'accept', value: { out: 1 } }
  equal(await listener({ name: 'bash' }, result, async () => value) === value, true, 'a value replacement is left alone')
})

test('a composition without the services only warns', () => {
  const agentCtx = makeAgentCtx({ services: false })
  const logger = makeLogger()
  installSlackSurface(agentCtx, { config: {}, logger })
  equal(logger.lines.length, 2)
  assert(agentCtx.listeners['tools/post-execute'].length === 1, 'redaction still installed')
})
