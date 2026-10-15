// Plugin-level tests: apply() against a mock Slack Web API and a fake
// agents registry, driven through the real Socket Mode loop.

import { test, assert, equal, startMockSlack, sleep, waitFor, FakeSlackSocket } from './_util.mjs'
import { apply, Config } from '../src/index.js'

class FakeAgent {
  constructor(id) {
    this.id = id
    this.session = { id, header: { id } }
    this.followups = []
    this.cancels = []
    this.auto = true
    this.script = []
    this.turn = 0
    this.onEvent = undefined
  }

  followup(message) {
    this.followups.push(message)
    if (this.auto === false) return
    const text = this.script.length > 0 ? this.script.shift() : 'pong'
    queueMicrotask(() => this.complete(text))
  }

  cancel(cause, options) {
    this.cancels.push({ cause, options })
  }

  complete(text, kind = 'completed') {
    const turn = ++this.turn
    this.onEvent?.({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
    this.onEvent?.({ type: 'turn/end', data: { turn, reason: { kind } } })
  }
}

function makeCtx() {
  const listeners = {}
  const effects = []
  const logs = []
  const ctx = {
    logger: () => ({
      info: () => {},
      warn: (...a) => logs.push('warn ' + a.join(' ')),
      error: (...a) => logs.push('error ' + a.join(' ')),
    }),
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
      return () => {
        const at = listeners[event].indexOf(fn)
        if (at >= 0) listeners[event].splice(at, 1)
      }
    },
    effect(fn, label) { effects.push(fn) },
    // The real cordis context resolves an unmounted service to undefined;
    // sessions.js consults agentDefaultModel/permissionPresets through it.
    get: () => undefined,
    agents: undefined,
    __listeners: listeners,
  }
  return { ctx, listeners, effects, logs }
}

function emit(ctx, event, ...args) {
  for (const fn of [...(ctx.__listeners[event] ?? [])]) fn(...args)
}

/** Mount with the socket factory wired BEFORE apply. */
async function mountConnected(mock, configOverrides = {}) {
  const { ctx, listeners, effects, logs } = makeCtx()
  const created = []
  const disposed = []
  ctx.agents = {
    async create(options) {
      const agent = new FakeAgent(options.sessionId)
      agent.onEvent = (event) => emit(ctx, 'session/event', agent.session, event)
      created.push(agent)
      return { agent, dispose: async () => { disposed.push(options.sessionId) } }
    },
    async resume() { throw new Error('persistence not configured in test') },
    get: (id) => created.find((a) => a.id === id),
  }
  const h = {
    ctx, created, disposed, logs,
    sockets: [],
    envelopeCounter: 0,
    push(event) {
      h.envelopeCounter += 1
      h.sockets[0]?.receive({ envelope_id: 'e-' + h.envelopeCounter, type: 'events_api', payload: { event } })
    },
    sent() { return mock.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.body) },
    reacts() { return mock.calls.filter((c) => c.method === 'reactions.add').map((c) => c.body) },
    unreacts() { return mock.calls.filter((c) => c.method === 'reactions.remove').map((c) => c.body) },
    acks() { return h.sockets[0]?.sent ?? [] },
    async dispose() {
      const body = effects[effects.length - 1]
      await body()()
    },
  }
  const config = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    apiBase: mock.url,
    allowedChannelIds: ['C42'],
    socketRetryDelayMs: 20,
    retryDelayMs: 50,
    ...configOverrides,
  }
  const validated = Config['~standard'].validate(config)
  assert(validated.issues === undefined, 'mount config invalid: ' + JSON.stringify(validated.issues))
  const configValue = validated.value
  // The socket factory rides the config seam (runtime-only override), so
  // concurrent tests never fight over a single global socket slot.
  const originalWebSocket = globalThis.WebSocket
  configValue.wsFactory = async () => {
    const socket = new FakeSlackSocket()
    h.sockets.push(socket)
    return socket
  }
  apply(ctx, configValue)
  const innerDispose = h.dispose
  h.dispose = async () => {
    await innerDispose()
    globalThis.WebSocket = originalWebSocket
  }
  return h
}

function messageEvent(channel, text, extra = {}) {
  return { type: 'message', channel, user: 'U1', text, ts: '1700000001.001', ...extra }
}

test('delivers the agent reply threaded, with reaction acks', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mountConnected(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', 'hello'))
    await waitFor(() => h.created.length === 1)
    const reply = await waitFor(() => h.sent().find((s) => s.channel === 'C42' && s.text === 'pong'))
    equal(reply.thread_ts, '1700000001.001', 'reply posted in-thread')
    await waitFor(() => h.reacts().length >= 1 && h.unreacts().length >= 1)
    equal(h.reacts()[0].name, 'hourglass', 'ack reaction added')
    equal(h.reacts()[0].channel, 'C42')
    equal(h.unreacts()[0].name, 'hourglass', 'ack reaction removed after reply')
    equal(h.created[0].followups[0].source, { kind: 'user' })
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('bot echoes and subtypes are ignored', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mountConnected(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', 'from a bot', { bot_id: 'B1' }))
    h.push(messageEvent('C42', 'an edit', { subtype: 'message_changed' }))
    await sleep(300)
    equal(h.created.length, 0, 'no session for bot/subtype events')
    equal(h.sent().length, 0, 'no replies')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('own echoes are ignored while another app is served', async () => {
  const mock = await startMockSlack()
  // auth.test is what tells our own messages apart from another app's.
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-SELF' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200) // let the probe store the identity

    // Our own post comes back as an event and must not drive the agent.
    h.push(messageEvent('C42', 'our own reply', { bot_id: 'B-SELF' }))
    await sleep(200)
    equal(h.created.length, 0, 'own echo ignored')

    // Another app's post is served.
    h.push(messageEvent('C42', 'from another app', { bot_id: 'B-OTHER', subtype: 'bot_message' }))
    await waitFor(() => h.created.length === 1)
    equal(h.created.length, 1, 'another app creates a session')
    await waitFor(() => h.sent().some((s) => s.text === 'pong'))
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('/id answers with the channel id; /help lists commands', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mountConnected(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', '/id'))
    const idReply = await waitFor(() => h.sent().find((s) => s.channel === 'C42'))
    equal(idReply.text, 'C42')
    h.push(messageEvent('C42', '/help'))
    await waitFor(() => h.sent().length >= 2)
    assert(h.sent()[1].text.includes('!pair'), 'help mentions pairing')
    equal(h.created.length, 0, 'commands create no session')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('unauthorized channels are ignored', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mountConnected(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C999', 'sneak'))
    await sleep(300)
    equal(h.sent().length, 0, 'no reply to unauthorized channel')
    equal(h.created.length, 0, 'no session for unauthorized channel')
    await h.dispose()
  } finally {
    await mock.close()
  }
})
