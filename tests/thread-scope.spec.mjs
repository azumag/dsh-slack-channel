// sessionScope: 'thread' — every Slack thread is its own DSH session. A
// top-level message opens one; replies in its thread continue it; queues,
// /stop, /new, unseen context and interactive prompts all stay inside the
// thread. Also: replies always post under the thread ROOT (Slack asks for the
// parent's ts, never a reply's), in both scopes.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, assert, equal, sleep, startMockSlack, waitFor, FakeSlackSocket } from './_util.mjs'
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

async function mount(mock, configOverrides = {}, { resumable = false } = {}) {
  const listeners = {}
  const effects = []
  const created = []
  const disposed = []
  const warnings = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: (text) => { warnings.push(text) }, error: () => {} }),
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
      async resume(options) {
        if (resumable === false) throw new Error('persistence not configured in test')
        const agent = new FakeAgent(options.resumeSessionId)
        agent.onEvent = (event) => {
          for (const fn of [...(listeners['session/event'] ?? [])]) fn(agent.session, event)
        }
        created.push(agent)
        return { agent, dispose: async () => { disposed.push(options.resumeSessionId) } }
      },
    },
  }
  const h = {
    created, disposed, warnings,
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

/**
 * Mock Slack that knows our identity and serves one thread's history from
 * conversations.replies (`thread`: the messages, or a handler result).
 */
async function mockWithThread(thread) {
  const mock = await startMockSlack()
  mock.setHandler((method) => {
    if (method === 'auth.test') return { reply: { ok: true, bot_id: 'B-SELF', user_id: 'U-BOT' } }
    if (method === 'conversations.replies') return Array.isArray(thread) ? { reply: { ok: true, messages: thread, has_more: false } } : thread
    return undefined
  })
  return mock
}

/** Mount, then wait until auth.test has answered (own posts need our ids). */
async function mountIdentified(mock, configOverrides) {
  const h = await mount(mock, configOverrides)
  await waitFor(() => mock.calls.some((c) => c.method === 'auth.test'))
  await sleep(50)
  return h
}

function repliesCalls(mock) {
  return mock.calls.filter((c) => c.method === 'conversations.replies')
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
    await waitFor(() => h.sent().some((s) => s.text.startsWith('Queued: this thread\'s turn is still running') && s.thread_ts === a.ts))
    h.push(message('independent B'))
    await waitFor(() => h.created.length === 2 && h.created[1].followups.length === 1)
    equal(h.created[0].followups.length, 1, 'A still has only its first turn')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('maxConcurrentTurns 1: a second thread waits for the running turn, then starts', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { maxConcurrentTurns: 1 })
    const a = message('task A')
    h.push(a)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    const b = message('task B')
    h.push(b)
    const ack = await waitFor(() => h.sent().find((s) => s.text.startsWith('Queued: another conversation') && s.thread_ts === b.ts))
    assert(ack.text.includes('(1 thread waiting in all)'), 'ack counts the waiting message: ' + ack.text)
    equal(h.created.length, 2, 'B has its session')
    equal(h.created[1].followups.length, 0, 'B has not started')
    h.created[0].complete('A done')
    await waitFor(() => h.created[1].followups.length === 1)
    equal(h.created[1].followups[0].content, [{ type: 'text', text: 'task B' }], 'B starts with its own message')
    equal(h.created[0].followups.length, 1, 'A ran once')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('maxConcurrentTurns 1: a freed slot goes to the oldest waiting message, across threads', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { maxConcurrentTurns: 1 })
    const a = message('task A')
    h.push(a)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.push(message('task B'))
    await waitFor(() => h.sent().some((s) => s.text.startsWith('Queued: another conversation')))
    h.push(message('more on A', { thread_ts: a.ts }))
    await waitFor(() => h.sent().some((s) => s.text.startsWith('Queued: this thread\'s turn is still running') && s.thread_ts === a.ts))
    h.created[0].complete('A done')
    await waitFor(() => h.created[1].followups.length === 1)
    equal(h.created[0].followups.length, 1, 'A\'s follow-up arrived after B, so it still waits')
    h.created[1].complete('B done')
    await waitFor(() => h.created[0].followups.length === 2)
    equal(h.created[0].followups[1].content, [{ type: 'text', text: 'more on A' }])
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('maxConcurrentTurns 1: !stop drops a waiting thread\'s messages, !new frees the slot', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { maxConcurrentTurns: 1 })
    const a = message('task A')
    h.push(a)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    const b = message('task B')
    h.push(b)
    await waitFor(() => h.sent().some((s) => s.text.startsWith('Queued: another conversation') && s.thread_ts === b.ts))
    h.push(message('!stop', { thread_ts: b.ts }))
    await waitFor(() => h.sent().some((s) => s.text === 'Cleared 1 waiting message.' && s.thread_ts === b.ts))
    equal(h.created[0].cancels.length, 0, 'A keeps running')
    const c = message('task C')
    h.push(c)
    await waitFor(() => h.created.length === 3 && h.sent().some((s) => s.text.startsWith('Queued: another conversation') && s.thread_ts === c.ts))
    h.push(message('!new', { thread_ts: a.ts }))
    await waitFor(() => h.created[2].followups.length === 1)
    equal(h.created[1].followups.length, 0, 'the dropped B never ran')
    equal(h.disposed, [h.created[0].id], 'A\'s busy session was replaced')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('maxConcurrentTurns 2: two threads run together, the third waits', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { maxConcurrentTurns: 2 })
    h.push(message('task A'))
    h.push(message('task B'))
    await waitFor(() => h.created.length === 2 && h.created.every((agent) => agent.followups.length === 1))
    h.push(message('task C'))
    await waitFor(() => h.created.length === 3 && h.sent().some((s) => s.text.startsWith('Queued: another conversation')))
    equal(h.created[2].followups.length, 0, 'C waits')
    h.created[1].complete('B done')
    await waitFor(() => h.created[2].followups.length === 1)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

/** The text of a fake agent's nth follow-up. */
function followupText(agent, index) {
  return agent.followups[index].content.map((block) => block.text).join('')
}

test('a busy thread: later messages join one waiting entry, acked once, answered in one turn', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const a = message('long task')
    h.push(a)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    const pings = [
      message('any progress?', { thread_ts: a.ts }),
      message('status please', { thread_ts: a.ts }),
      message('status please', { thread_ts: a.ts }),
    ]
    for (const ping of pings) h.push(ping)
    await waitFor(() => mock.calls.filter((c) => c.method === 'reactions.add').length === 4)
    await sleep(100)
    const acks = h.sent().filter((s) => s.text.startsWith('Queued'))
    equal(acks.length, 1, 'only the message that opened the entry is acknowledged in words')
    assert(acks[0].text.includes('no need to post again'), 'the ack tells others not to re-ask: ' + acks[0].text)
    h.created[0].complete('A done')
    await waitFor(() => h.created[0].followups.length === 2)
    const merged = followupText(h.created[0], 1)
    assert(merged.startsWith('[2 messages reached this thread while it waited'), 'one labelled block: ' + merged)
    assert(merged.includes('any progress?') && merged.includes('status please'), 'both messages carried')
    equal(merged.split('status please').length - 1, 1, 'the word-for-word repeat is carried once')
    h.created[0].complete('B done')
    await waitFor(() => h.sent().some((s) => s.text === 'B done'))
    await sleep(50)
    equal(h.created[0].followups.length, 2, 'three pings cost one turn')
    const unreacted = mock.calls.filter((c) => c.method === 'reactions.remove').map((c) => c.body.timestamp)
    for (const ping of pings) assert(unreacted.includes(ping.ts), 'receipt reaction cleared on ' + ping.ts)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('maxConcurrentTurns 1: pings to a waiting thread join its entry instead of queuing turns', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { maxConcurrentTurns: 1 })
    h.push(message('task A'))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    const b = message('task B')
    h.push(b)
    for (const text of ['B: progress?', 'B: still waiting', 'B: ping']) h.push(message(text, { thread_ts: b.ts }))
    await waitFor(() => mock.calls.filter((c) => c.method === 'reactions.add').length === 5)
    await sleep(100)
    const acks = h.sent().filter((s) => s.text.startsWith('Queued') && s.thread_ts === b.ts)
    equal(acks.length, 1, 'one ack for the waiting thread')
    assert(acks[0].text.includes('(1 thread waiting in all)'), 'counts threads: ' + acks[0].text)
    const c = message('task C')
    h.push(c)
    const ackC = await waitFor(() => h.sent().find((s) => s.text.startsWith('Queued') && s.thread_ts === c.ts))
    assert(ackC.text.includes('(2 threads waiting in all)'), 'four messages in B still count as one thread: ' + ackC.text)
    h.created[0].complete('A done')
    await waitFor(() => h.created[1].followups.length === 1)
    const merged = followupText(h.created[1], 0)
    assert(merged.startsWith('[4 messages reached this thread'), 'B answers all four at once: ' + merged)
    equal(h.created[2].followups.length, 0, 'C waits for B')
    h.created[1].complete('B done')
    await waitFor(() => h.created[2].followups.length === 1)
    equal(followupText(h.created[2], 0), 'task C', 'a lone message goes in as posted')
    equal(h.created[1].followups.length, 1, 'B ran once')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('a reload keeps the waiting entries and resumes the turn it stopped', async () => {
  const mock = await mockWithIdentity()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slack-pending-'))
  try {
    const stateFile = join(dir, 'state.json')
    const pendingFile = join(dir, 'state.pending.json')
    const first = await mount(mock, { maxConcurrentTurns: 1, stateFile })
    const a = message('task A')
    first.push(a)
    await waitFor(() => first.created.length === 1 && first.created[0].followups.length === 1)
    const b = message('task B')
    first.push(b)
    first.push(message('B: progress?', { thread_ts: b.ts }))
    await waitFor(() => mock.calls.filter((c) => c.method === 'reactions.add').length === 3)
    await sleep(50)
    await first.dispose()
    const saved = JSON.parse(readFileSync(pendingFile, 'utf8')).entries
    equal(saved.map((entry) => [entry.key, entry.interrupted === true, entry.parts.length]), [['C42:' + a.ts, true, 1], ['C42:' + b.ts, false, 2]], 'running turn first, then the waiting thread')

    const ackCount = h2 => h2.sent().filter((s) => s.text.startsWith('Queued')).length
    const queuedBefore = ackCount(first)
    const second = await mount(mock, { maxConcurrentTurns: 1, stateFile }, { resumable: true })
    await waitFor(() => second.created.length === 2 && second.created[0].followups.length === 1)
    equal(second.created.map((agent) => agent.id), [first.created[0].id, first.created[1].id], 'both threads resumed their own sessions')
    assert(followupText(second.created[0], 0).startsWith('[Channel note: the Slack channel restarted at'), 'A resumes with the restart note')
    equal(second.created[1].followups.length, 0, 'B still waits for the slot')
    assert(!existsSync(pendingFile) && existsSync(pendingFile + '.restored'), 'the file is consumed once')
    equal(ackCount(second), queuedBefore, 'A started at once, so no restart notice was needed')
    second.created[0].complete('A finished after the restart')
    await waitFor(() => second.created[1].followups.length === 1)
    assert(followupText(second.created[1], 0).startsWith('[2 messages reached this thread'), 'B kept both messages')
    second.created[1].complete('B done')
    await waitFor(() => second.sent().some((s) => s.text === 'B done'))
    await second.dispose()
    assert(!existsSync(pendingFile), 'nothing waiting at the second teardown: nothing saved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

test('thread backfill: the first turn in an existing thread carries the thread so far', async () => {
  // The thread predates its session (started before sessionScope 'thread',
  // or before a restart): none of these messages reached the plugin.
  const root = message('can you look at the flaky deploy test?', { user: 'U7' })
  const own = message('It times out\n  waiting for the health check', { user: 'U-BOT', bot_id: 'B-SELF', thread_ts: root.ts })
  const join = message('has joined the channel', { subtype: 'channel_join', user: 'U9', thread_ts: root.ts })
  const otherApp = message('the timeout is 30s', { subtype: 'bot_message', bot_id: 'B-OTHER', user: undefined, thread_ts: root.ts })
  const trigger = message('so what should we change?', { thread_ts: root.ts })
  const later = message('posted after the trigger', { user: 'U8', thread_ts: root.ts })
  const mock = await mockWithThread([root, own, join, otherApp, trigger, later])
  try {
    const h = await mountIdentified(mock)
    h.push(trigger)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    equal(h.created[0].followups[0].content[0].text, [
      '[Thread context — prior messages in this thread (not yet in conversation history):]',
      '[thread parent] <@U7>: can you look at the flaky deploy test?',
      '[assistant] It times out ⏎ waiting for the health check',
      'app:B-OTHER: the timeout is 30s',
      '[End of thread context]',
      '',
      'so what should we change?',
    ].join('\n'))
    const [call] = repliesCalls(mock)
    equal([call.body.channel, call.body.ts, call.body.latest], ['C42', root.ts, trigger.ts], 'fetched the thread up to the trigger')
    h.created[0].complete('raise it to 60s')
    equal((await waitFor(() => h.sent().find((s) => s.text === 'raise it to 60s'))).thread_ts, root.ts)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread backfill: a later turn of the same live session does not carry the thread again', async () => {
  const root = message('old topic', { user: 'U7' })
  const first = message('first question', { thread_ts: root.ts })
  const mock = await mockWithThread([root, first])
  try {
    const h = await mountIdentified(mock)
    h.push(first)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    assert(h.created[0].followups[0].content[0].text.includes('[thread parent] <@U7>: old topic'), 'first turn carries the thread')
    h.created[0].complete('answer one')
    await waitFor(() => h.sent().some((s) => s.text === 'answer one'))
    h.push(message('second question', { thread_ts: root.ts }))
    await waitFor(() => h.created[0].followups.length === 2)
    equal(h.created[0].followups[1].content[0].text, 'second question', 'second turn is the bare message')
    equal(repliesCalls(mock).length, 1, 'the thread was fetched once')
    equal(h.created.length, 1)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread backfill: a top-level message gets no thread block, nor do replies in the thread it opens', async () => {
  const mock = await mockWithThread([])
  try {
    const h = await mountIdentified(mock)
    const top = message('a brand-new topic')
    h.push(top)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    equal(h.created[0].followups[0].content[0].text, 'a brand-new topic')
    h.created[0].complete('noted')
    await waitFor(() => h.sent().some((s) => s.text === 'noted'))
    h.push(message('a reply in that thread', { thread_ts: top.ts }))
    await waitFor(() => h.created[0].followups.length === 2)
    equal(h.created[0].followups[1].content[0].text, 'a reply in that thread')
    equal(repliesCalls(mock).length, 0, 'conversations.replies never called')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread backfill: a failed conversations.replies is logged and the turn goes on without it', async () => {
  const mock = await mockWithThread({ reply: { ok: false, error: 'missing_scope' } })
  try {
    const h = await mountIdentified(mock)
    const root = message('old topic', { user: 'U7' })
    h.push(message('still there?', { thread_ts: root.ts }))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    equal(h.created[0].followups[0].content[0].text, 'still there?', 'the bare message is submitted')
    assert(h.warnings.some((w) => w.includes('thread history') && w.includes('missing_scope')), 'warning logged: ' + JSON.stringify(h.warnings))
    h.created[0].complete('yes')
    equal((await waitFor(() => h.sent().find((s) => s.text === 'yes'))).thread_ts, root.ts, 'reply still delivered')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread backfill + mentionOnly: a message in the unseen block is not repeated in the thread block', async () => {
  const root = message('<@U-BOT> old topic', { user: 'U7' })
  const chatter = message('chatter nobody addressed', { thread_ts: root.ts, user: 'U2' })
  const trigger = message('<@U-BOT> thoughts?', { thread_ts: root.ts })
  const mock = await mockWithThread([root, chatter, trigger])
  try {
    const h = await mountIdentified(mock, { mentionOnly: true })
    h.push(chatter)
    h.push(trigger)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    const prompt = h.created[0].followups[0].content[0].text
    equal(prompt, [
      '[Thread context — prior messages in this thread (not yet in conversation history):]',
      '[thread parent] <@U7>: <@U-BOT> old topic',
      '[End of thread context]',
      '',
      '[channel context — 1 message(s) posted since your last reply, oldest first]',
      '<@U2>: chatter nobody addressed',
      '[end of channel context]',
      '',
      '<@U-BOT> thoughts?',
    ].join('\n'))
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread backfill: threadContextMessages caps the block and keeps the parent on top', async () => {
  const root = message('the topic', { user: 'U7' })
  const one = message('one', { user: 'U2', thread_ts: root.ts })
  const two = message('two', { user: 'U3', thread_ts: root.ts })
  const three = message('three', { user: 'U4', thread_ts: root.ts })
  const trigger = message('and now?', { thread_ts: root.ts })
  const mock = await mockWithThread([root, one, two, three, trigger])
  try {
    const h = await mountIdentified(mock, { threadContextMessages: 2 })
    h.push(trigger)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    equal(h.created[0].followups[0].content[0].text, [
      '[Thread context — prior messages in this thread (not yet in conversation history):]',
      '[thread parent] <@U7>: the topic',
      '<@U4>: three',
      '[End of thread context]',
      '',
      'and now?',
    ].join('\n'))
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('thread backfill: !new in a thread re-reads it; threadContextMessages 0 never fetches', async () => {
  const root = message('the topic', { user: 'U7' })
  const mock = await mockWithThread([root])
  try {
    const h = await mountIdentified(mock)
    h.push(root)
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    h.created[0].complete('done')
    await waitFor(() => h.sent().some((s) => s.text === 'done'))
    h.push(message('!new', { thread_ts: root.ts }))
    await waitFor(() => h.sent().some((s) => s.text === 'Started a fresh session for this thread.'))
    h.push(message('again', { thread_ts: root.ts }))
    await waitFor(() => h.created.length === 2 && h.created[1].followups.length === 1)
    assert(h.created[1].followups[0].content[0].text.startsWith('[Thread context'), 'the fresh session reads the thread')
    await h.dispose()
  } finally {
    await mock.close()
  }

  const off = await mockWithThread([root])
  try {
    const h = await mountIdentified(off, { threadContextMessages: 0 })
    h.push(message('no history please', { thread_ts: root.ts }))
    await waitFor(() => h.created.length === 1 && h.created[0].followups.length === 1)
    equal(h.created[0].followups[0].content[0].text, 'no history please')
    equal(repliesCalls(off).length, 0, 'disabled backfill makes no call')
    await h.dispose()
  } finally {
    await off.close()
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

test('maxConcurrentTurns is validated', () => {
  const validate = (extra) => Config['~standard'].validate({ botToken: 'xoxb-x', appToken: 'xapp-x', ...extra })
  equal(validate({}).value.maxConcurrentTurns, 0, 'default: no limit')
  equal(validate({ maxConcurrentTurns: 1 }).value.maxConcurrentTurns, 1)
  for (const bad of [-1, 1.5, '1']) {
    assert(validate({ maxConcurrentTurns: bad }).issues?.some((issue) => issue.message.includes('maxConcurrentTurns')), 'rejected: ' + JSON.stringify(bad))
  }
})

test('threadContextMessages is validated', () => {
  const validate = (extra) => Config['~standard'].validate({ botToken: 'xoxb-x', appToken: 'xapp-x', ...extra })
  equal(validate({}).value.threadContextMessages, 30, 'default 30')
  equal(validate({ threadContextMessages: 0 }).value.threadContextMessages, 0, '0 disables')
  equal(validate({ threadContextMessages: 200 }).value.threadContextMessages, 200, 'the cap itself is accepted')
  for (const bad of [201, -1, 1.5, 'ten']) {
    assert(validate({ threadContextMessages: bad }).issues?.some((issue) => issue.message.includes('threadContextMessages')), 'rejected: ' + JSON.stringify(bad))
  }
})
