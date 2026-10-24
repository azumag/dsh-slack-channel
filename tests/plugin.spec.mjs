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
    // sessions.js consults agentDefaultModel/permissionPresets/agentPresets through it.
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

test('a reply mentions only the allowlisted ids', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { mentionUserIds: ['U-APP'] })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200)

    h.push(messageEvent('C42', '<@U-BOT> first'))
    await waitFor(() => h.created.length === 1)
    h.created[0].script.push('<@U-APP> hermes へ <@U-NOPE> と <https://x.example|link>')
    h.push(messageEvent('C42', '<@U-BOT> second'))

    await waitFor(() => h.sent().some((s) => s.text.includes('hermes へ')))
    const body = h.sent().map((s) => s.text).find((t) => t.includes('hermes へ'))
    assert(body.includes('<@U-APP> hermes へ'), 'the allowlisted id stays a real mention: ' + body)
    assert(body.includes('&lt;@U-NOPE&gt;'), 'ids outside the allowlist stay escaped: ' + body)
    assert(body.includes('&lt;https://x.example|link&gt;'), 'links stay escaped: ' + body)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('a redirected id is posted as its successor in the text and the CC prefix', async () => {
  // 2026-10-23: wagyu kept being pinged; its mentions now go to Muse instead.
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { ccUserIds: ['U-WAGYU'], mentionRewrites: { 'U-WAGYU': 'U-MUSE' } })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200)

    h.push(messageEvent('C42', '<@U-BOT> first'))
    await waitFor(() => h.created.length === 1)
    h.created[0].script.push('<@U-WAGYU> owner さんの実機確認枠')
    h.push(messageEvent('C42', '<@U-BOT> second'))

    await waitFor(() => h.sent().some((s) => s.text.includes('実機確認枠')))
    const body = h.sent().map((s) => s.text).find((t) => t.includes('実機確認枠'))
    assert(!body.includes('U-WAGYU'), 'the retired id never reaches Slack: ' + body)
    assert(body.includes('<@U-MUSE> owner さんの実機確認枠'), 'the successor is a real mention: ' + body)
    const prefixed = h.sent().map((s) => s.text)
    assert(prefixed.every((t) => !t.includes('U-WAGYU')), 'CC prefixes are redirected too: ' + JSON.stringify(prefixed))
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('only the listed apps are mentioned back while mentionBackBots is off', async () => {
  // 2026-10-23: DSH answered Muse (an orchestrator app) with its id escaped as text, so Muse never got the reply.
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { mentionBackBots: false, mentionBackBotIds: ['U-MUSE'] })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200)

    h.push(messageEvent('C42', '<@U-BOT|DSH> muse ping', { bot_id: 'B-MUSE', user: 'U-MUSE' }))
    await waitFor(() => h.sent().some((s) => s.text === '<@U-MUSE> pong'))

    const before = h.sent().length
    h.push(messageEvent('C42', '<@U-BOT> other app ping', { bot_id: 'B-OTHER', user: 'U-APP', ts: '1700000002.001' }))
    await waitFor(() => h.sent().length > before)
    assert(h.sent().slice(before).every((s) => s.text === 'pong'), 'unlisted apps are answered without a ping')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('a mention is answered with a mention of its author', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { mentionBackBots: true })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200) // let the probe store our user id

    // No mention: answered plainly.
    h.push(messageEvent('C42', 'plain question'))
    await waitFor(() => h.sent().some((s) => s.text === 'pong'))

    // Mentioned by a human: the answer opens with a mention of that human.
    h.push(messageEvent('C42', '<@U-BOT> ping'))
    await waitFor(() => h.sent().some((s) => s.text === '<@U1> pong'))

    // Mentioned by another app: its user id is mentioned back too.
    h.push(messageEvent('C42', '<@U-BOT> app ping', { bot_id: 'B-OTHER', user: 'U-APP' }))
    await waitFor(() => h.sent().some((s) => s.text === '<@U-APP> pong'))

    // Our own post never earns a mention back (it is filtered out entirely).
    const sentAfterApp = h.sent().length
    h.push(messageEvent('C42', '<@U-BOT> self ping', { bot_id: 'B-SELF', user: 'U-SELF' }))
    await sleep(200)
    equal(h.sent().length, sentAfterApp, 'own echo still ignored')

    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('an app mention is answered without pinging the app back by default', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200)

    h.push(messageEvent('C42', '<@U-BOT> app ping', { bot_id: 'B-OTHER', user: 'U-APP' }))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.created[0].complete('pong')
    const reply = await waitFor(() => h.sent().find((s) => s.text === 'pong'))
    assert(reply !== undefined, 'the app is answered')
    equal(reply.text, 'pong', 'no automatic mention back at the app')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('maxBotTurns caps a bot chain and a human resets it', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { maxBotTurns: 2 })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200) // let the probe store our user id
    const thread = { thread_ts: '1700000001.000' }

    h.push(messageEvent('C42', '<@U-BOT> one', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    await waitFor(() => h.sent().some((s) => s.text === 'pong'))

    h.created[0].script.push('pong-2')
    h.push(messageEvent('C42', '<@U-BOT> two', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
    await waitFor(() => h.created[0].followups.length === 2)
    await waitFor(() => h.sent().some((s) => s.text === 'pong-2'))

    // Third app message in a row: dropped without a reply or a turn.
    h.push(messageEvent('C42', '<@U-BOT> three', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
    await sleep(200)
    equal(h.created[0].followups.length, 2, 'third app message is dropped')

    // A human message resets the budget; the next app message is answered.
    h.created[0].script.push('human-answer')
    h.push(messageEvent('C42', 'human here', thread))
    await waitFor(() => h.created[0].followups.length === 3)
    await waitFor(() => h.sent().some((s) => s.text === 'human-answer'))

    h.created[0].script.push('pong-4')
    h.push(messageEvent('C42', '<@U-BOT> four', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
    await waitFor(() => h.created[0].followups.length === 4, 2000)
    equal(h.created[0].followups.length, 4, 'a human reset reopened the budget')
    await waitFor(() => h.sent().some((s) => s.text === 'pong-4'))
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('a varied bot collaboration runs to the turn ceiling, not two turns', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { maxBotTurns: 4, maxBotRepeats: 3 })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200)
    const thread = { thread_ts: '1700000001.000' }

    for (let i = 1; i <= 4; i += 1) {
      h.push(messageEvent('C42', '<@U-BOT> progress ' + i + ' with new facts', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
      await waitFor(() => h.created.length === 1 && h.created[0].followups.length === i, 3000)
    }
    equal(h.created[0].followups.length, 4, 'four varied progress reports are answered')

    h.push(messageEvent('C42', '<@U-BOT> progress 5 with new facts', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
    await sleep(200)
    equal(h.created[0].followups.length, 4, 'the turn ceiling is a backstop')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('the same bot text trips the repetition guard before the turn ceiling', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { maxBotTurns: 10, maxBotRepeats: 2 })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200)
    const thread = { thread_ts: '1700000001.000' }

    for (let i = 1; i <= 2; i += 1) {
      h.push(messageEvent('C42', '<@U-BOT> （なし）', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
      await waitFor(() => h.created.length === 1 && h.created[0].followups.length === i, 3000)
    }
    h.push(messageEvent('C42', '<@U-BOT> （なし）', { bot_id: 'B-OTHER', user: 'U-APP', ...thread }))
    await sleep(200)
    equal(h.created[0].followups.length, 2, 'third identical text is dropped')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('mentionOnly serves only mentions, carrying the unseen messages', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { mentionOnly: true, contextMessages: 5 })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    await sleep(200)

    // Not addressed to us: no turn and no reply ...
    h.push(messageEvent('C42', 'inner monologue'))
    h.push(messageEvent('C42', 'more chatter', { user: 'U2' }))
    await sleep(200)
    equal(h.created.length, 0, 'gated messages drive no turn')
    equal(h.sent().length, 0, 'gated messages get no reply')

    // ... but addressed to us, they arrive as context ahead of the mention.
    h.push(messageEvent('C42', '<@U-BOT> what do you think?'))
    await waitFor(() => h.created.length === 1)
    const first = h.created[0].followups[0].content[0].text
    assert(first.startsWith('[channel context'), 'the context block comes first')
    assert(first.includes('inner monologue'), 'context carries the first unseen message')
    assert(first.includes('more chatter'), 'context carries the second unseen message')
    assert(first.endsWith('<@U-BOT> what do you think?'), 'the mention stays at the end')

    // The buffer is consumed once: the next mention carries no context.
    await waitFor(() => h.sent().some((s) => s.text === '<@U1> pong'))
    h.push(messageEvent('C42', '<@U-BOT> and now?'))
    await waitFor(() => h.created[0].followups.length === 2)
    equal(h.created[0].followups[1].content[0].text, '<@U-BOT> and now?', 'context is consumed once')

    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('mentionOnly never gates a DM', async () => {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    return undefined
  })
  try {
    const h = await mountConnected(mock, { mentionOnly: true, allowAllChannels: true })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)

    h.push(messageEvent('D42', 'no mention in a direct message'))
    await waitFor(() => h.created.length === 1)
    equal(h.created.length, 1, 'a DM drives a turn without a mention')

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
