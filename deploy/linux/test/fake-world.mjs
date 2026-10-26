// Fake Slack (Web API + Socket Mode), fake model APIs (NVIDIA, OpenCode Go, DeepSeek) and a fake GitHub
// MCP host for the container test. Their hosts resolve to 127.0.0.2, where this listens on :443 with a
// certificate from a test CA. Only the proxy can reach it (direct :443 is redirected to the plain-text
// box), so every answer here also proves the request went through the proxy.
// Every request is appended to $FAKE_LOG as one JSON line (no secret values, only whether they matched).
//
//   WS_FROM=<a package.json whose node_modules has ws> FAKE_DIR=<cert dir> node fake-world.mjs
//
// The model answers "OK"; when a user message asks to "escalate", to "use bash" and to use "web_search",
// it first calls bash outside the sandbox (an approval prompt, which this fake Slack clicks Allow on),
// then bash (echo tool-ok-$((6*7))), then web_search, and answers with what the tools printed.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createRequire } from 'node:module'

const { WebSocketServer } = createRequire(process.env.WS_FROM)('ws')
const dir = process.env.FAKE_DIR
const LOG = process.env.FAKE_LOG ?? '/var/log/fakeworld.jsonl'
const BOT = { user: 'dsh', user_id: 'UFAKEDSH', bot_id: 'BFAKEDSH', team: 'fake-azumaya', team_id: 'TFAKE' }
const tokens = JSON.parse(readFileSync(dir + '/tokens.json', 'utf8')) // { bot, app, keys: { NAME: value } }
const log = (entry) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n')
const MODEL_HOSTS = { 'integrate.api.nvidia.com': 'NVIDIA_API_KEY', 'opencode.ai': 'OPENCODE_GO_API_KEY', 'api.deepseek.com': 'DEEPSEEK_API_KEY' }

