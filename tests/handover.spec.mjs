// Handover (receive off): the receive-off file beside the state file closes
// the Slack socket without a reload. Turns already running and messages
// already waiting still finish and reply; nothing new arrives; the drain file
// says what is left; removing the file opens the socket again.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, assert, equal, sleep, startMockSlack, waitFor, FakeSlackSocket } from './_util.mjs'
import { apply, Config } from '../src/index.js'

class FakeAgent {
  constructor(id) {
    this.id = id
    this.session = { id, header: { id } }
    this.followups = []
    this.turn = 0
    this.onEvent = undefined
  }

  followup(message) {
    this.followups.push(message)
  }

  cancel() {}

  complete(text) {
    const turn = ++this.turn
    this.onEvent?.({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
    this.onEvent?.({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
}

async function mount(mock, configOverrides = {}, { resumable = false } = {}) {
  const listeners = {}
  const effects = []
  const created = []
  const newAgent = (id) => {
    const agent = new FakeAgent(id)
    agent.onEvent = (event) => {
      for (const fn of [...(listeners['session/event'] ?? [])]) fn(agent.session, event)
    }
    created.push(agent)
    return { agent, dispose: async () => {} }
  }
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
      async create(options) { return newAgent(options.sessionId) },
      async resume(options) {
        if (resumable === false) throw new Error('persistence not configured in test')
        return newAgent(options.resumeSessionId)
      },
    },
  }
  const h = {
    created,
    sockets: [],
    n: 0,
    push(event) {
      h.n += 1
      h.sockets.at(-1)?.receive({ envelope_id: 'e-' + h.n, type: 'events_api', payload: { event } })
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
    receivePollMs: 20,
    sessionScope: 'thread',
    maxConcurrentTurns: 1,
    ...configOverrides,
  })
  assert(validated.issues === undefined, 'mount config invalid: ' + JSON.stringify(validated.issues))
  validated.value.wsFactory = async () => {
    const socket = new FakeSlackSocket()
    h.sockets.push(socket)
    return socket
  }
  apply(ctx, validated.value)
  return h
}

let ts = 1900000000
function message(text, extra = {}) {
  ts += 1
  return { type: 'message', channel: 'C42', user: 'U1', text, ts: ts + '.001', ...extra }
}

async function mockWithIdentity() {
  const mock = await startMockSlack()
  mock.setHandler((method) => (method === 'auth.test' ? { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } } : undefined))
  return mock
}

const readDrain = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined)

test('receive off closes the socket; what runs and waits here still finishes and replies; removing the file reopens it', async () => {
  const mock = await mockWithIdentity()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slack-handover-'))
  try {
    const stateFile = join(dir, 'state.json')
    const offFile = join(dir, 'state.receive-off')
    const drainFile = join(dir, 'state.drain.json')
    const h = await mount(mock, { stateFile })
    await waitFor(() => h.sockets.length === 1 && h.sockets[0].listeners.message?.length > 0)
    const a = message('task A')
    const b = message('task B')
    h.push(a)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.push(b)
    await waitFor(() => h.sent().some((s) => s.text.startsWith('Queued')))

    writeFileSync(offFile, '')
    await waitFor(() => h.sockets[0].open === false)
    const left = await waitFor(() => readDrain(drainFile))
    equal([left.receiving, left.drained, left.running, left.waiting], [false, false, ['C42:' + a.ts], ['C42:' + b.ts]], 'the drain file names the running and the waiting thread')
    await sleep(100)
    equal(h.sockets.length, 1, 'no new socket while receive is off')

    h.created[0].complete('A done')
    await waitFor(() => h.sent().some((s) => s.text === 'A done' && s.thread_ts === a.ts))
    await waitFor(() => h.created.length === 2 && h.created[1].followups.length === 1)
    h.created[1].complete('B done')
    await waitFor(() => h.sent().some((s) => s.text === 'B done' && s.thread_ts === b.ts))
    const done = await waitFor(() => (readDrain(drainFile)?.drained === true ? readDrain(drainFile) : undefined))
    equal([done.running, done.waiting], [[], []], 'nothing left once both finished')

    rmSync(offFile)
    await waitFor(() => h.sockets.length === 2 && h.sockets[1].listeners.message?.length > 0)
    assert(!existsSync(drainFile), 'the drain file goes with receive on')
    const c = message('task C')
    h.push(c)
    await waitFor(() => h.created.length === 3 && h.created[2].followups.length === 1)
    await h.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await mock.close()
  }
})

test('mounted with receive off: no socket at all, and the turn a reload stopped still resumes and replies', async () => {
  const mock = await mockWithIdentity()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slack-handover-'))
  try {
    const stateFile = join(dir, 'state.json')
    const offFile = join(dir, 'state.receive-off')
    const drainFile = join(dir, 'state.drain.json')
    const first = await mount(mock, { stateFile })
    await waitFor(() => first.sockets.length === 1 && first.sockets[0].listeners.message?.length > 0)
    const a = message('task A')
    first.push(a)
    await waitFor(() => first.created.length === 1 && first.created[0].followups.length === 1)
    writeFileSync(offFile, '')
    await waitFor(() => first.sockets[0].open === false)
    await first.dispose()

    const second = await mount(mock, { stateFile }, { resumable: true })
    await waitFor(() => second.created.length === 1 && second.created[0].followups.length === 1)
    equal(second.created[0].id, first.created[0].id, 'the stopped turn resumed its own session')
    equal(readDrain(drainFile)?.running, ['C42:' + a.ts], 'the resumed turn is in the drain file')
    second.created[0].complete('A finished after the reload')
    await waitFor(() => second.sent().some((s) => s.text === 'A finished after the reload' && s.thread_ts === a.ts))
    await waitFor(() => readDrain(drainFile)?.drained === true)
    equal(second.sockets.length, 0, 'never connected while receive is off')
    await second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await mock.close()
  }
})

test('while receive is off a prompt is declined at once instead of posting buttons nobody here can receive', async () => {
  const mock = await mockWithIdentity()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slack-handover-'))
  try {
    const stateFile = join(dir, 'state.json')
    const h = await mount(mock, { stateFile })
    await waitFor(() => h.sockets.length === 1 && h.sockets[0].listeners.message?.length > 0)
    h.push(message('task A'))
    await waitFor(() => h.created.length === 1)
    writeFileSync(join(dir, 'state.receive-off'), '')
    await waitFor(() => h.sockets[0].open === false)
    const posted = h.sent().length
    equal(await h.waterfall('approval/request', { agent: h.created[0], toolName: 'bash' }, () => new Promise(() => {})), 'unavailable', 'approval declined')
    let questionError
    try {
      await h.waterfall('user-questions/request', { agent: h.created[0], questions: [{ id: 'q1', question: 'Which one?', options: [{ label: 'x' }] }] }, () => new Promise(() => {}))
    } catch (error) {
      questionError = error
    }
    assert(/handing over to another host/.test(questionError?.message ?? ''), 'question rejected with the handover reason')
    equal(h.sent().length, posted, 'no prompt posted to Slack')
    await h.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await mock.close()
  }
})
