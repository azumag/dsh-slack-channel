// sessionScope: 'thread' — every Slack thread is its own DSH session. A
// top-level message opens one; replies in its thread continue it; queues,
// /stop, /new, unseen context and interactive prompts all stay inside the
// thread. Also: replies always post under the thread ROOT (Slack asks for the
// parent's ts, never a reply's), in both scopes.

import { test, assert, equal, startMockSlack, waitFor, FakeSlackSocket } from './_util.mjs'
import { apply, Config } from '../src/index.js'

class FakeAgent {
  constructor(id) {
    this.id = id
    this.session = { id, header: { id } }
    this.followups = []
    this.cancels = []
    this.turn = 0
    this.onEvent = undefined
  }

  followup(message) {
    this.followups.push(message)
  }

  cancel(cause) {
    this.cancels.push(cause)
  }

  complete(text) {
    const turn = ++this.turn
    this.onEvent?.({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
    this.onEvent?.({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
}

async function mount(mock, configOverrides = {}) {
  const listeners = {}
  const effects = []
  const created = []
  const disposed = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
      return () => {
        const at = listeners[event].indexOf(fn)
        if (at >= 0) listeners[event].splice(at, 1)
      }
    },
    effect(fn) { effects.push(fn) },
    get: () => undefined,
    agents: {
      async create(options) {
        const agent = new FakeAgent(options.sessionId)
        agent.onEvent = (event) => {
          for (const fn of [...(listeners['session/event'] ?? [])]) fn(agent.session, event)
        }
        created.push(agent)
        return { agent, dispose: async () => { disposed.push(options.sessionId) } }
      },
      async resume() { throw new Error('persistence not configured in test') },
    },
  }
  const h = {
    created, disposed,
    sockets: [],
    n: 0,
    push(event) {
      h.n += 1
      h.sockets[0]?.receive({ envelope_id: 'e-' + h.n, type: 'events_api', payload: { event } })
    },
    sent() { return mock.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.body) },
    waterfall(event, request, tail) {
      const chain = [...(listeners[event] ?? [])]
      const run = (index) => (chain[index] ?? tail)(request, () => run(index + 1))
      return run(0)
    },
    async dispose() {
      await effects[effects.length - 1]()()
    },
  }
  const validated = Config['~standard'].validate({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    apiBase: mock.url,
    allowedChannelIds: ['C42'],
    socketRetryDelayMs: 20,
    retryDelayMs: 50,
    interactiveTimeoutMs: 2000,
    sessionScope: 'thread',
    ...configOverrides,
  })
  assert(validated.issues === undefined, 'mount config invalid: ' + JSON.stringify(validated.issues))
  validated.value.wsFactory = async () => {
    const socket = new FakeSlackSocket()
    h.sockets.push(socket)
    return socket
  }
  apply(ctx, validated.value)
  await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
  return h
}

let ts = 1800000000
function message(text, extra = {}) {
  ts += 1
  return { type: 'message', channel: 'C42', user: 'U1', text, ts: ts + '.001', ...extra }
}

const NEVER = () => new Promise(() => {})

/** Mock Slack that knows our identity (mentions need it). */
async function mockWithIdentity() {
  const mock = await startMockSlack()
  mock.setHandler((method) => (method === 'auth.test' ? { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } } : undefined))
  return mock
}

test('thread scope: each top-level message gets its own session; replies continue it under the root', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const a = message('topic A')
    const b = message('topic B')
    h.push(a)
    h.push(b)
    await waitFor(() => h.created.length === 2 && h.created.every((agent) => agent.followups.length === 1))
    const reply = message('more on A', { thread_ts: a.ts })
    h.created[0].complete('A answered')
    await waitFor(() => h.sent().some((s) => s.text === 'A answered'))
    equal(h.sent().find((s) => s.text === 'A answered').thread_ts, a.ts)
    h.push(reply)
    await waitFor(() => h.created[0].followups.length === 2)
    equal(h.created.length, 2, 'no new session for a reply')
    h.created[0].complete('A again')
    const again = await waitFor(() => h.sent().find((s) => s.text === 'A again'))
    equal(again.thread_ts, a.ts, 'reply posted under the root, not under the reply')
    h.created[1].complete('B answered')
    equal((await waitFor(() => h.sent().find((s) => s.text === 'B answered'))).thread_ts, b.ts)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread scope: a busy thread does not hold up another thread', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const a = message('long task')
    h.push(a)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.push(message('queued behind A', { thread_ts: a.ts }))
    await waitFor(() => h.sent().some((s) => s.text.startsWith('Queued (1 pending)') && s.thread_ts === a.ts))
    h.push(message('independent B'))
    await waitFor(() => h.created.length === 2 && h.created[1].followups.length === 1)
    equal(h.created[0].followups.length, 1, 'A still has only its first turn')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread scope: !stop and !new act on their own thread only', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const a = message('task A')
    const b = message('task B')
    h.push(a)
    h.push(b)
    await waitFor(() => h.created.length === 2 && h.created.every((agent) => agent.followups.length === 1))
    h.push(message('!stop', { thread_ts: a.ts }))
    await waitFor(() => h.created[0].cancels.length === 1)
    equal(h.created[1].cancels.length, 0, 'B keeps running')

    h.push(message('!new'))
    await waitFor(() => h.sent().some((s) => s.text.includes('Every new thread already starts its own session')))
    equal(h.created.length, 2, 'a top-level !new creates nothing')

    h.created[1].complete('B done')
    await waitFor(() => h.sent().some((s) => s.text === 'B done'))
    h.push(message('!new', { thread_ts: b.ts }))
    await waitFor(() => h.sent().some((s) => s.text === 'Started a fresh session for this thread.' && s.thread_ts === b.ts))
    equal(h.created.length, 3, 'fresh session for thread B')
    equal(h.disposed, [h.created[1].id], 'only B\'s old session was disposed')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread scope: an approval is answered from its own thread, not from another one', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const a = message('needs approval')
    const b = message('other work')
    h.push(a)
    h.push(b)
    await waitFor(() => h.created.length === 2)
    const outcome = h.waterfall('approval/request', { agent: h.created[0], toolName: 'bash' }, NEVER)
    const prompt = await waitFor(() => h.sent().find((s) => Array.isArray(s.blocks)))
    equal(prompt.thread_ts, a.ts, 'prompt posted in thread A')
    h.push(message('!allow', { thread_ts: b.ts }))
    await waitFor(() => h.sent().some((s) => s.text === 'Nothing is waiting for approval.' && s.thread_ts === b.ts))
    h.push(message('!allow', { thread_ts: a.ts }))
    equal(await outcome, 'allowed-once')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread scope + mentionOnly: unseen replies stay with their thread; unseen top-level messages go to the next new thread', async () => {
  const mock = await mockWithIdentity()
  try {
    const h = await mount(mock, { mentionOnly: true })
    await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
    const a = message('<@U-BOT> start A')
    h.push(a)
    await waitFor(() => h.created.length === 1)
    h.push(message('chatter in A', { thread_ts: a.ts, user: 'U2' }))
    h.push(message('channel chatter', { user: 'U3' }))
    h.created[0].complete('ok')
    await waitFor(() => h.sent().some((s) => s.text.includes('ok')))
    h.push(message('<@U-BOT> what about it?', { thread_ts: a.ts }))
    await waitFor(() => h.created[0].followups.length === 2)
    const inThread = h.created[0].followups[1].content[0].text
    assert(inThread.includes('<@U2>: chatter in A'), 'thread chatter carried into the thread turn')
    assert(!inThread.includes('channel chatter'), 'channel chatter not mixed into the thread')

    h.push(message('<@U-BOT> new topic'))
    await waitFor(() => h.created.length === 2 && h.created[1].followups.length === 1)
    const fresh = h.created[1].followups[0].content[0].text
    assert(fresh.includes('<@U3>: channel chatter'), 'channel chatter carried into the new thread')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('channel scope (default): a reply in a thread is answered under the root', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { sessionScope: undefined })
    const root = message('first')
    h.push(root)
    await waitFor(() => h.created.length === 1)
    h.created[0].complete('one')
    await waitFor(() => h.sent().some((s) => s.text === 'one'))
    h.push(message('in thread', { thread_ts: root.ts }))
    await waitFor(() => h.created[0].followups.length === 2)
    equal(h.created.length, 1, 'channel scope keeps one session')
    h.created[0].complete('two')
    equal((await waitFor(() => h.sent().find((s) => s.text === 'two'))).thread_ts, root.ts)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('sessionScope is validated', () => {
  const bad = Config['~standard'].validate({ botToken: 'xoxb-x', appToken: 'xapp-x', sessionScope: 'user' })
  assert(bad.issues?.some((issue) => issue.message.includes('sessionScope')), 'invalid scope reported')
  const good = Config['~standard'].validate({ botToken: 'xoxb-x', appToken: 'xapp-x' })
  equal(good.value.sessionScope, 'channel', 'default stays channel')
})