function body(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

function params(req, raw) {
  if ((req.headers['content-type'] ?? '').includes('json')) return raw ? JSON.parse(raw) : {}
  return Object.fromEntries(new URLSearchParams(raw))
}

const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

async function slackApi(req, res, method) {
  const p = params(req, await body(req))
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '') || p.token
  // An approval prompt: the section that shows the call, and the Allow button to click.
  const blocks = Array.isArray(p.blocks) ? p.blocks : []
  const approvalCall = blocks.find((block) => block?.block_id === 'dsh-approval-call')?.text?.text
  const allow = blocks.flatMap((block) => block?.elements ?? []).find((element) => element?.action_id === 'dsh-slack-allow')
  log({ host: 'slack.com', method, tokenMatches: token === tokens.bot ? 'bot' : token === tokens.app ? 'app' : 'no', channel: p.channel, thread_ts: p.thread_ts, text: p.markdown_text ?? p.text, name: p.name, approvalCall, approve: allow !== undefined || undefined })
  const known = token === tokens.bot || token === tokens.app
  if (!known) return json(res, { ok: false, error: 'invalid_auth' })
  if (method === 'chat.postMessage' && allow !== undefined) setTimeout(() => clickAllow(p.channel, allow.value), 1500)
  switch (method) {
    case 'auth.test': return json(res, { ok: true, url: 'https://fake.slack.com/', ...BOT })
    case 'apps.connections.open':
      return token === tokens.app ? json(res, { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=fake' }) : json(res, { ok: false, error: 'not_allowed_token_type' })
    case 'users.info': return json(res, { ok: true, user: { id: p.user, name: 'tester', real_name: 'Tester', profile: { display_name: 'tester', real_name: 'Tester' } } })
    case 'conversations.info': return json(res, { ok: true, channel: { id: p.channel, name: 'agent-council', is_channel: true } })
    case 'conversations.replies':
    case 'conversations.history': return json(res, { ok: true, messages: [], has_more: false })
    case 'chat.postMessage': return json(res, { ok: true, channel: p.channel, ts: (Date.now() / 1000).toFixed(6), message: { text: p.markdown_text ?? p.text } })
    default: return json(res, { ok: true })
  }
}

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((c) => c.type === 'tool_result' ? textOf(c.content) : c.text ?? '').join(' ') : ''
const STEPS = [
  // Outside the sandbox, so DSH asks for approval; the prompt must show this command with the key masked.
  { ask: /escalate/i, name: 'bash', marker: 'approval-ok', input: {
    command: 'GH_TOKEN=' + tokens.approvalSecret + " sh -c 'echo approval-ok-$((6*7))' 2>&1 < /dev/null",
    description: 'container approval test',
    sandbox_permissions: 'danger-full-access',
    justification: 'container test: the approval prompt must show this command',
  } },
  { ask: /use bash/i, name: 'bash', marker: 'tool-ok-', input: { command: 'echo tool-ok-$((6*7))', description: 'container test' } },
  { ask: /web_search/i, name: 'web_search', marker: 'container test', input: { queries: ['container test'] } },
]
/** The tool calls the assistant already made, as { name, args } (OpenAI tool_calls or Anthropic tool_use). */
const called = (messages) => messages.filter((m) => m.role === 'assistant').flatMap((m) => [
  ...(m.tool_calls ?? []).map((call) => ({ name: call.function?.name, args: String(call.function?.arguments ?? '') })),
  ...(Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, args: JSON.stringify(c.input ?? {}) })) : []),
])
const toolResults = (messages) => messages.filter((m) => m.role === 'tool' || (Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')))

/**
 * What the fake model says: each tool a user message asks for (bash: "use bash", then web_search:
 * "web_search") and that is offered, once and in that order; then what the tools printed; otherwise "OK".
 */
function decide(messages, tools) {
  const asked = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n')
  const done = called(messages)
  const next = STEPS.find((step) => step.ask.test(asked) && tools.includes(step.name)
    && !done.some((call) => call.name === step.name && call.args.includes(step.marker)))
  if (next) return { tool: { id: 'call_fake_' + next.marker.replace(/\W/g, '_'), name: next.name, input: next.input } }
  const results = toolResults(messages)
  if (results.length > 0) return { text: 'OK — the tools printed: ' + results.map((m) => textOf(m.content).replace(/\s+/g, ' ').trim().slice(0, 120)).join(' | ') }
  return { text: 'OK' }
}

async function readModelRequest(req, host) {
  const raw = await body(req)
  let p = {}
  try { p = JSON.parse(raw) } catch { /* logged by the caller */ }
  const messages = Array.isArray(p.messages) ? p.messages : []
  const key = tokens.keys[MODEL_HOSTS[host]]
  const keyMatches = req.headers.authorization === 'Bearer ' + key || req.headers['x-api-key'] === key
  const tools = Array.isArray(p.tools) ? p.tools.map((t) => t.function?.name ?? t.name) : []
  const decision = decide(messages, tools)
  log({ host, path: req.url, keyMatches, model: p.model, stream: p.stream, tools: tools.length, hasBash: tools.includes('bash'), web: tools.filter((name) => /^web_/.test(name)), messages: messages.length, toolCall: Boolean(decision.tool) })
  return { p, keyMatches, decision }
}

/** Anthropic Messages (DeepSeek's official API is called this way). */
async function anthropic(req, res, host) {
  const { p, keyMatches, decision } = await readModelRequest(req, host)
  if (!keyMatches) return json(res, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
  const block = decision.tool ? { type: 'tool_use', id: decision.tool.id, name: decision.tool.name, input: decision.tool.input } : { type: 'text', text: decision.text }
  const stop = decision.tool ? 'tool_use' : 'end_turn'
  const message = { id: 'msg_fake', type: 'message', role: 'assistant', model: p.model, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
  if (!p.stream) return json(res, message)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify({ type: event, ...data }) + '\n\n')
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  if (decision.tool) {
    send('content_block_start', { index: 0, content_block: { ...block, input: {} } })
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } })
  }
  send('content_block_stop', { index: 0 })
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
  send('message_stop', {})
  res.end()
}

/** DeepSeek's Search API (web_search): one result for a known key, 401 otherwise (like the real one). */
async function deepseekSearch(req, res, host) {
  let p = {}
  try { p = JSON.parse(await body(req)) } catch { /* logged below */ }
  const keyMatches = req.headers.authorization === 'Bearer ' + tokens.keys.DEEPSEEK_API_KEY
  log({ host, path: req.url, keyMatches, query: p.query, count: p.count })
  if (!keyMatches) return json(res, { error: { message: 'Authentication Fails, Your api key: ****fake is invalid', type: 'authentication_error' } }, 401)
  json(res, { results: [{ url: 'https://example.com/', title: 'Example', snippet: 'fake result', date: null }] })
}

