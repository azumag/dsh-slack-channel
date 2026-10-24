// Plugin flow tests: busy queueing, /stop, /new, pairing, and teardown.

import { test, assert, equal, startMockSlack, sleep, waitFor, FakeSlackSocket } from './_util.mjs'
import { apply, Config } from '../src/index.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class FakeAgent {
  constructor(id) {
    this.id = id
    this.session = { id, header: { id } }
    this.followups = []
    this.cancels = []
    this.auto = false
    this.turn = 0
    this.onEvent = undefined
  }

  followup(message) {
    this.followups.push(message)
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
async function mount(mock, configOverrides = {}) {
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
  // The socket factory rides the config seam (runtime-only override), so
  // concurrent tests never clobber a shared global socket slot.
  validated.value.wsFactory = async () => {
    const socket = new FakeSlackSocket()
    h.sockets.push(socket)
    return socket
  }
  apply(ctx, validated.value)
  return h
}

let tsCounter = 1700000000

function messageEvent(channel, text) {
  tsCounter += 1
  return { type: 'message', channel, user: 'U1', text, ts: tsCounter + '.001' }
}

test('ccUserIds are added to the first reply chunk', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { ccUserIds: ['U999CC'] })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', 'hello'))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.created[0].complete('answer')
    const reply = await waitFor(() => h.sent().find((s) => s.text === '<@U999CC> answer'))
    assert(reply !== undefined, 'CC mention is on the reply')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('messages posted while busy are queued and drained in order', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', 'first'))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    const secondTs = String(tsCounter + 1) + '.002'
    h.push(messageEvent('C42', 'second'))
    const ack = await waitFor(() => h.sent().find((s) => s.text.includes('Queued')))
    assert(ack.thread_ts !== undefined, 'ack threaded on the queued message')
    equal(h.created[0].followups.length, 1, 'second message not submitted yet')

    h.created[0].complete('answer-1')
    const reply1 = await waitFor(() => h.sent().find((s) => s.text === 'answer-1'))
    assert(reply1 !== undefined, 'first reply delivered')
    await waitFor(() => h.created[0].followups.length === 2, 2000)
    equal(h.created[0].followups[1].content, [{ type: 'text', text: 'second' }], 'queued message drained')

    h.created[0].complete('answer-2')
    await waitFor(() => h.sent().find((s) => s.text === 'answer-2'))
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('/stop cancels the running turn and clears the queue', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', 'long task'))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.push(messageEvent('C42', 'follow-up'))
    await waitFor(() => h.sent().find((s) => s.text.includes('Queued')))
    h.push(messageEvent('C42', '/stop'))
    await waitFor(() => h.sent().find((s) => s.text === 'Stop requested.'))
    equal(h.created[0].cancels.length, 1)
    equal(h.created[0].cancels[0].cause, { kind: 'user' })
    equal(h.created[0].followups.length, 1, 'queued message never submitted')

    h.created[0].complete('partial', 'aborted')
    await waitFor(() => h.sent().find((s) => s.text === 'Stopped.'))
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('/new disposes the old session and starts a fresh one', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', 'hello'))
    await waitFor(() => h.created.length === 1)
    const oldId = h.created[0].id
    h.push(messageEvent('C42', '/new'))
    await waitFor(() => h.sent().find((s) => s.text === 'Started a fresh session.'))
    await waitFor(() => h.created.length === 2)
    assert(h.disposed.includes(oldId), 'old session disposed')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('/pair with the configured token enrolls a channel persistently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slack-pair-'))
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { pairToken: 's3cret', stateFile: join(dir, 'state.json') })
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)

    h.push(messageEvent('C999', 'sneak'))
    await sleep(300)
    equal(h.sent().length, 0, 'no reply to unauthorized channel')

    h.push(messageEvent('C999', '/pair wrong-token'))
    await sleep(300)
    equal(h.sent().filter((s) => s.text.includes('Paired')).length, 0, 'wrong token never pairs')

    h.push(messageEvent('C999', '/pair s3cret'))
    await waitFor(() => h.sent().find((s) => s.text === 'Paired — this channel is now authorized.'))
    h.push(messageEvent('C999', 'hello'))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.created[0].complete('pong')
    await waitFor(() => h.sent().find((s) => s.text === 'pong'))

    const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    equal(saved.enrolled, ['C999'])
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('teardown stops the socket loop and disposes sessions', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
    h.push(messageEvent('C42', 'hello'))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.created[0].complete('pong')
    await waitFor(() => h.sent().find((s) => s.text === 'pong'))
    await h.dispose()
    const opens = mock.calls.filter((c) => c.method === 'apps.connections.open').length
    h.push(messageEvent('C42', 'after teardown'))
    await sleep(300)
    equal(h.created.length, 1, 'no new sessions after teardown')
    const opensAfter = mock.calls.filter((c) => c.method === 'apps.connections.open').length
    assert(opensAfter <= opens + 1, 'socket loop stopped reconnecting')
  } finally {
    await mock.close()
  }
})