/** OpenAI chat completions (streamed or not): NVIDIA and OpenCode Go. */
async function model(req, res, host) {
  const { p, keyMatches, decision } = await readModelRequest(req, host)
  if (!keyMatches) return json(res, { error: { message: 'Invalid API key', type: 'authentication_error' } }, 401)
  const id = 'chatcmpl-fake', created = Math.floor(Date.now() / 1000)
  const message = decision.tool
    ? { role: 'assistant', content: null, tool_calls: [{ id: decision.tool.id, type: 'function', function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.input) } }] }
    : { role: 'assistant', content: decision.text }
  const finish = message.tool_calls ? 'tool_calls' : 'stop'
  const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
  if (!p.stream) return json(res, { id, object: 'chat.completion', created, model: p.model, choices: [{ index: 0, message, finish_reason: finish }], usage })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (choice, extra = {}) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: p.model, choices: [choice], ...extra }) + '\n\n')
  if (message.tool_calls) chunk({ index: 0, delta: { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }, finish_reason: null })
  else chunk({ index: 0, delta: { role: 'assistant', content: message.content }, finish_reason: null })
  chunk({ index: 0, delta: {}, finish_reason: finish }, { usage })
  res.end('data: [DONE]\n\n')
}

const server = https.createServer({ key: readFileSync(dir + '/server.key'), cert: readFileSync(dir + '/server.crt') }, (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]
  const api = req.url.match(/^\/api\/([A-Za-z.]+)/)
  if (host === 'slack.com' && api) return void slackApi(req, res, api[1])
  if (MODEL_HOSTS[host] && req.method === 'POST' && /chat\/completions/.test(req.url)) return void model(req, res, host)
  if (MODEL_HOSTS[host] && req.method === 'POST' && /\/v1\/messages/.test(req.url)) return void anthropic(req, res, host)
  if (host === 'api.deepseek.com' && req.method === 'POST' && req.url === '/v1/tools/search') return void deepseekSearch(req, res, host)
  if (MODEL_HOSTS[host] && req.method === 'GET' && /\/models/.test(req.url)) {
    log({ host, path: req.url, note: 'model list' })
    return json(res, { object: 'list', data: [] })
  }
  log({ host, method: req.method, path: req.url, note: 'not handled' })
  // api.githubcopilot.com (the GitHub MCP server) and everything else: unauthorized / not found.
  json(res, { error: 'fake ' + host }, host === 'api.githubcopilot.com' ? 401 : 404)
})

// Socket Mode: hello, then (once per run) one channel mention for the bot.
const sent = dir + '/event-sent'
const wss = new WebSocketServer({ server, path: '/link/' })
let live
let clicks = 0
/** A person clicks Allow on an approval prompt (a Block Kit click arrives over the socket). */
function clickAllow(channel, value) {
  clicks += 1
  live?.send(JSON.stringify({
    envelope_id: 'env-click-' + clicks, type: 'interactive', accepts_response_payload: false,
    payload: { type: 'block_actions', team: { id: 'TFAKE' }, user: { id: 'UHUMAN' }, channel: { id: channel }, actions: [{ type: 'button', block_id: 'dsh-approval', action_id: 'dsh-slack-allow', value }] },
  }))
  log({ host: 'wss-primary.slack.com', ws: 'sent click', channel, live: live !== undefined })
}
wss.on('connection', (socket, req) => {
  live = socket
  log({ host: 'wss-primary.slack.com', ws: 'connected', path: req.url })
  socket.send(JSON.stringify({ type: 'hello', num_connections: 1, debug_info: { host: 'fake', build_number: 1, approximate_connection_time: 18060 }, connection_info: { app_id: 'AFAKE' } }))
  socket.on('message', (data) => log({ host: 'wss-primary.slack.com', ws: 'client message', data: String(data).slice(0, 200) }))
  if (existsSync(sent)) return
  writeFileSync(sent, '1')
  setTimeout(() => {
    const ts = (Date.now() / 1000).toFixed(6)
    const event = { type: 'message', channel: 'C0C8YJTC147', channel_type: 'channel', user: 'UHUMAN', text: '<@UFAKEDSH> container test: escalate one command, use bash to run one echo, then one web_search, then reply OK', ts, event_ts: ts, team: 'TFAKE' }
    socket.send(JSON.stringify({
      envelope_id: 'env-fake-1', type: 'events_api', accepts_response_payload: false, retry_attempt: 0, retry_reason: '',
      payload: { token: 'x', team_id: 'TFAKE', api_app_id: 'AFAKE', type: 'event_callback', event_id: 'EvFAKE1', event_time: Math.floor(Date.now() / 1000), event, authorizations: [{ enterprise_id: null, team_id: 'TFAKE', user_id: 'UFAKEDSH', is_bot: true, is_enterprise_install: false }] },
    }))
    log({ host: 'wss-primary.slack.com', ws: 'sent mention', ts })
  }, 3000)
})

server.listen(443, '127.0.0.2', () => log({ note: 'fake world listening on 127.0.0.2:443' }))
